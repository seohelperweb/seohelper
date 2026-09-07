import type { DbClient } from "@seo/db";
import { encodeCursor } from "../api/cursor.ts";
import { redactAuditDetails } from "../audit/redact.ts";

export async function record(
  db: DbClient,
  input: {
    workspaceId: string;
    actorId: string;
    action: string;
    resourceId?: string;
    requestId?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await db.auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: input.action,
      resourceId: input.resourceId,
      requestId: input.requestId,
      redactedDetails: input.details ? redactAuditDetails(input.details) : undefined,
    },
  });
}

export async function listForWorkspace(db: DbClient, workspaceId: string, page: { where?: object; take: number }) {
  const items = await db.auditLog.findMany({
    where: { workspaceId, ...(page.where ?? {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.take + 1,
  });
  const hasMore = items.length > page.take;
  const visible = hasMore ? items.slice(0, page.take) : items;
  const last = visible.at(-1);
  return { items: visible, nextCursor: hasMore && last ? encodeCursor(last) : null };
}
