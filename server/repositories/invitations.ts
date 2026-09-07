import type { Invitation, DbClient, WorkspaceRole } from "@seo/db";
import { encodeCursor } from "../api/cursor.ts";

export async function create(
  db: DbClient,
  input: { workspaceId: string; email: string; role: WorkspaceRole; tokenHash: string; expiresAt: Date },
): Promise<Invitation> {
  return db.invitation.create({ data: input });
}

export async function findByTokenHash(db: DbClient, tokenHash: string): Promise<Invitation | null> {
  return db.invitation.findUnique({
    where: { tokenHash },
    include: { workspace: { select: { id: true, name: true } } },
  });
}

export async function listForWorkspace(db: DbClient, workspaceId: string, page: { where?: object; take: number }) {
  const items = await db.invitation.findMany({
    where: { workspaceId, ...(page.where ?? {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.take + 1,
  });
  const hasMore = items.length > page.take;
  const visible = hasMore ? items.slice(0, page.take) : items;
  const last = visible.at(-1);
  return { items: visible, nextCursor: hasMore && last ? encodeCursor(last) : null };
}

/**
 * Consume a still-valid invitation exactly once. The guarded updateMany is
 * the atomic consume step; membership creation happens in the same
 * transaction (docs/ARCHITECTURE.md §4).
 */
export async function consume(db: DbClient, input: { tokenHash: string; userId: string; now: Date }): Promise<boolean> {
  const result = await db.invitation.updateMany({
    where: {
      tokenHash: input.tokenHash,
      consumedAt: null,
      revokedAt: null,
      expiresAt: { gt: input.now },
    },
    data: { consumedAt: input.now, consumedByUserId: input.userId },
  });
  return result.count === 1;
}

export async function revoke(db: DbClient, invitationId: string, workspaceId: string, now: Date): Promise<number> {
  const result = await db.invitation.updateMany({
    where: { id: invitationId, workspaceId, consumedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
  return result.count;
}
