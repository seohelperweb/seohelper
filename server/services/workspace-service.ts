import type { DbClient, PrismaClient } from "@seo/db";
import { record } from "../repositories/audit.ts";
import { createWithOwner, listForUser } from "../repositories/workspaces.ts";

export async function listWorkspacesForUser(db: DbClient, userId: string) {
  const rows = await listForUser(db, userId);
  return rows.map((row) => ({
    id: row.workspace.id,
    name: row.workspace.name,
    role: row.role,
    createdAt: row.workspace.createdAt,
  }));
}

export async function createWorkspace(
  db: PrismaClient,
  actor: { userId: string },
  input: { name: string },
  requestId?: string,
) {
  const workspace = await createWithOwner(db, { name: input.name, ownerId: actor.userId });
  await record(db, {
    workspaceId: workspace.id,
    actorId: actor.userId,
    action: "workspace.created",
    resourceId: workspace.id,
    requestId,
    details: { name: input.name },
  });
  return workspace;
}
