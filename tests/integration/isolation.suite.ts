import test from "node:test";
import assert from "node:assert/strict";
import { before } from "node:test";
import { actor, cleanDatabase, createWorkspaceWithOwner, createUser, db, uniqueId } from "./helpers.ts";
import { loadActor } from "../../server/auth/actor.ts";
import { ApiError } from "../../server/api/errors.ts";
import { createProject, getProject, listProjects, updateProject } from "../../server/services/project-service.ts";
import { cancelCrawl, getCrawl } from "../../server/services/crawl-service.ts";
import { createRun } from "../../server/repositories/crawls.ts";
import { listMembers } from "../../server/services/member-service.ts";
import { listForWorkspace as listAuditLogs } from "../../server/repositories/audit.ts";
import { withIdempotency } from "../../server/repositories/idempotency.ts";

before(async () => {
  await cleanDatabase(db());
});

test("an outsider cannot obtain an actor context for another workspace", async () => {
  const client = db();
  const alice = await createUser(client);
  const bob = await createUser(client);
  const wsAlice = await createWorkspaceWithOwner(client, alice, "Alpha");
  const wsBob = await createWorkspaceWithOwner(client, bob, "Beta");

  const aliceActor = await loadActor(client, alice.id, wsAlice);
  assert.equal(aliceActor.role, "OWNER");

  await assert.rejects(loadActor(client, bob.id, wsAlice), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    return true;
  });

  // Alice's context works only for her own workspace.
  await assert.rejects(loadActor(client, alice.id, wsBob), ApiError);
});

test("project reads and lists stay workspace-scoped", async () => {
  const client = db();
  const alice = await createUser(client);
  const bob = await createUser(client);
  const wsAlice = await createWorkspaceWithOwner(client, alice, "Alpha");
  const wsBob = await createWorkspaceWithOwner(client, bob, "Beta");

  const hostname = `site-${uniqueId()}.example.com`;
  const project = await createProject(client, actor(alice.id, wsAlice, "OWNER"), { hostname });

  const detail = await getProject(client, actor(alice.id, wsAlice, "OWNER"), project.id);
  assert.equal(detail.hostname, hostname);

  // Even a fabricated OWNER actor from another workspace sees nothing.
  await assert.rejects(getProject(client, actor(bob.id, wsBob, "OWNER"), project.id), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    return true;
  });
  const bobProjects = await listProjects(client, actor(bob.id, wsBob, "OWNER"), { take: 50 });
  assert.equal(bobProjects.items.length, 0);

  const bobMembers = await listMembers(client, actor(bob.id, wsBob, "OWNER"), { take: 50 });
  assert.equal(bobMembers.items.length, 1); // only Bob himself

  const bobAudit = await listAuditLogs(client, wsBob, { take: 50 });
  // Only Bob's own workspace-created entry; nothing from Alice's workspace leaks.
  assert.equal(bobAudit.items.length, 1);
  assert.ok(bobAudit.items.every((entry) => entry.workspaceId === wsBob));
});

test("crawl reads and cancels stay workspace-scoped", async () => {
  const client = db();
  const alice = await createUser(client);
  const bob = await createUser(client);
  const wsAlice = await createWorkspaceWithOwner(client, alice, "Alpha");
  const wsBob = await createWorkspaceWithOwner(client, bob, "Beta");

  const hostname = `crawl-site-${uniqueId()}.example.com`;
  const project = await createProject(client, actor(alice.id, wsAlice, "OWNER"), { hostname });
  const policyId = project.currentPolicyId;
  assert.ok(policyId);
  const run = await createRun(client, {
    projectId: project.id,
    policyId,
    trigger: "MANUAL",
    baseRunId: null,
    pagesKnown: 0,
  });

  const detail = await getCrawl(client, actor(alice.id, wsAlice, "OWNER"), project.id, run.id);
  assert.equal(detail.id, run.id);

  // Even a fabricated OWNER actor from another workspace gets 404 on read and cancel.
  await assert.rejects(getCrawl(client, actor(bob.id, wsBob, "OWNER"), project.id, run.id), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    return true;
  });
  await assert.rejects(cancelCrawl(client, actor(bob.id, wsBob, "OWNER"), project.id, run.id), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    return true;
  });

  // The rejected attempts did not mutate the run.
  const untouched = await client.crawlRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(untouched.status, "QUEUED");
  assert.equal(untouched.cancelRequestedAt, null);

  // The legitimate workspace can still cancel it.
  const cancelled = await cancelCrawl(client, actor(alice.id, wsAlice, "OWNER"), project.id, run.id);
  assert.equal(cancelled.status, "CANCELLED");
});

test("idempotency replays identical requests and rejects hash mismatches", async () => {
  const client = db();
  const alice = await createUser(client);
  const ws = await createWorkspaceWithOwner(client, alice);
  const base = { actorId: alice.id, workspaceId: ws, route: "POST /crawls", key: `idem-${uniqueId()}`, ttlMs: 60_000 };
  let executions = 0;
  const run = async () => {
    executions += 1;
    return "crawl_1";
  };

  const first = await withIdempotency(client, { ...base, requestHash: "hash-a" }, run);
  assert.equal(first.replay, false);
  const second = await withIdempotency(client, { ...base, requestHash: "hash-a" }, run);
  assert.equal(second.replay, true);
  assert.equal(second.resourceId, "crawl_1");
  assert.equal(executions, 1);

  await assert.rejects(withIdempotency(client, { ...base, requestHash: "hash-b" }, run), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    return true;
  });
});

test("concurrent idempotent requests execute once and expired keys can be reused", async () => {
  const client = db();
  const alice = await createUser(client);
  const workspaceId = await createWorkspaceWithOwner(client, alice);
  const input = {
    actorId: alice.id,
    workspaceId,
    route: "POST /example",
    key: uniqueId(),
    requestHash: "a",
    ttlMs: 60_000,
  };
  let executions = 0;
  const run = async () => `resource-${++executions}`;
  const results = await Promise.all([withIdempotency(client, input, run), withIdempotency(client, input, run)]);
  assert.equal(executions, 1);
  assert.equal(results[0].resourceId, results[1].resourceId);
  assert.equal(results.filter((result) => result.replay).length, 1);
  await client.idempotencyRecord.updateMany({ where: { workspaceId }, data: { expiresAt: new Date(0) } });
  const reused = await withIdempotency(client, { ...input, requestHash: "b" }, run);
  assert.equal(reused.replay, false);
  assert.equal(executions, 2);
});

test("failure to record idempotency rolls back the business mutation", async () => {
  const client = db();
  const alice = await createUser(client);
  const workspaceId = await createWorkspaceWithOwner(client, alice, "Before");
  await assert.rejects(
    withIdempotency(
      client,
      {
        actorId: alice.id,
        workspaceId,
        route: "POST /example",
        key: uniqueId(),
        requestHash: "a",
        ttlMs: NaN,
      },
      async (tx) => {
        await tx.workspace.update({ where: { id: workspaceId }, data: { name: "After" } });
        return workspaceId;
      },
    ),
  );
  assert.equal((await client.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).name, "Before");
  assert.equal(await client.idempotencyRecord.count({ where: { workspaceId } }), 0);
});

test("project patches apply name and archive together and reject archiving an active crawl", async () => {
  const client = db();
  const owner = await createUser(client);
  const workspaceId = await createWorkspaceWithOwner(client, owner);
  const ownerActor = actor(owner.id, workspaceId, "OWNER");
  const project = await createProject(client, ownerActor, { hostname: `patch-${uniqueId()}.example.com` });
  const archived = await updateProject(client, ownerActor, project.id, { archived: true, displayName: "Renamed" });
  assert.ok(archived.archivedAt);
  assert.equal(archived.displayName, "Renamed");
  await updateProject(client, ownerActor, project.id, { archived: false });
  assert.ok(project.currentPolicyId);
  await createRun(client, {
    projectId: project.id,
    policyId: project.currentPolicyId,
    trigger: "MANUAL",
    baseRunId: null,
    pagesKnown: 0,
  });
  await assert.rejects(
    updateProject(client, ownerActor, project.id, { archived: true, displayName: "Lost" }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "CRAWL_ALREADY_ACTIVE");
      return true;
    },
  );
  const current = await getProject(client, ownerActor, project.id);
  assert.equal(current.archivedAt, null);
  assert.equal(current.displayName, "Renamed");
});
