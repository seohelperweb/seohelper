import type { DbClient } from "@seo/db";
import { ApiError } from "../api/errors.ts";
import type { ActorContext } from "../auth/actor.ts";
import { can } from "../auth/permissions.ts";
import { encodeCursor } from "../api/cursor.ts";
import * as projects from "../repositories/projects.ts";
import { ACTIVE_RUN_STATUSES } from "../repositories/crawls.ts";

/**
 * Report read models (docs/ARCHITECTURE.md §9-10): only PUBLISHED runs
 * expose changes/summary; issues reflect the current policy scope. All
 * queries are workspace-scoped through the project relation.
 */

async function requireProject(db: DbClient, actor: ActorContext, projectId: string) {
  if (!can(actor.role, "view")) throw ApiError.forbidden();
  const project = await projects.findScoped(db, actor.workspaceId, projectId);
  if (!project) throw ApiError.notFound("Project not found");
  return project;
}

export async function getOverview(db: DbClient, actor: ActorContext, projectId: string) {
  const project = await requireProject(db, actor, projectId);
  const latestPublishedRunId = project.latestPublishedRunId;

  const [summary, activeRun, openIssues, lastTerminal] = await Promise.all([
    latestPublishedRunId ? db.crawlSummary.findUnique({ where: { runId: latestPublishedRunId } }) : null,
    db.crawlRun.findFirst({
      where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true, status: true, pagesDone: true, pagesKnown: true },
    }),
    project.currentPolicy
      ? db.issue.count({
          where: {
            projectId,
            scopeGeneration: project.currentPolicy.scopeGeneration,
            ruleVersion: project.currentPolicy.ruleVersion,
            state: "OPEN",
            OR: [{ suppressedUntil: null }, { suppressedUntil: { lte: new Date() } }],
          },
        })
      : 0,
    db.crawlRun.findFirst({
      where: { projectId, status: { in: ["FAILED", "CANCELLED"] }, publishedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, failureCode: true, createdAt: true },
    }),
  ]);

  const publishedRun = latestPublishedRunId
    ? await db.crawlRun.findUnique({
        where: { id: latestPublishedRunId },
        select: { id: true, publishedAt: true, comparisonMode: true, finishedAt: true },
      })
    : null;

  return {
    project: {
      id: project.id,
      hostname: project.hostname,
      displayName: project.displayName,
      verificationStatus: project.verificationStatus,
      archivedAt: project.archivedAt,
    },
    latestPublishedRunId,
    publishedAt: publishedRun?.publishedAt ?? null,
    comparisonMode: summary?.comparisonMode ?? "NONE",
    summary: summary
      ? {
          urlsCrawled: summary.urlsCrawled,
          changesTotal: summary.changesTotal,
          changesCritical: summary.changesCritical,
          changesWarning: summary.changesWarning,
          changesInfo: summary.changesInfo,
          affectedPages: summary.affectedPages,
          issuesOpen: summary.issuesOpen,
          issuesResolvedThisRun: summary.issuesResolvedThisRun,
        }
      : null,
    // Site health (P5): present only for summaries scored by @seo/health-score;
    // score is null when coverage was insufficient (reason explains why).
    health:
      summary && (summary.healthScore !== null || summary.healthReason !== null)
        ? {
            score: summary.healthScore,
            scoreVersion: summary.healthScoreVersion,
            coverage: summary.healthCoverage,
            reason: summary.healthReason,
            components: summary.healthComponents,
          }
        : null,
    openIssues,
    activeRun,
    lastTerminalRun: lastTerminal,
    firstBaselinePending: latestPublishedRunId === null,
  };
}

export interface ChangeFilter {
  runId?: string;
  severity?: string;
  type?: string;
}

export async function listChanges(
  db: DbClient,
  actor: ActorContext,
  projectId: string,
  filter: ChangeFilter,
  page: { where?: object; take: number },
) {
  const project = await requireProject(db, actor, projectId);
  let runId = filter.runId;
  if (!runId) {
    if (!project.latestPublishedRunId) return { items: [], nextCursor: null };
    runId = project.latestPublishedRunId;
  }
  // Only published runs expose change events (docs §8).
  const run = await db.crawlRun.findFirst({ where: { id: runId, projectId: project.id, publishedAt: { not: null } } });
  if (!run) throw ApiError.notFound("Crawl report not found");

  const severityWhere =
    filter.severity && ["CRITICAL", "WARNING", "INFO"].includes(filter.severity)
      ? { severity: filter.severity as "CRITICAL" | "WARNING" | "INFO" }
      : {};
  const typeWhere = filter.type ? { type: filter.type } : {};
  const items = await db.changeEvent.findMany({
    where: { runId: run.id, ...severityWhere, ...typeWhere, ...(page.where ?? {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.take + 1,
    include: { page: { select: { identityUrl: true } } },
  });
  const hasMore = items.length > page.take;
  const visible = hasMore ? items.slice(0, page.take) : items;
  const last = visible.at(-1);
  return {
    runId: run.id,
    items: visible.map((event) => ({
      id: event.id,
      type: event.type,
      severity: event.severity,
      before: event.before,
      after: event.after,
      url: event.page.identityUrl,
      createdAt: event.createdAt,
    })),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function listIssues(
  db: DbClient,
  actor: ActorContext,
  projectId: string,
  filter: { state?: string },
  page: { where?: object; take: number },
) {
  const project = await requireProject(db, actor, projectId);
  if (!project.currentPolicy) return { items: [], nextCursor: null };
  const stateWhere =
    filter.state === "RESOLVED"
      ? { state: "RESOLVED" as const }
      : filter.state === "ALL"
        ? {}
        : { state: "OPEN" as const };
  const items = await db.issue.findMany({
    where: {
      projectId: project.id,
      scopeGeneration: project.currentPolicy.scopeGeneration,
      ruleVersion: project.currentPolicy.ruleVersion,
      ...stateWhere,
      ...(page.where ?? {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.take + 1,
    include: { page: { select: { identityUrl: true } } },
  });
  const hasMore = items.length > page.take;
  const visible = hasMore ? items.slice(0, page.take) : items;
  const last = visible.at(-1);
  return {
    items: visible.map((issue) => ({
      id: issue.id,
      ruleKey: issue.ruleKey,
      state: issue.state,
      occurrence: issue.occurrence,
      suppressedUntil: issue.suppressedUntil,
      evidence: issue.evidence,
      lastConfirmedAt: issue.lastConfirmedAt,
      updatedAt: issue.updatedAt,
      url: issue.page.identityUrl,
    })),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function listPages(
  db: DbClient,
  actor: ActorContext,
  projectId: string,
  page: { where?: object; take: number },
) {
  const project = await requireProject(db, actor, projectId);
  const items = await db.page.findMany({
    where: { projectId: project.id, ...(page.where ?? {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.take + 1,
  });
  const hasMore = items.length > page.take;
  const visible = hasMore ? items.slice(0, page.take) : items;
  const last = visible.at(-1);

  // One query for all visible pages instead of one per page ((runId, pageId)
  // is unique, so each pair matches at most one observation).
  const lastSeenPairs = visible
    .filter((pageRow) => pageRow.lastSeenRunId !== null)
    .map((pageRow) => ({ pageId: pageRow.id, runId: pageRow.lastSeenRunId as string }));
  const lastObservations = lastSeenPairs.length
    ? await db.pageObservation.findMany({
        where: { OR: lastSeenPairs },
        select: { pageId: true, fetchOutcome: true, finalStatus: true, title: true },
      })
    : [];
  const observationByPage = new Map(lastObservations.map((observation) => [observation.pageId, observation]));
  const withStatus = visible.map((pageRow) => ({
    id: pageRow.id,
    url: pageRow.identityUrl,
    firstSeenRunId: pageRow.firstSeenRunId,
    lastSeenRunId: pageRow.lastSeenRunId,
    lastObservation: observationByPage.get(pageRow.id) ?? null,
  }));
  return {
    items: withStatus,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}
