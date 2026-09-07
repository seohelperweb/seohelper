import type { Membership, DbClient, WorkspaceRole } from "@seo/db";
import { getDb } from "@seo/db";
import { ApiError } from "../api/errors.ts";
import { auth } from "./auth.ts";

export interface ActorContext {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

export interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

/** Resolve the Better Auth session for a request; 401 when absent. */
export async function getSessionUser(request: Request): Promise<SessionUser> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) throw ApiError.unauthenticated();
  return { id: session.user.id, email: session.user.email, emailVerified: session.user.emailVerified };
}

/**
 * Resolve the acting member from a verified membership. A user without
 * membership gets 404 — invisible resources are indistinguishable from
 * missing ones (docs/ARCHITECTURE.md §10).
 */
export async function loadActor(db: DbClient, userId: string, workspaceId: string): Promise<ActorContext> {
  const membership: Membership | null = await db.membership.findFirst({ where: { workspaceId, userId } });
  if (!membership) throw ApiError.notFound("Workspace not found");
  return { userId, workspaceId, role: membership.role };
}

export async function requireActor(
  request: Request,
  workspaceId: string,
  db: DbClient = getDb(),
): Promise<ActorContext> {
  const user = await getSessionUser(request);
  return loadActor(db, user.id, workspaceId);
}
