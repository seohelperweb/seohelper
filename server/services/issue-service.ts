import type { PrismaClient } from "@seo/db";
import { ApiError } from "../api/errors.ts";
import type { ActorContext } from "../auth/actor.ts";
import { can } from "../auth/permissions.ts";
import { record as recordAudit } from "../repositories/audit.ts";
import { lockProject } from "../repositories/projects.ts";

/**
 * Issue suppression (docs/ARCHITECTURE.md §9-10): suppressing is an
 * independent overlay — evaluation continues, reports stay unchanged; a
 * suppressed issue is simply not actionable. Only this overlay is editable;
 * resolved state always comes from rule evaluation.
 */

export async function updateIssueSuppression(
  db: PrismaClient,
  actor: ActorContext,
  projectId: string,
  issueId: string,
  input: { suppressedUntil: Date | null },
  requestId?: string,
) {
  if (!can(actor.role, "run-crawl")) throw ApiError.forbidden();
  return db.$transaction(async (tx) => {
    const issue = await tx.issue.findFirst({
      where: { id: issueId, projectId, project: { workspaceId: actor.workspaceId } },
    });
    if (!issue) throw ApiError.notFound("Issue not found");
    // Publication uses the same project lock when reading suppression settings.
    await lockProject(tx, projectId);
    await tx.issue.update({ where: { id: issue.id }, data: { suppressedUntil: input.suppressedUntil } });
    await recordAudit(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: input.suppressedUntil ? "issue.suppressed" : "issue.unsuppressed",
      resourceId: issue.id,
      requestId,
      details: { ruleKey: issue.ruleKey, suppressedUntil: input.suppressedUntil?.toISOString() ?? null },
    });
    return { id: issue.id, suppressedUntil: input.suppressedUntil };
  });
}
