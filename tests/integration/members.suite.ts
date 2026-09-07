import test from "node:test";
import assert from "node:assert/strict";
import { before } from "node:test";
import { actor, cleanDatabase, createWorkspaceWithOwner, createUser, db, uniqueId } from "./helpers.ts";
import { ApiError } from "../../server/api/errors.ts";
import { memberships } from "./queries.ts";
import { changeMemberRole, inviteMember, listMembers, removeMember } from "../../server/services/member-service.ts";
import type { WorkspaceRole } from "@seo/db";

before(async () => {
  await cleanDatabase(db());
});

async function setupTeam() {
  const client = db();
  const owner = await createUser(client, { name: "Owner" });
  const admin = await createUser(client, { name: "Admin" });
  const member = await createUser(client, { name: "Member" });
  const viewer = await createUser(client, { name: "Viewer" });
  const workspaceId = await createWorkspaceWithOwner(client, owner, "Team");
  for (const [user, role] of [
    [admin, "ADMIN"],
    [member, "MEMBER"],
    [viewer, "VIEWER"],
  ] as Array<[typeof admin, WorkspaceRole]>) {
    await client.membership.create({ data: { workspaceId, userId: user.id, role } });
  }
  return { client, workspaceId, owner, admin, member, viewer };
}

function expectForbidden(promise: Promise<unknown>): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 403);
    return true;
  });
}

test("the last owner cannot be demoted or removed", async () => {
  const { client, workspaceId, owner, admin } = await setupTeam();
  const ownerId = await memberships.findId(client, workspaceId, owner.id);

  await expectForbidden(changeMemberRole(client, actor(owner.id, workspaceId, "OWNER"), ownerId, "ADMIN"));
  await expectForbidden(removeMember(client, actor(owner.id, workspaceId, "OWNER"), ownerId));

  // Promote a second owner, then demoting the first is allowed.
  const adminId = await memberships.findId(client, workspaceId, admin.id);
  await changeMemberRole(client, actor(owner.id, workspaceId, "OWNER"), adminId, "OWNER");
  await changeMemberRole(client, actor(owner.id, workspaceId, "OWNER"), ownerId, "ADMIN");
  const ownerRow = await client.membership.findUnique({ where: { id: ownerId } });
  assert.equal(ownerRow?.role, "ADMIN");
});

test("admins cannot touch owner rows or grant owner", async () => {
  const { client, workspaceId, owner, admin } = await setupTeam();
  const ownerId = await memberships.findId(client, workspaceId, owner.id);
  const adminId = await memberships.findId(client, workspaceId, admin.id);

  await expectForbidden(changeMemberRole(client, actor(admin.id, workspaceId, "ADMIN"), ownerId, "MEMBER"));
  await expectForbidden(removeMember(client, actor(admin.id, workspaceId, "ADMIN"), ownerId));
  await expectForbidden(changeMemberRole(client, actor(admin.id, workspaceId, "ADMIN"), adminId, "OWNER"));

  // Admin can still manage non-owner members.
  await changeMemberRole(client, actor(admin.id, workspaceId, "ADMIN"), adminId, "MEMBER");
});

test("viewers and members cannot invite; role matrix applies to invites", async () => {
  const { client, workspaceId, viewer, member, admin } = await setupTeam();
  const email = `new-${uniqueId()}@example.test`;

  await expectForbidden(inviteMember(client, actor(viewer.id, workspaceId, "VIEWER"), { email, role: "MEMBER" }));
  await expectForbidden(inviteMember(client, actor(member.id, workspaceId, "MEMBER"), { email, role: "MEMBER" }));
  await expectForbidden(inviteMember(client, actor(admin.id, workspaceId, "ADMIN"), { email, role: "OWNER" }));

  const ok = await inviteMember(client, actor(admin.id, workspaceId, "ADMIN"), { email, role: "MEMBER" });
  assert.ok(ok.token.length > 30);
});

test("member listing is visible to every role", async () => {
  const { client, workspaceId, viewer } = await setupTeam();
  const page = await listMembers(client, actor(viewer.id, workspaceId, "VIEWER"), { take: 10 });
  assert.equal(page.items.length, 4);
});

export {};
