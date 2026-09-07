import type { DbClient, Membership, WorkspaceRole } from "@seo/db";
import { encodeCursor } from "../api/cursor.ts";

export async function findForUser(db: DbClient, workspaceId: string, userId: string): Promise<Membership | null> {
  return db.membership.findFirst({ where: { workspaceId, userId } });
}

export async function listForWorkspace(db: DbClient, workspaceId: string, page: { where?: object; take: number }) {
  const items = await db.membership.findMany({
    where: { workspaceId, ...(page.where ?? {}) },
    include: { user: { select: { id: true, name: true, email: true, emailVerified: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.take + 1,
  });
  const hasMore = items.length > page.take;
  const visible = hasMore ? items.slice(0, page.take) : items;
  const last = visible.at(-1);
  return { items: visible, nextCursor: hasMore && last ? cursorOf(last) : null };
}

function cursorOf(row: { createdAt: Date; id: string }): string {
  return encodeCursor(row);
}

export async function findById(db: DbClient, membershipId: string): Promise<Membership | null> {
  return db.membership.findUnique({ where: { id: membershipId } });
}

export async function countByRole(db: DbClient, workspaceId: string, role: WorkspaceRole): Promise<number> {
  return db.membership.count({ where: { workspaceId, role } });
}

export async function updateRole(db: DbClient, membershipId: string, role: WorkspaceRole): Promise<Membership> {
  return db.membership.update({ where: { id: membershipId }, data: { role } });
}

export async function remove(db: DbClient, membershipId: string): Promise<void> {
  await db.membership.delete({ where: { id: membershipId } });
}

export async function create(
  db: DbClient,
  data: { workspaceId: string; userId: string; role: WorkspaceRole },
): Promise<Membership> {
  return db.membership.create({ data });
}

/** Serialize member mutations on the workspace row (docs/ARCHITECTURE.md §5 lock order). */
export async function lockWorkspace(db: DbClient, workspaceId: string): Promise<void> {
  await db.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
}
