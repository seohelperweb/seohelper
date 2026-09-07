import test from "node:test";
import assert from "node:assert/strict";
import { before } from "node:test";
import { actor, cleanDatabase, createWorkspaceWithOwner, createUser, db, uniqueId } from "./helpers.ts";
import { loadActor } from "../../server/auth/actor.ts";
import { ApiError } from "../../server/api/errors.ts";
import { createProject, getProject, listProjects } from "../../server/services/project-service.ts";
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
