import type { DbClient, PrismaClient } from "@seo/db";
import { ApiError } from "../api/errors.ts";
import type { ActorContext } from "../auth/actor.ts";
import { can } from "../auth/permissions.ts";
import { record as recordAudit } from "../repositories/audit.ts";
import * as projects from "../repositories/projects.ts";
import { crawlBlockReason } from "../crawl/crawl-guard.ts";
import { VERIFICATION_VALIDITY_MS } from "../verification/challenge.ts";
import { ACTIVE_RUN_STATUSES, createRun } from "../repositories/crawls.ts";
import { CRAWL_REQUESTED, emit } from "../repositories/outbox.ts";

/**
 * Weekly scheduling (docs/ARCHITECTURE.md §12): fixed 7-day interval on UTC
 * slots; DST shifts show up in local display only. One occurrence per
 * (projectId, scheduledFor) slot prevents double-triggering across scanners.
 */

export const SCHEDULE_INTERVAL_DAYS = 7;

export async function getSchedule(db: DbClient, actor: ActorContext, projectId: string) {
  if (!can(actor.role, "view")) throw ApiError.forbidden();
  const project = await projects.findScoped(db, actor.workspaceId, projectId);
  if (!project) throw ApiError.notFound("Project not found");
  const schedule = await db.crawlSchedule.findUnique({ where: { projectId } });
  return {
    enabled: schedule?.enabled ?? false,
    intervalDays: schedule?.intervalDays ?? SCHEDULE_INTERVAL_DAYS,
    nextRunAt: schedule?.nextRunAt ?? null,
    displayTimezone: schedule?.displayTimezone ?? "UTC",
  };
}

export async function updateSchedule(
  db: PrismaClient,
  actor: ActorContext,
  projectId: string,
  input: { enabled: boolean; displayTimezone?: string },
  requestId?: string,
) {
  if (!can(actor.role, "manage-project")) throw ApiError.forbidden();
  const project = await projects.findScoped(db, actor.workspaceId, projectId);
  if (!project) throw ApiError.notFound("Project not found");
  if (project.archivedAt && input.enabled) throw ApiError.conflict("Cannot schedule crawls for an archived project");

  const intervalMs = SCHEDULE_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  const schedule = await db.crawlSchedule.upsert({
    where: { projectId },
    create: {
      projectId,
      enabled: input.enabled,
      intervalDays: SCHEDULE_INTERVAL_DAYS,
      nextRunAt: new Date(Date.now() + intervalMs),
      displayTimezone: input.displayTimezone ?? "UTC",
    },
    update: {
      enabled: input.enabled,
      ...(input.displayTimezone !== undefined ? { displayTimezone: input.displayTimezone } : {}),
    },
  });
  await recordAudit(db, {
    workspaceId: actor.workspaceId,
    actorId: actor.userId,
    action: input.enabled ? "schedule.enabled" : "schedule.disabled",
    resourceId: schedule.id,
    requestId,
    details: { nextRunAt: schedule.nextRunAt.toISOString() },
  });
  return {
    enabled: schedule.enabled,
    intervalDays: schedule.intervalDays,
    nextRunAt: schedule.nextRunAt,
    displayTimezone: schedule.displayTimezone,
  };
}

export interface ScanResult {
  triggered: number;
  skippedBusy: number;
  skippedUnverified: number;
  skippedArchived: number;
  missedSlots: number;
}

/**
 * Scanner tick: claim due schedules under the project row lock so multiple
 * scanners cannot double-fire; missed periods older than one interval are
 * recorded as SKIPPED_MISSED and only the most recent slot triggers
 * (docs/ARCHITECTURE.md §12).
 */
export async function processDueSchedules(db: PrismaClient, now: Date = new Date()): Promise<ScanResult> {
  const result: ScanResult = { triggered: 0, skippedBusy: 0, skippedUnverified: 0, skippedArchived: 0, missedSlots: 0 };
  const due = await db.crawlSchedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    orderBy: { projectId: "asc" },
    take: 20,
  });

  for (const schedule of due) {
    await db.$transaction(async (tx) => {
      await projects.lockProject(tx, schedule.projectId);
      const current = await tx.crawlSchedule.findUnique({ where: { id: schedule.id } });
      if (!current || !current.enabled || current.nextRunAt > now) return; // another scanner won

      const intervalMs = current.intervalDays * 24 * 60 * 60 * 1000;
      const recordOccurrence = async (
        scheduledFor: Date,
        status: string,
        runId: string | null = null,
        reason: string | null = null,
      ) => {
        await tx.scheduleOccurrence
          .create({
            data: { projectId: current.projectId, scheduleId: current.id, scheduledFor, status, runId, reason },
          })
          .catch((error) => {
            if ((error as { code?: string }).code !== "P2002") throw error;
          });
      };

      // Catch-up rule: slots older than one interval are skipped, not fired.
      let nextRunAt = new Date(current.nextRunAt.getTime());
      while (nextRunAt.getTime() + intervalMs <= now.getTime()) {
        await recordOccurrence(new Date(nextRunAt.getTime()), "SKIPPED_MISSED", null, "missed during downtime");
        nextRunAt = new Date(nextRunAt.getTime() + intervalMs);
        result.missedSlots += 1;
      }

      const project = await tx.project.findUniqueOrThrow({
        where: { id: current.projectId },
        include: { currentPolicy: true, verifications: { orderBy: { challengeVersion: "desc" }, take: 1 } },
      });
      const policyId = project.currentPolicyId;

      let status: string | null = null;
      let reason: string | null = null;
      if (project.archivedAt) {
        status = "SKIPPED_ARCHIVED";
        reason = "project archived";
      } else if (
        await tx.crawlRun.count({ where: { projectId: project.id, status: { in: [...ACTIVE_RUN_STATUSES] } } })
      ) {
        status = "SKIPPED_BUSY";
        reason = "another crawl is active";
      } else if (
        policyId &&
        crawlBlockReason(
          {
            id: project.id,
            hostname: project.hostname,
            verificationStatus: project.verificationStatus,
            latestVerification: project.verifications[0] ?? null,
          },
          VERIFICATION_VALIDITY_MS,
          now,
        )
      ) {
        status = "SKIPPED_UNVERIFIED";
        reason = "domain verification missing or expired";
      }

      if (status === null && policyId) {
        const pagesKnown = await tx.page.count({ where: { projectId: project.id } });
        const run = await createRun(tx, {
          projectId: project.id,
          policyId,
          trigger: "SCHEDULED",
          baseRunId: null,
          pagesKnown,
        });
        await emit(tx, {
          type: CRAWL_REQUESTED,
          aggregateId: run.id,
          payload: { workspaceId: project.workspaceId, projectId: project.id, crawlId: run.id },
        });
        await recordOccurrence(nextRunAt, "TRIGGERED", run.id);
        result.triggered += 1;
      } else if (status !== null) {
        await recordOccurrence(nextRunAt, status, null, reason);
        if (status === "SKIPPED_BUSY") result.skippedBusy += 1;
        if (status === "SKIPPED_UNVERIFIED") result.skippedUnverified += 1;
        if (status === "SKIPPED_ARCHIVED") result.skippedArchived += 1;
      }

      // Advance strictly into the future (millisecond races would otherwise
      // leave the slot immediately due again) while staying grid-aligned.
      let advanced = nextRunAt.getTime() + intervalMs;
      while (advanced <= now.getTime()) advanced += intervalMs;
      await tx.crawlSchedule.update({
        where: { id: current.id },
        data: { nextRunAt: new Date(advanced) },
      });
    });
  }
  return result;
}
