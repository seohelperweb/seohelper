import { createHash } from "node:crypto";
import type { CrawlFrontier, CrawlRun, DbClient, FrontierSource, PrismaClient } from "@seo/db";

export const ACTIVE_RUN_STATUSES = ["QUEUED", "RUNNING", "FINALIZING"] as const;

export function urlKeyOf(identityUrl: string): string {
  return createHash("sha256").update(identityUrl, "utf8").digest("hex");
}

/** Tenancy guard: the run's project must belong to the workspace, else null (→ 404). */
export async function findRunScoped(
  db: DbClient,
  workspaceId: string,
  projectId: string,
  runId: string,
): Promise<CrawlRun | null> {
  return db.crawlRun.findFirst({ where: { id: runId, projectId, project: { workspaceId } } });
}

export async function hasActiveRun(db: DbClient, projectId: string): Promise<boolean> {
  const count = await db.crawlRun.count({ where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } } });
  return count > 0;
}

export async function createRun(
  db: DbClient,
  input: {
    projectId: string;
    policyId: string;
    trigger: "MANUAL" | "SCHEDULED";
    baseRunId: string | null;
    pagesKnown: number;
  },
): Promise<CrawlRun> {
  return db.crawlRun.create({ data: input });
}

/** Atomically take over the run lease; stale lease holders can no longer write (docs §7.1). */
export async function acquireLease(db: DbClient, runId: string, leaseMs: number, now: Date): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ leaseToken: number }>>`
    UPDATE "CrawlRun"
    SET "status" = CASE WHEN "status" = 'FINALIZING' THEN 'FINALIZING'::"CrawlRunStatus" ELSE 'RUNNING'::"CrawlRunStatus" END,
        "leaseToken" = "leaseToken" + 1, "leaseExpiresAt" = ${new Date(now.getTime() + leaseMs)}, "updatedAt" = ${now}
    WHERE "id" = ${runId} AND "status" IN ('QUEUED', 'RUNNING', 'FINALIZING')
      AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
    RETURNING "leaseToken"
  `;
  return rows[0]?.leaseToken ?? null;
}

/** Fenced write: only the current lease holder may mutate run state. */
export async function withRunFence<T>(
  db: PrismaClient,
  runId: string,
  leaseToken: number,
  fn: (tx: DbClient) => Promise<T>,
  projectId?: string,
): Promise<T | null> {
  return db.$transaction(async (tx) => {
    if (projectId !== undefined) {
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
    }
    const rows = await tx.$queryRaw<Array<{ leaseToken: number; status: string }>>`
      SELECT "leaseToken", "status" FROM "CrawlRun" WHERE "id" = ${runId} FOR UPDATE
    `;
    const run = rows[0];
    if (!run || run.leaseToken !== leaseToken || !ACTIVE_RUN_STATUSES.some((status) => status === run.status)) {
      return null;
    }
    return fn(tx);
  });
}

export async function renewLease(
  db: DbClient,
  runId: string,
  leaseToken: number,
  leaseMs: number,
  now: Date,
): Promise<boolean> {
  const result = await db.crawlRun.updateMany({
    where: { id: runId, leaseToken, status: { in: [...ACTIVE_RUN_STATUSES] } },
    data: { leaseExpiresAt: new Date(now.getTime() + leaseMs) },
  });
  return result.count === 1;
}

export async function addFrontierUrl(
  db: DbClient,
  input: { runId: string; identityUrl: string; depth: number; source: FrontierSource },
): Promise<boolean> {
  const urlKey = urlKeyOf(input.identityUrl);
  try {
    await db.crawlFrontier.create({
      data: { runId: input.runId, urlKey, requestUrl: input.identityUrl, depth: input.depth, source: input.source },
    });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return false; // already in frontier
    throw error;
  }
}

export async function countFrontier(db: DbClient, runId: string): Promise<number> {
  return db.crawlFrontier.count({ where: { runId } });
}

export async function claimNextFrontierItem(
  db: PrismaClient,
  runId: string,
  now: Date,
  leaseToken?: number,
): Promise<CrawlFrontier | null> {
  const claim = async (tx: DbClient) => {
    const next = await tx.crawlFrontier.findFirst({
      where: { runId, state: "PENDING", nextAttemptAt: { lte: now } },
      orderBy: [{ depth: "asc" }, { urlKey: "asc" }],
    });
    if (!next) return null;
    const updated = await tx.crawlFrontier.updateMany({
      where: { id: next.id, state: "PENDING" },
      data: { state: "FETCHING" },
    });
    return updated.count === 1 ? next : null;
  };
  return leaseToken === undefined ? db.$transaction(claim) : withRunFence(db, runId, leaseToken, claim);
}

export async function resetStaleFrontier(
  db: PrismaClient,
  runId: string,
  now: Date,
  leaseToken?: number,
): Promise<number> {
  const reset = async (tx: DbClient) => {
    const result = await tx.crawlFrontier.updateMany({
      where: { runId, state: "FETCHING" },
      data: { state: "PENDING", nextAttemptAt: now },
    });
    return result.count;
  };
  return leaseToken === undefined ? reset(db) : ((await withRunFence(db, runId, leaseToken, reset)) ?? 0);
}

export interface UpsertObservationInput {
  runId: string;
  leaseToken?: number;
  projectId: string;
  identityVersion: number;
  identityUrl: string;
  fetchOutcome:
    | "HTTP_RESPONSE"
    | "REDIRECT_BLOCKED"
    | "SECURITY_BLOCKED"
    | "SCOPE_BLOCKED"
    | "ROBOTS_BLOCKED"
    | "NETWORK_ERROR"
    | "BODY_TOO_LARGE"
    | "TIMEOUT"
    | "REDIRECT_LIMIT";
  requestUrl: string;
  finalUrl?: string | null;
  initialStatus?: number | null;
  finalStatus?: number | null;
  redirectChain?: Array<{ url: string; status: number; location: string }> | null;
  contentType?: string | null;
  title?: string | null;
  metaDescription?: string | null;
  canonical?: { raw: string[]; resolved: string[]; validity: string } | null;
  robots?: { raw: string[]; index: string } | null;
  internalLinksCount?: number | null;
  fieldValidity?: Record<string, string> | null;
  failureCode?: string | null;
  fetchedAt: Date;
}

/** Upsert the page identity and write the (idempotent) observation for this run. */
export async function saveObservation(db: PrismaClient, input: UpsertObservationInput): Promise<{ created: boolean }> {
  const urlKey = urlKeyOf(input.identityUrl);
  const save = async (tx: DbClient) => {
    if (input.leaseToken !== undefined) {
      const run = await tx.crawlRun.findUniqueOrThrow({ where: { id: input.runId }, select: { status: true } });
      if (run.status !== "RUNNING") return { created: false };
    }
    const page = await tx.page.upsert({
      where: {
        projectId_identityVersion_urlKey: {
          projectId: input.projectId,
          identityVersion: input.identityVersion,
          urlKey,
        },
      },
      create: {
        projectId: input.projectId,
        identityVersion: input.identityVersion,
        urlKey,
        identityUrl: input.identityUrl,
        firstSeenRunId: input.runId,
      },
      update: {},
    });
    const existing = await tx.pageObservation.findUnique({
      where: { runId_pageId: { runId: input.runId, pageId: page.id } },
      select: { id: true },
    });
    if (existing) return { created: false };
    await tx.pageObservation.create({
      data: {
        runId: input.runId,
        pageId: page.id,
        fetchOutcome: input.fetchOutcome,
        requestUrl: input.requestUrl,
        finalUrl: input.finalUrl ?? null,
        initialStatus: input.initialStatus ?? null,
        finalStatus: input.finalStatus ?? null,
        redirectChain: (input.redirectChain ?? undefined) as never,
        contentType: input.contentType ?? null,
        title: input.title ?? null,
        metaDescription: input.metaDescription ?? null,
        canonical: (input.canonical ?? undefined) as never,
        robots: (input.robots ?? undefined) as never,
        internalLinksCount: input.internalLinksCount ?? null,
        fieldValidity: (input.fieldValidity ?? undefined) as never,
        failureCode: input.failureCode ?? null,
        fetchedAt: input.fetchedAt,
      },
    });
    await tx.page.update({ where: { id: page.id }, data: { lastSeenRunId: input.runId } });
    await tx.crawlRun.update({ where: { id: input.runId }, data: { pagesDone: { increment: 1 } } });
    return { created: true };
  };
  return input.leaseToken === undefined
    ? db.$transaction(save)
    : ((await withRunFence(db, input.runId, input.leaseToken, save)) ?? { created: false });
}

export async function countObservations(db: DbClient, runId: string): Promise<number> {
  return db.pageObservation.count({ where: { runId } });
}
