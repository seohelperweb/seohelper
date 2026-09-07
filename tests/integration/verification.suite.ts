import test from "node:test";
import assert from "node:assert/strict";
import { before } from "node:test";
import { actor, cleanDatabase, createWorkspaceWithOwner, createUser, db, uniqueId } from "./helpers.ts";
import { outbox as outboxQueries } from "./queries.ts";
import { ApiError } from "../../server/api/errors.ts";
import { createProject, requestVerification } from "../../server/services/project-service.ts";
import { processVerificationJob, VERIFICATION_MAX_ATTEMPTS } from "../../server/services/verification-runner.ts";
import { claimBatch, emit, VERIFICATION_REQUESTED } from "../../server/repositories/outbox.ts";
import { verificationRecordName } from "../../server/verification/challenge.ts";

before(async () => {
  await cleanDatabase(db());
});

interface Fixture {
  projectId: string;
  hostname: string;
}

async function setupProject(): Promise<{
  client: ReturnType<typeof db>;
  workspaceId: string;
  owner: { id: string };
  fixture: Fixture;
}> {
  const client = db();
  const owner = await createUser(client);
  const workspaceId = await createWorkspaceWithOwner(client, owner);
  const hostname = `site-${uniqueId()}.example.com`;
  const project = await createProject(client, actor(owner.id, workspaceId, "OWNER"), { hostname });
  return { client, workspaceId, owner, fixture: { projectId: project.id, hostname } };
}

async function claimOne(client: ReturnType<typeof db>) {
  const events = await claimBatch(client, { type: VERIFICATION_REQUESTED, limit: 5, leaseMs: 30_000 });
  assert.equal(events.length, 1, "expected exactly one claimable event");
  return events[0];
}

test("successful TXT match verifies the project for 30 days", async () => {
  const { client, workspaceId, owner, fixture } = await setupProject();
  const request = await requestVerification(client, actor(owner.id, workspaceId, "OWNER"), fixture.projectId);
  assert.equal(request.status, "PENDING");
  assert.equal(request.recordName, verificationRecordName(fixture.hostname));

  const event = await claimOne(client);
  const now = new Date("2026-09-06T12:00:00Z");
  const outcome = await processVerificationJob(
    client,
    event,
    async (name) => {
      assert.equal(name, request.recordName);
      return [[request.recordValue]];
    },
    now,
  );
  assert.equal(outcome, "delivered");

  const verification = await client.domainVerification.findFirstOrThrow({ where: { projectId: fixture.projectId } });
  assert.equal(verification.status, "SUCCEEDED");
  assert.deepEqual(verification.verifiedAt, now);
  assert.deepEqual(verification.expiresAt, new Date("2026-10-06T12:00:00Z"));

  const project = await client.project.findUniqueOrThrow({ where: { id: fixture.projectId } });
  assert.equal(project.verificationStatus, "ACTIVE");

  const delivered = await client.outboxEvent.findFirstOrThrow({ where: { id: event.id } });
  assert.ok(delivered.deliveredAt);
});

test("mismatched TXT retries with backoff and fails after max attempts", async () => {
  const { client, workspaceId, owner, fixture } = await setupProject();
  await requestVerification(client, actor(owner.id, workspaceId, "OWNER"), fixture.projectId);

  let event = await claimOne(client);
  let outcome = await processVerificationJob(client, event, async () => []);
  assert.equal(outcome, "rescheduled");
  let row = await client.domainVerification.findFirstOrThrow({ where: { projectId: fixture.projectId } });
  assert.equal(row.status, "PENDING");
  assert.match(row.lastError ?? "", /not found/);

  for (let round = 2; round <= VERIFICATION_MAX_ATTEMPTS; round += 1) {
    await outboxQueries.resetAvailability(client, event.id);
    event = await claimOne(client);
    assert.equal(event.attempts, round);
    outcome = await processVerificationJob(client, event, async () => [["indexly-verification=wrong"]]);
    assert.equal(outcome, round === VERIFICATION_MAX_ATTEMPTS ? "delivered" : "rescheduled");
  }

  row = await client.domainVerification.findFirstOrThrow({ where: { projectId: fixture.projectId } });
  assert.equal(row.status, "FAILED");
  const project = await client.project.findUniqueOrThrow({ where: { id: fixture.projectId } });
  assert.equal(project.verificationStatus, "PENDING_VERIFICATION");
});

test("only one active verification per project; rotated challenges fence stale jobs", async () => {
  const { client, workspaceId, owner, fixture } = await setupProject();

  // Exhaust the first challenge to FAILED (three processing rounds, like a real worker).
  await requestVerification(client, actor(owner.id, workspaceId, "OWNER"), fixture.projectId);
  await assert.rejects(
    requestVerification(client, actor(owner.id, workspaceId, "OWNER"), fixture.projectId),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      return true;
    },
  );
  const noMatch = async () => [];
  let event = await claimOne(client);
  await processVerificationJob(client, event, noMatch); // attempts 1 → rescheduled
  await outboxQueries.resetAvailability(client, event.id);
  event = await claimOne(client);
  await processVerificationJob(client, event, noMatch); // attempts 2 → rescheduled
  await outboxQueries.resetAvailability(client, event.id);
  event = await claimOne(client);
  await processVerificationJob(client, event, noMatch); // attempts 3 → FAILED + delivered
  const row1 = await client.domainVerification.findFirstOrThrow({ where: { projectId: fixture.projectId } });
  assert.equal(row1.status, "FAILED");

  // Rotate: a new challenge (version 2) with its own outbox event.
  const second = await requestVerification(client, actor(owner.id, workspaceId, "OWNER"), fixture.projectId);
  const row2 = await client.domainVerification.findFirstOrThrow({
    where: { projectId: fixture.projectId },
    orderBy: { challengeVersion: "desc" },
  });
  assert.equal(row2.challengeVersion, 2);
  assert.notEqual(row2.challengeValue, row1.challengeValue);

  // A stale event referencing challengeVersion 1 must be discarded without side effects
  // (here: the v1 row is terminal FAILED, so the fence delivers without consulting DNS).
  const staleEventId = await emit(client, {
    type: VERIFICATION_REQUESTED,
    aggregateId: row1.id,
    payload: { workspaceId, verificationId: row1.id, challengeVersion: 1 },
  });
  await outboxQueries.resetAvailability(client, staleEventId);
  const claimed = await claimBatch(client, { type: VERIFICATION_REQUESTED, limit: 5, leaseMs: 30_000 });
  const stale = claimed.find((c) => c.id === staleEventId);
  assert.ok(stale, "stale event must be claimable");
  const staleOutcome = await processVerificationJob(client, stale, async () => []);
  assert.equal(staleOutcome, "delivered");
  const rowAfterStale = await client.domainVerification.findFirstOrThrow({
    where: { projectId: fixture.projectId },
    orderBy: { challengeVersion: "desc" },
  });
  assert.equal(rowAfterStale.status, "PENDING");

  // The real v2 event verifies fine.
  const live = claimed.find((c) => c.id !== staleEventId);
  assert.ok(live);
  const outcome = await processVerificationJob(client, live, async () => [[second.recordValue]]);
  assert.equal(outcome, "delivered");
  const final = await client.domainVerification.findFirstOrThrow({
    where: { projectId: fixture.projectId },
    orderBy: { challengeVersion: "desc" },
  });
  assert.equal(final.status, "SUCCEEDED");
});

export {};
