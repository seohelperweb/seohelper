import { createHash } from "node:crypto";
import type { CrawlFrontier, CrawlRun, DbClient, FrontierSource, PrismaClient } from "@seo/db";

export const ACTIVE_RUN_STATUSES = ["QUEUED", "RUNNING", "FINALIZING"] as const;

export function urlKeyOf(identityUrl: string): string {
  return createHash("sha256").update(identityUrl, "utf8").digest("hex");
}

export async function findRunScoped(db: DbClient, projectId: string, runId: string): Promise<CrawlRun | null> {
  return db.crawlRun.findFirst({ where: { id: runId, projectId } });
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
  const result = await db.crawlRun.updateMany({
    where: {
      id: runId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: { status: "RUNNING", leaseToken: { increment: 1 }, leaseExpiresAt: new Date(now.getTime() + leaseMs) },
  });
  if (result.count !== 1) return null;
  const run = await db.crawlRun.findUniqueOrThrow({ where: { id: runId }, select: { leaseToken: true } });
  return run.leaseToken;
}

/** Fenced write: only the current lease holder may mutate run state. */
export async function withRunFence<T>(
  db: PrismaClient,
  runId: string,
  leaseToken: number,
  fn: (tx: DbClient) => Promise<T>,
): Promise<T | null> {
  return db.$transaction(async (tx) => {
    const run = await tx.crawlRun.findUnique({ where: { id: runId }, select: { leaseToken: true, status: true } });
    if (!run || run.leaseToken !== leaseToken) return null;
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
    where: { id: runId, leaseToken },
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

export async function claimNextFrontierItem(db: PrismaClient, runId: string, now: Date): Promise<CrawlFrontier | null> {
  return db.$transaction(async (tx) => {
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
  });
}

export async function resetStaleFrontier(db: PrismaClient, runId: string, now: Date): Promise<number> {
  const result = await db.crawlFrontier.updateMany({
    where: { runId, state: "FETCHING" },
    data: { state: "PENDING", nextAttemptAt: now },
  });
  return result.count;
}

export interface UpsertObservationInput {
  runId: string;
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
  return db.$transaction(async (tx) => {
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
  });
}

export async function countObservations(db: DbClient, runId: string): Promise<number> {
  return db.pageObservation.count({ where: { runId } });
}
