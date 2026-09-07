import type { DbClient, Membership, PrismaClient, WorkspaceRole } from "@seo/db";
import { ApiError } from "../api/errors.ts";
import type { ActorContext, SessionUser } from "../auth/actor.ts";
import { can, canModifyMember } from "../auth/permissions.ts";
import { createInvitationToken, hashToken, invitationExpiry, isExpired } from "../invitations/tokens.ts";
import * as invitations from "../repositories/invitations.ts";
import * as memberships from "../repositories/memberships.ts";
import { record as recordAudit } from "../repositories/audit.ts";

export async function listMembers(db: DbClient, actor: ActorContext, page: { where?: object; take: number }) {
  if (!can(actor.role, "view")) throw ApiError.forbidden();
  return memberships.listForWorkspace(db, actor.workspaceId, page);
}

export async function listInvitations(db: DbClient, actor: ActorContext, page: { where?: object; take: number }) {
  if (!can(actor.role, "manage-members")) throw ApiError.forbidden();
  return invitations.listForWorkspace(db, actor.workspaceId, page);
}

export interface InviteResult {
  invitationId: string;
  token: string;
  expiresAt: Date;
}

/** Create a one-time invitation. The raw token is returned exactly once; only its hash is stored. */
export async function inviteMember(
  db: PrismaClient,
  actor: ActorContext,
  input: { email: string; role: WorkspaceRole },
  requestId?: string,
): Promise<InviteResult> {
  return db.$transaction(async (tx) => {
    await memberships.lockWorkspace(tx, actor.workspaceId);
    const currentActor = await memberships.findForUser(tx, actor.workspaceId, actor.userId);
    if (!currentActor) throw ApiError.notFound("Workspace not found");
    if (!can(currentActor.role, "manage-members")) throw ApiError.forbidden();
    if (input.role === "OWNER" && !can(currentActor.role, "manage-owners")) {
      throw ApiError.forbidden("Only owners can grant the owner role");
    }
    const email = input.email.trim().toLowerCase();
    const token = createInvitationToken();
    const expiresAt = invitationExpiry();
    const invitation = await invitations.create(tx, {
      workspaceId: actor.workspaceId,
      email,
      role: input.role,
      tokenHash: hashToken(token),
      expiresAt,
    });
    await recordAudit(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "member.invited",
      resourceId: invitation.id,
      requestId,
      details: { email, role: input.role },
    });
    return { invitationId: invitation.id, token, expiresAt };
  });
}

export async function revokeInvitation(
  db: PrismaClient,
  actor: ActorContext,
  invitationId: string,
  requestId?: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await memberships.lockWorkspace(tx, actor.workspaceId);
    const currentActor = await memberships.findForUser(tx, actor.workspaceId, actor.userId);
    if (!currentActor) throw ApiError.notFound("Workspace not found");
    if (!can(currentActor.role, "manage-members")) throw ApiError.forbidden();
    const count = await invitations.revoke(tx, invitationId, actor.workspaceId, new Date());
    if (count !== 1) throw ApiError.notFound("Invitation not found");
    await recordAudit(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "member.invitation_revoked",
      resourceId: invitationId,
      requestId,
    });
  });
}

export interface AcceptInvitationResult {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
}

/**
 * Accept an invitation with the acting session: requires a verified email
 * matching the invitation and consumes the token atomically together with
 * membership creation (docs/ARCHITECTURE.md §4).
 */
export async function acceptInvitation(
  db: PrismaClient,
  session: SessionUser,
  token: string,
  requestId?: string,
): Promise<AcceptInvitationResult> {
  const tokenHash = hashToken(token);
  const invitation = await db.invitation.findUnique({
    where: { tokenHash },
    include: { workspace: { select: { name: true } } },
  });
  if (!invitation || invitation.revokedAt || invitation.consumedAt || isExpired(invitation.expiresAt)) {
    throw ApiError.badRequest("Invitation is invalid, revoked, or expired");
  }
  if (!session.emailVerified) {
    throw ApiError.forbidden("Verify your email address before accepting invitations");
  }
  if (session.email.toLowerCase() !== invitation.email.toLowerCase()) {
    throw ApiError.forbidden("This invitation was issued for a different email address");
  }

  return db.$transaction(async (tx) => {
    const consumed = await invitations.consume(tx, { tokenHash, userId: session.id, now: new Date() });
    if (!consumed) throw ApiError.conflict("Invitation was already used");
    let membership: Membership;
    try {
      membership = await memberships.create(tx, {
        workspaceId: invitation.workspaceId,
        userId: session.id,
        role: invitation.role,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        throw ApiError.conflict("You are already a member of this workspace");
      }
      throw error;
    }
    await recordAudit(tx, {
      workspaceId: invitation.workspaceId,
      actorId: session.id,
      action: "member.invitation_accepted",
      resourceId: membership.id,
      requestId,
      details: { role: membership.role },
    });
    return { workspaceId: invitation.workspaceId, workspaceName: invitation.workspace.name, role: membership.role };
  });
}

/** Change a member role with owner-target and last-owner protections (docs/ARCHITECTURE.md §4). */
export async function changeMemberRole(
  db: PrismaClient,
  actor: ActorContext,
  membershipId: string,
  newRole: WorkspaceRole,
  requestId?: string,
): Promise<Membership> {
  return db.$transaction(async (tx) => {
    await memberships.lockWorkspace(tx, actor.workspaceId);
    const currentActor = await memberships.findForUser(tx, actor.workspaceId, actor.userId);
    if (!currentActor) throw ApiError.notFound("Workspace not found");
    const target = await memberships.findById(tx, membershipId);
    if (!target || target.workspaceId !== actor.workspaceId) throw ApiError.notFound("Member not found");
    if (!canModifyMember(currentActor.role, target.role, newRole)) throw ApiError.forbidden();
    if (target.role === newRole) return target;
    if (target.role === "OWNER" && newRole !== "OWNER") {
      const owners = await memberships.countByRole(tx, actor.workspaceId, "OWNER");
      if (owners <= 1) throw ApiError.forbidden("The last owner cannot be demoted");
    }
    const updated = await memberships.updateRole(tx, membershipId, newRole);
    await recordAudit(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "member.role_changed",
      resourceId: membershipId,
      requestId,
      details: { from: target.role, to: newRole },
    });
    return updated;
  });
}

export async function removeMember(
  db: PrismaClient,
  actor: ActorContext,
  membershipId: string,
  requestId?: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await memberships.lockWorkspace(tx, actor.workspaceId);
    const currentActor = await memberships.findForUser(tx, actor.workspaceId, actor.userId);
    if (!currentActor) throw ApiError.notFound("Workspace not found");
    const target = await memberships.findById(tx, membershipId);
    if (!target || target.workspaceId !== actor.workspaceId) throw ApiError.notFound("Member not found");
    if (target.userId === actor.userId)
      throw ApiError.forbidden("Use workspace settings to leave; self-removal is not supported yet");
    if (!canModifyMember(currentActor.role, target.role)) throw ApiError.forbidden();
    if (target.role === "OWNER") {
      const owners = await memberships.countByRole(tx, actor.workspaceId, "OWNER");
      if (owners <= 1) throw ApiError.forbidden("The last owner cannot be removed");
    }
    await memberships.remove(tx, membershipId);
    await recordAudit(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "member.removed",
      resourceId: membershipId,
      requestId,
      details: { role: target.role },
    });
  });
}
