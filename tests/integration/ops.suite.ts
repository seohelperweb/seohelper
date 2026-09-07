import test from "node:test";
import assert from "node:assert/strict";
import { before } from "node:test";
import { actor, cleanDatabase, createWorkspaceWithOwner, createUser, db, uniqueId } from "./helpers.ts";
import { ApiError } from "../../server/api/errors.ts";
import { createProject, requestVerification } from "../../server/services/project-service.ts";
import { processVerificationJob } from "../../server/services/verification-runner.ts";
import { claimBatch, VERIFICATION_REQUESTED } from "../../server/repositories/outbox.ts";
import { createCrawl } from "../../server/services/crawl-service.ts";
import { getSchedule, processDueSchedules, updateSchedule } from "../../server/schedule/schedule-service.ts";
import { cleanupRunDetails } from "../../server/maintenance/cleanup.ts";

before(async () => {
  await cleanDatabase(db());
});

interface Setup {
  workspaceId: string;
  owner: { id: string; email: string; emailVerified: boolean };
  projectId: string;
  hostname: string;
}

async function setupVerifiedProject(): Promise<Setup> {
  const client = db();
  const owner = await createUser(client);
  const workspaceId = await createWorkspaceWithOwner(client, owner, "Ops WS");
  const hostname = `ops-${uniqueId()}.test`;
  const project = await createProject(client, actor(owner.id, workspaceId, "OWNER"), { hostname });
  const request = await requestVerification(client, actor(owner.id, workspaceId, "OWNER"), project.id);
  const events = await claimBatch(client, { type: VERIFICATION_REQUESTED, limit: 5, leaseMs: 30_000 });
  assert.equal(events.length, 1);
  await processVerificationJob(client, events[0], async () => [[request.recordValue]]);
  return { workspaceId, owner, projectId: project.id, hostname };
}

test("manual crawl quota: 5-minute spacing and daily cap return 429", async () => {
  const client = db();
  const setup = await setupVerifiedProject();
  const ownerActor = actor(setup.owner.id, setup.workspaceId, "OWNER");

  await createCrawl(client, ownerActor, setup.projectId, "quota-1");
  await client.crawlRun.updateMany({
    where: { projectId: setup.projectId },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });

  await assert.rejects(createCrawl(client, ownerActor, setup.projectId, "quota-2"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 429);
    assert.ok((error.details as { nextAllowedAt: string }).nextAllowedAt);
    return true;
  });

  // Age the last manual run past the spacing window, then exhaust the daily cap (10).
  const past = new Date(Date.now() - 6 * 60 * 1000);
  await client.crawlRun.updateMany({
    where: { projectId: setup.projectId },
    data: { createdAt: past, trigger: "MANUAL" },
  });
  for (let i = 2; i <= 10; i += 1) {
    const created = await createCrawl(client, ownerActor, setup.projectId, `quota-${i}`);
    await client.crawlRun.update({
      where: { id: created.crawlId },
      data: { status: "CANCELLED", finishedAt: new Date(), createdAt: past },
    });
  }
  await assert.rejects(createCrawl(client, ownerActor, setup.projectId, "quota-11"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 429);
    return true;
  });
  // Idempotent replay of an already-recorded key bypasses the quota.
  const replay = await createCrawl(client, ownerActor, setup.projectId, "quota-9");
  assert.equal(replay.replay, true);
});

test("weekly schedule triggers once per slot, respects busy/unverified, and skips missed slots", async () => {
  const client = db();
  const setup = await setupVerifiedProject();
  const ownerActor = actor(setup.owner.id, setup.workspaceId, "OWNER");

  const updated = await updateSchedule(client, ownerActor, setup.projectId, { enabled: true });
  assert.equal(updated.enabled, true);
  assert.ok(updated.nextRunAt && updated.nextRunAt.getTime() > Date.now());
  const stored = await getSchedule(client, ownerActor, setup.projectId);
  assert.equal(stored.enabled, true);

  // Slot not due yet → nothing happens.
  const idle = await processDueSchedules(client);
  assert.equal(idle.triggered, 0);

  // Make the slot due two intervals ago: the two elapsed slots (T-2w, T-1w)
  // are recorded as missed and only the most recent due slot triggers.
  await client.crawlSchedule.update({
    where: { projectId: setup.projectId },
    data: { nextRunAt: new Date(Date.now() - 2 * 7 * 24 * 60 * 60 * 1000) },
  });
  const scan = await processDueSchedules(client);
  assert.equal(scan.missedSlots, 2);
  assert.equal(scan.triggered, 1);

  const occurrences = await client.scheduleOccurrence.findMany({
    where: { projectId: setup.projectId },
    orderBy: { scheduledFor: "asc" },
  });
  assert.deepEqual(
    occurrences.map((o) => o.status),
    ["SKIPPED_MISSED", "SKIPPED_MISSED", "TRIGGERED"],
  );
  const triggered = occurrences.find((o) => o.status === "TRIGGERED")!;
  const run = await client.crawlRun.findUniqueOrThrow({ where: { id: triggered.runId! } });
  assert.equal(run.trigger, "SCHEDULED");

  // Re-running the scanner is a no-op: nextRunAt was advanced past now, and
  // the unique (projectId, scheduledFor) slot guards replays.
  const again = await processDueSchedules(client);
  assert.equal(again.triggered, 0);
  assert.equal(await client.crawlRun.count({ where: { projectId: setup.projectId } }), 1);

  // Busy slot: force the schedule due while a run is active.
  await client.crawlRun.update({
    where: { id: run.id },
    data: { status: "RUNNING", leaseExpiresAt: new Date(Date.now() + 60_000) },
  });
  await client.crawlSchedule.update({
    where: { projectId: setup.projectId },
    data: { nextRunAt: new Date(Date.now() - 1000) },
  });
  const busy = await processDueSchedules(client);
  assert.equal(busy.skippedBusy, 1);
  await client.crawlRun.update({
    where: { id: run.id },
    data: { status: "CANCELLED", finishedAt: new Date(), leaseExpiresAt: null },
  });

  // Unverified project: schedule fires but records SKIPPED_UNVERIFIED.
  const unverifiedSetup = await setupVerifiedProject();
  const unverifiedProject = await createProject(
    client,
    actor(unverifiedSetup.owner.id, unverifiedSetup.workspaceId, "OWNER"),
    { hostname: `unv-${uniqueId()}.test` },
  );
  await updateSchedule(
    client,
    actor(unverifiedSetup.owner.id, unverifiedSetup.workspaceId, "OWNER"),
    unverifiedProject.id,
    { enabled: true },
  );
  await client.crawlSchedule.update({
    where: { projectId: unverifiedProject.id },
    data: { nextRunAt: new Date(Date.now() - 1000) },
  });
  const unverified = await processDueSchedules(client);
  assert.equal(unverified.skippedUnverified, 1);
  assert.equal(
    await client.crawlRun.count({ where: { projectId: unverifiedProject.id } }),
    0,
    "unverified projects never start runs",
  );
});

test("retention cleanup prunes old run details but protects the baseline", async () => {
  const client = db();
  const setup = await setupVerifiedProject();

  // Fabricate three completed runs with details; run1 is the published baseline.
  const runIds: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const run = await client.crawlRun.create({
      data: {
        projectId: setup.projectId,
        policyId: (await client.project.findUniqueOrThrow({ where: { id: setup.projectId } })).currentPolicyId!,
        status: "COMPLETED",
        completeness: "FULL",
        finishedAt: new Date(Date.now() - (60 - i) * 24 * 60 * 60 * 1000),
        publishedAt: i === 2 ? new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) : null,
      },
    });
    const page = await client.page.create({
      data: {
        projectId: setup.projectId,
        identityVersion: 1,
        urlKey: `k-${run.id}`,
        identityUrl: `https://${setup.hostname}/${run.id}`,
      },
    });
    await client.pageObservation.create({
      data: {
        runId: run.id,
        pageId: page.id,
        fetchOutcome: "HTTP_RESPONSE",
        requestUrl: `https://${setup.hostname}/${run.id}`,
      },
    });
    await client.crawlFrontier.create({
      data: { runId: run.id, urlKey: `k-${run.id}`, requestUrl: `https://${setup.hostname}/${run.id}` },
    });
    runIds.push(run.id);
  }
  const baselineId = runIds[2]; // newest, published
  await client.project.update({ where: { id: setup.projectId }, data: { latestPublishedRunId: baselineId } });

  const result = await cleanupRunDetails(client, new Date(), { retentionDays: 30, maxRunsPerProject: 20 });
  assert.equal(result.runsPruned, 2);
  assert.equal(result.observationsDeleted, 2);
  assert.equal(result.frontierDeleted, 2);

  // Baseline keeps its details; old runs keep metadata but lose details.
  assert.equal(await client.pageObservation.count({ where: { runId: baselineId } }), 1);
  for (const oldId of [runIds[0], runIds[1]]) {
    const oldRun = await client.crawlRun.findUniqueOrThrow({ where: { id: oldId } });
    assert.ok(oldRun.detailsExpiredAt);
    assert.equal(await client.pageObservation.count({ where: { runId: oldId } }), 0);
  }
  // Run metadata itself is retained for history.
  assert.equal(await client.crawlRun.count({ where: { projectId: setup.projectId } }), 3);

  // Over-count pruning: shrink the budget and confirm this project's baseline
  // still keeps its details even when over budget.
  await cleanupRunDetails(client, new Date(), { retentionDays: 90, maxRunsPerProject: 1 });
  assert.equal(
    await client.pageObservation.count({ where: { runId: { in: runIds } } }),
    1,
    "only the baseline keeps details",
  );
  assert.equal(await client.crawlRun.count({ where: { projectId: setup.projectId } }), 3, "run metadata is retained");
});

export {};
