import type { PrismaClient } from "@seo/db";
import { ACTIVE_RUN_STATUSES } from "../repositories/crawls.ts";
import { lockProject } from "../repositories/projects.ts";

/**
 * Retention cleanup (docs/ARCHITECTURE.md §13): observation/event/frontier
 * details expire after `retentionDays` (90) or when a project holds more
 * than `maxRunsPerProject` (20) completed runs — whichever triggers first.
 * The current baseline, runs referenced as a base by active runs, and all
 * run/summary/policy metadata are always preserved; pruned runs are marked
 * with detailsExpiredAt so the UI can say "history details expired".
 */

export const RETENTION_DEFAULTS = { retentionDays: 90, maxRunsPerProject: 20 } as const;

export interface CleanupResult {
  runsPruned: number;
  observationsDeleted: number;
  eventsDeleted: number;
  frontierDeleted: number;
  transitionsPruned: number;
}

export async function cleanupRunDetails(
  db: PrismaClient,
  now: Date = new Date(),
  options: { retentionDays?: number; maxRunsPerProject?: number } = {},
): Promise<CleanupResult> {
  const retentionDays = options.retentionDays ?? RETENTION_DEFAULTS.retentionDays;
  const maxRuns = options.maxRunsPerProject ?? RETENTION_DEFAULTS.maxRunsPerProject;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const result: CleanupResult = {
    runsPruned: 0,
    observationsDeleted: 0,
    eventsDeleted: 0,
    frontierDeleted: 0,
    transitionsPruned: 0,
  };

  const projects = await db.project.findMany({ select: { id: true } });
  for (const project of projects) {
    const pruned = await db.$transaction(async (tx) => {
      // Serialize baseline selection with publication and keep all deletions atomic.
      await lockProject(tx, project.id);
      const currentProject = await tx.project.findUnique({ where: { id: project.id } });
      if (!currentProject) return [];
      // Runs whose details are still referenced: current baseline + base of any active run.
      const activeBaseRunIds = await tx.crawlRun.findMany({
        where: { projectId: project.id, status: { in: [...ACTIVE_RUN_STATUSES] }, baseRunId: { not: null } },
        select: { baseRunId: true },
      });
      const protectedIds = new Set<string>(
        [currentProject.latestPublishedRunId, ...activeBaseRunIds.map((r) => r.baseRunId)].filter(
          (id): id is string => id !== null,
        ),
      );

      const candidates = await tx.crawlRun.findMany({
        where: {
          projectId: project.id,
          status: { in: ["COMPLETED", "CANCELLED", "FAILED"] },
          finishedAt: { not: null },
          detailsExpiredAt: null,
        },
        orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
        select: { id: true, finishedAt: true },
      });

      const deletions = [];
      for (const [index, run] of candidates.entries()) {
        const expiredByAge = run.finishedAt !== null && run.finishedAt < cutoff;
        const expiredByCount = index >= maxRuns;
        if (!(expiredByAge || expiredByCount) || protectedIds.has(run.id)) continue;

        const [observations, events, frontier] = await Promise.all([
          tx.pageObservation.deleteMany({ where: { runId: run.id } }),
          tx.changeEvent.deleteMany({ where: { runId: run.id } }),
          tx.crawlFrontier.deleteMany({ where: { runId: run.id } }),
        ]);
        await tx.crawlRun.update({ where: { id: run.id }, data: { detailsExpiredAt: now } });
        deletions.push({ observations: observations.count, events: events.count, frontier: frontier.count });
      }
      return deletions;
    });
    for (const deletion of pruned) {
      result.runsPruned += 1;
      result.observationsDeleted += deletion.observations;
      result.eventsDeleted += deletion.events;
      result.frontierDeleted += deletion.frontier;
    }
  }

  const transitions = await db.issueTransition.deleteMany({ where: { createdAt: { lt: cutoff } } });
  result.transitionsPruned = transitions.count;
  return result;
}
