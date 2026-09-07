import test from "node:test";
import assert from "node:assert/strict";
import { before } from "node:test";
import { actor, cleanDatabase, createWorkspaceWithOwner, createUser, db } from "./helpers.ts";
import { ApiError } from "../../server/api/errors.ts";
import { acceptInvitation, inviteMember } from "../../server/services/member-service.ts";
import { hashToken } from "../../server/invitations/tokens.ts";

before(async () => {
  await cleanDatabase(db());
});

test("invitation flow: verified matching email accepts once", async () => {
  const client = db();
  const owner = await createUser(client);
  const workspaceId = await createWorkspaceWithOwner(client, owner, "Invite WS");
  const invitee = await createUser(client, { verified: true });
  const stranger = await createUser(client, { verified: true });
  const unverified = await createUser(client, { verified: false });

  const { token, expiresAt } = await inviteMember(client, actor(owner.id, workspaceId, "OWNER"), {
    email: invitee.email,
    role: "MEMBER",
  });
  assert.ok(expiresAt.getTime() > Date.now());

  // Wrong email and unverified sessions are rejected.
  await assert.rejects(acceptInvitation(client, sessionOf(stranger), token), ApiError);
  await assert.rejects(acceptInvitation(client, sessionOf(unverified), token), ApiError);

  const accepted = await acceptInvitation(client, sessionOf(invitee), token);
  assert.equal(accepted.workspaceId, workspaceId);
  assert.equal(accepted.role, "MEMBER");
  assert.equal(accepted.workspaceName, "Invite WS");

  const membership = await client.membership.findFirst({ where: { workspaceId, userId: invitee.id } });
  assert.equal(membership?.role, "MEMBER");

  // Token is single-use.
  await assert.rejects(acceptInvitation(client, sessionOf(invitee), token), ApiError);
});

test("expired and revoked invitations are rejected", async () => {
  const client = db();
  const owner = await createUser(client);
  const workspaceId = await createWorkspaceWithOwner(client, owner);
  const invitee = await createUser(client, { verified: true });

  const expired = await inviteMember(client, actor(owner.id, workspaceId, "OWNER"), {
    email: invitee.email,
    role: "VIEWER",
  });
  await client.invitation.update({
    where: { tokenHash: hashToken(expired.token) },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await assert.rejects(acceptInvitation(client, sessionOf(invitee), expired.token), ApiError);

  const revoked = await inviteMember(client, actor(owner.id, workspaceId, "OWNER"), {
    email: invitee.email,
    role: "VIEWER",
  });
  await client.invitation.update({ where: { tokenHash: hashToken(revoked.token) }, data: { revokedAt: new Date() } });
  await assert.rejects(acceptInvitation(client, sessionOf(invitee), revoked.token), ApiError);
});

test("re-accepting for an existing member resolves to a conflict, not a second membership", async () => {
  const client = db();
  const owner = await createUser(client);
  const invitee = await createUser(client, { verified: true });
  const workspaceId = await createWorkspaceWithOwner(client, owner);

  const first = await inviteMember(client, actor(owner.id, workspaceId, "OWNER"), {
    email: invitee.email,
    role: "VIEWER",
  });
  await acceptInvitation(client, sessionOf(invitee), first.token);

  const second = await inviteMember(client, actor(owner.id, workspaceId, "OWNER"), {
    email: invitee.email,
    role: "VIEWER",
  });
  await assert.rejects(acceptInvitation(client, sessionOf(invitee), second.token), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    return true;
  });
  const count = await client.membership.count({ where: { workspaceId, userId: invitee.id } });
  assert.equal(count, 1);
});

function sessionOf(user: { id: string; email: string; emailVerified: boolean }) {
  return { id: user.id, email: user.email, emailVerified: user.emailVerified };
}

export {};
