import { createHash } from "node:crypto";
import type { CrawlCompleteness, CrawlRun, CrawlRunStatus, DbClient, PrismaClient } from "@seo/db";
import { ApiError } from "../api/errors.ts";
import type { ActorContext } from "../auth/actor.ts";
import { can } from "../auth/permissions.ts";
import { record as recordAudit } from "../repositories/audit.ts";
import { assertProjectCrawlable, CrawlBlockedError } from "../crawl/crawl-guard.ts";
import { ACTIVE_RUN_STATUSES, createRun, findRunScoped } from "../repositories/crawls.ts";
import { withIdempotency } from "../repositories/idempotency.ts";
import { CRAWL_REQUESTED, emit } from "../repositories/outbox.ts";
import * as projects from "../repositories/projects.ts";
import { VERIFICATION_VALIDITY_MS } from "../verification/challenge.ts";

export interface CreateCrawlResult {
  crawlId: string;
  status: CrawlRunStatus;
  replay: boolean;
}

/**
 * Create a manual crawl (docs/ARCHITECTURE.md §7, §10): one business
 * transaction writes CrawlRun + IdempotencyRecord + OutboxEvent; at most one
 * active run per project; verification must be valid within 30 days.
 */
export async function createCrawl(
  db: PrismaClient,
  actor: ActorContext,
  projectId: string,
  idempotencyKey: string,
  requestId?: string,
): Promise<CreateCrawlResult> {
  if (!can(actor.role, "run-crawl")) throw ApiError.forbidden();
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw ApiError.badRequest("Idempotency-Key header is required (max 200 chars)");

  const route = `POST /api/v1/workspaces/${actor.workspaceId}/projects/${projectId}/crawls`;
  const requestHash = createHash("sha256").update(`${route}:`, "utf8").digest("hex");

  const outcome = await withIdempotency(
    db,
    {
      actorId: actor.userId,
      workspaceId: actor.workspaceId,
      route,
      key: idempotencyKey,
      requestHash,
      ttlMs: 24 * 60 * 60 * 1000,
    },
    async (tx) => {
      await projects.lockProject(tx, projectId);
      const project = await projects.findScoped(tx, actor.workspaceId, projectId);
      if (!project) throw ApiError.notFound("Project not found");
      if (project.archivedAt) throw ApiError.conflict("Project is archived");
      try {
        assertProjectCrawlable(
          {
            id: project.id,
            hostname: project.hostname,
            verificationStatus: project.verificationStatus,
            latestVerification: project.verifications[0] ?? null,
          },
          VERIFICATION_VALIDITY_MS,
        );
      } catch (error) {
        if (error instanceof CrawlBlockedError) throw ApiError.conflict(error.message, "VERIFICATION_REQUIRED");
        throw error;
      }
      const policyId = project.currentPolicyId;
      if (!policyId) throw ApiError.conflict("Project has no active policy");
      const active = await tx.crawlRun.findFirst({
        where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: { id: true },
      });
      if (active) {
        throw ApiError.conflict("A crawl is already active for this project", "CRAWL_ALREADY_ACTIVE");
      }
      // Manual-trigger quota (docs/ARCHITECTURE.md §7.3): ≤10 per day per
      // project, at least 5 minutes between creations. Idempotent replays
      // return before reaching here.
      const now = new Date();
      const dailyCount = await tx.crawlRun.count({
        where: { projectId, trigger: "MANUAL", createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
      });
      if (dailyCount >= 10) {
        throw ApiError.tooManyRequests("Daily manual crawl quota reached (10/day)", {
          retryAfterMs: 24 * 60 * 60 * 1000,
        });
      }
      const lastManual = await tx.crawlRun.findFirst({
        where: { projectId, trigger: "MANUAL" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (lastManual) {
        const nextAllowedAt = new Date(lastManual.createdAt.getTime() + 5 * 60 * 1000);
        if (nextAllowedAt > now) {
          throw ApiError.tooManyRequests("Manual crawls must be at least 5 minutes apart", { nextAllowedAt });
        }
      }
      const pagesKnown = await tx.page.count({ where: { projectId } });
      const run = await createRun(tx, { projectId, policyId, trigger: "MANUAL", baseRunId: null, pagesKnown });
      await emit(tx, {
        type: CRAWL_REQUESTED,
        aggregateId: run.id,
        payload: { workspaceId: actor.workspaceId, projectId, crawlId: run.id },
      });
      await recordAudit(tx, {
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        action: "crawl.created",
        resourceId: run.id,
        requestId,
        details: { projectId, trigger: "MANUAL" },
      });
      return run.id;
    },
  );

  const run = await db.crawlRun.findUniqueOrThrow({ where: { id: outcome.resourceId } });
  return { crawlId: run.id, status: run.status, replay: outcome.replay };
}

export type CrawlDetail = CrawlRun;

export async function getCrawl(
  db: DbClient,
  actor: ActorContext,
  projectId: string,
  crawlId: string,
): Promise<CrawlDetail> {
  if (!can(actor.role, "view")) throw ApiError.forbidden();
  const run = await findRunScoped(db, actor.workspaceId, projectId, crawlId);
  if (!run) throw ApiError.notFound("Crawl not found");
  return run;
}

export async function listCrawls(
  db: DbClient,
  actor: ActorContext,
  projectId: string,
  page: { where?: object; take: number },
) {
  if (!can(actor.role, "view")) throw ApiError.forbidden();
  const project = await projects.findScoped(db, actor.workspaceId, projectId);
  if (!project) throw ApiError.notFound("Project not found");
  const items = await db.crawlRun.findMany({
    where: { projectId, ...(page.where ?? {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.take + 1,
    select: {
      id: true,
      status: true,
      completeness: true,
      comparisonMode: true,
      trigger: true,
      failureCode: true,
      pagesDone: true,
      pagesKnown: true,
      createdAt: true,
      finishedAt: true,
      publishedAt: true,
    },
  });
  const { encodeCursor } = await import("../api/cursor.ts");
  const hasMore = items.length > page.take;
  const visible = hasMore ? items.slice(0, page.take) : items;
  const last = visible.at(-1);
  return {
    items: visible,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export interface CancelCrawlResult {
  crawlId: string;
  status: CrawlRunStatus;
  alreadyFinished: boolean;
}

/** Request cancellation (docs/ARCHITECTURE.md §7.2): QUEUED dies immediately; leased runs get a cooperative flag. */
export async function cancelCrawl(
  db: PrismaClient,
  actor: ActorContext,
  projectId: string,
  crawlId: string,
  requestId?: string,
): Promise<CancelCrawlResult> {
  if (!can(actor.role, "run-crawl")) throw ApiError.forbidden();
  const run = await findRunScoped(db, actor.workspaceId, projectId, crawlId);
  if (!run) throw ApiError.notFound("Crawl not found");

  if (run.status === "CANCELLED") {
    return { crawlId: run.id, status: "CANCELLED", alreadyFinished: true };
  }
  if (run.status === "COMPLETED" || run.status === "FAILED") {
    throw ApiError.conflict("Crawl already reached a terminal state", "CRAWL_ALREADY_FINISHED");
  }

  const leaseValid = run.leaseExpiresAt !== null && run.leaseExpiresAt.getTime() > Date.now();
  if (run.status === "QUEUED" || !leaseValid) {
    // No live worker: cancel directly, fencing any stale worker out via leaseToken bump.
    const result = await db.crawlRun.updateMany({
      where: { id: run.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
      data: {
        status: "CANCELLED",
        finishedAt: new Date(),
        leaseToken: { increment: 1 },
        leaseExpiresAt: null,
        cancelRequestedAt: run.cancelRequestedAt ?? new Date(),
      },
    });
    if (result.count === 1) {
      await recordAudit(db, {
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        action: "crawl.cancelled",
        resourceId: run.id,
        requestId,
      });
      return { crawlId: run.id, status: "CANCELLED", alreadyFinished: false };
    }
    const current = await db.crawlRun.findUniqueOrThrow({ where: { id: run.id } });
    return { crawlId: run.id, status: current.status, alreadyFinished: true };
  }

  // A live worker holds the lease — set the cooperative cancel flag.
  const result = await db.crawlRun.updateMany({
    where: { id: run.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
    data: { cancelRequestedAt: new Date() },
  });
  if (result.count !== 1) {
    const current = await db.crawlRun.findUniqueOrThrow({ where: { id: run.id } });
    return { crawlId: run.id, status: current.status, alreadyFinished: true };
  }
  await recordAudit(db, {
    workspaceId: actor.workspaceId,
    actorId: actor.userId,
    action: "crawl.cancel_requested",
    resourceId: run.id,
    requestId,
  });
  return { crawlId: run.id, status: run.status, alreadyFinished: false };
}

export function crawlDto(run: CrawlDetail): {
  id: string;
  status: CrawlRunStatus;
  completeness: CrawlCompleteness;
  comparisonMode: string;
  trigger: string;
  failureCode: string | null;
  pagesDone: number;
  pagesKnown: number;
  cancelRequestedAt: Date | null;
  finishedAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
} {
  return {
    id: run.id,
    status: run.status,
    completeness: run.completeness,
    comparisonMode: run.comparisonMode,
    trigger: run.trigger,
    failureCode: run.failureCode,
    pagesDone: run.pagesDone,
    pagesKnown: run.pagesKnown,
    cancelRequestedAt: run.cancelRequestedAt,
    finishedAt: run.finishedAt,
    publishedAt: run.publishedAt,
    createdAt: run.createdAt,
  };
}
