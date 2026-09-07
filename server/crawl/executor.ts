import type { CrawlCompleteness, CrawlRunStatus, PrismaClient } from "@seo/db";
import type { SafeFetchResult } from "@seo/crawler";
import {
  extractPage,
  isAllowedByRobots,
  isHtmlContentType,
  normalizeUrl,
  parseRobots,
  parseSitemap,
  synthesizeIndexState,
} from "@seo/crawler";
import type { ParsedRobots } from "@seo/crawler";
import {
  acquireLease,
  addFrontierUrl,
  claimNextFrontierItem,
  countFrontier,
  countObservations,
  renewLease,
  resetStaleFrontier,
  saveObservation,
  withRunFence,
} from "../repositories/crawls.ts";
import type { UpsertObservationInput } from "../repositories/crawls.ts";
import { publishRun } from "./publisher.ts";

/**
 * Crawl executor (docs/ARCHITECTURE.md §7): robots policy → seeds (entry,
 * sitemaps, monitored pages) → frontier loop with budgets, rate pacing, lease
 * fencing, and cooperative cancellation. Publishing (events, issues,
 * baselines) arrives in P3 — completed runs stay unpublished.
 */

export interface CrawlDependencies {
  fetcher: (url: string) => Promise<SafeFetchResult>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface ExecutorOutcome {
  status: CrawlRunStatus;
  completeness: CrawlCompleteness;
  failureCode: string | null;
  pages: number;
}

const LEASE_MS = 60_000;
const MAX_PAGE_RETRIES = 2;
const RETRY_BACKOFF_MS = 5_000;
const ROBOTS_RETRY_DELAY_MS = 2_000;

interface PolicyConfig {
  maxPages: number;
  maxFrontierUrls: number;
  crawlMaxDurationMinutes: number;
  totalBodyBudgetBytes: number;
  hostRateRequestsPerSecond: number;
}

interface RunContext {
  runId: string;
  projectId: string;
  hostname: string;
  origin: string;
  identityVersion: number;
  policy: PolicyConfig;
}

interface CrawlFlags {
  unrecovered: boolean;
  limitReached: boolean;
  securityBlocked: boolean;
  bodyBudgetExceeded: boolean;
  cancelled: boolean;
}

export async function executeCrawl(db: PrismaClient, runId: string, deps: CrawlDependencies): Promise<ExecutorOutcome> {
  const run = await db.crawlRun.findUnique({
    where: { id: runId },
    include: { project: { include: { currentPolicy: true } } },
  });
  if (!run) return { status: "FAILED", completeness: "NONE", failureCode: "RUN_NOT_FOUND", pages: 0 };
  if (run.status === "COMPLETED" || run.status === "CANCELLED" || run.status === "FAILED") {
    return { status: run.status, completeness: run.completeness, failureCode: run.failureCode, pages: run.pagesDone };
  }

  const leaseToken = await acquireLease(db, runId, LEASE_MS, deps.now());
  if (leaseToken === null) {
    // Another live worker holds the lease; the Outbox event retries later.
    throw new Error("lease unavailable: another worker holds this run");
  }
  await resetStaleFrontier(db, runId, deps.now());

  const config = (run.project.currentPolicy?.config ?? {}) as Record<string, unknown>;
  const ctx: RunContext = {
    runId,
    projectId: run.projectId,
    hostname: run.project.hostname,
    origin: `https://${run.project.hostname}`,
    identityVersion: run.project.currentPolicy?.identityVersion ?? 1,
    policy: {
      maxPages: numberFromPolicy(config, "maxPages", 5000),
      maxFrontierUrls: numberFromPolicy(config, "maxFrontierUrls", 20000),
      crawlMaxDurationMinutes: numberFromPolicy(config, "crawlMaxDurationMinutes", 120),
      totalBodyBudgetBytes: numberFromPolicy(config, "totalBodyBudgetBytes", 524288000),
      hostRateRequestsPerSecond: numberFromPolicy(config, "hostRateRequestsPerSecond", 1),
    },
  };

  const flags: CrawlFlags = {
    unrecovered: false,
    limitReached: false,
    securityBlocked: false,
    bodyBudgetExceeded: false,
    cancelled: false,
  };
  const state = { bytes: 0, pages: 0, nextRequestAt: 0 };

  // ---- robots.txt policy (conservative matrix, docs §7.3) ----
  // HTTPS is tried first; only a network-level failure falls back to HTTP:80
  // (same hostname) for sites without TLS. Authoritative answers (401/403)
  // deny without fallback.
  const robots = await acquireRobotsPolicy(db, ctx, deps, leaseToken, state);
  if (robots.kind === "DENIED") {
    return finalize(db, ctx, deps, leaseToken, flags, state, { status: "FAILED", failureCode: "ROBOTS_DENIED" });
  }
  if (robots.kind === "UNAVAILABLE") {
    return finalize(db, ctx, deps, leaseToken, flags, state, { status: "FAILED", failureCode: "ROBOTS_UNAVAILABLE" });
  }
  const rules = robots.rules;
  ctx.origin = robots.origin;

  // ---- seeds ----
  const frontierCount = async () => countFrontier(db, runId);
  await addCapped(db, ctx, { runId, identityUrl: normalizeUrl(ctx.origin), depth: 0, source: "SEED" }, frontierCount);
  for (const page of await db.page.findMany({ where: { projectId: ctx.projectId }, select: { identityUrl: true } })) {
    await addCapped(db, ctx, { runId, identityUrl: page.identityUrl, depth: 0, source: "MONITORED" }, frontierCount);
  }

  // ---- sitemap seeds ----
  const sitemapSources = [...new Set([...(rules?.sitemaps ?? []), `${ctx.origin}/sitemap.xml`])];
  const candidates = await collectSitemapSeeds(db, ctx, deps, leaseToken, state, sitemapSources, flags);
  for (const candidate of candidates) {
    await addCapped(db, ctx, { runId, identityUrl: candidate, depth: 0, source: "SITEMAP" }, frontierCount);
  }

  // ---- frontier loop ----
  const deadline = ctx.policy.crawlMaxDurationMinutes * 60_000;
  const startedAt = deps.now().getTime();

  for (;;) {
    if (state.pages >= ctx.policy.maxPages) {
      flags.limitReached = true;
      break;
    }
    if (state.bytes >= ctx.policy.totalBodyBudgetBytes) {
      flags.bodyBudgetExceeded = true;
      break;
    }
    if (deps.now().getTime() - startedAt >= deadline) {
      flags.limitReached = true;
      break;
    }

    const lease = await db.crawlRun.findUnique({
      where: { id: runId },
      select: { status: true, cancelRequestedAt: true, leaseToken: true },
    });
    if (!lease || lease.leaseToken !== leaseToken) {
      return { status: "CANCELLED", completeness: "NONE", failureCode: "FENCED_OUT", pages: state.pages };
    }
    if (lease.status === "CANCELLED") {
      flags.cancelled = true;
      break;
    }
    if (lease.cancelRequestedAt) {
      flags.cancelled = true;
      break;
    }
    await renewLease(db, runId, leaseToken, LEASE_MS, deps.now());

    const item = await claimNextFrontierItem(db, runId, deps.now());
    if (!item) {
      // Frontier has no due item: wait for the earliest retry instead of quitting.
      const waiting = await db.crawlFrontier.findFirst({
        where: { runId, state: "PENDING" },
        orderBy: [{ nextAttemptAt: "asc" }],
      });
      if (waiting && waiting.nextAttemptAt.getTime() <= startedAt + deadline) {
        await deps.sleep(Math.max(0, waiting.nextAttemptAt.getTime() - deps.now().getTime()));
        continue;
      }
      break;
    }

    // Rate pacing: hostname-global budget (single-hostname projects).
    const waitMs = state.nextRequestAt - deps.now().getTime();
    if (waitMs > 0) await deps.sleep(waitMs);
    state.nextRequestAt = deps.now().getTime() + 1000 / ctx.policy.hostRateRequestsPerSecond;

    let target: URL;
    try {
      target = new URL(item.requestUrl);
    } catch {
      await markFrontierDone(db, item.id);
      continue;
    }
    if (rules && !isAllowedByRobots(rules, "IndexlyBot", target)) {
      await saveObservation(db, {
        runId,
        projectId: ctx.projectId,
        identityVersion: ctx.identityVersion,
        identityUrl: item.requestUrl,
        fetchOutcome: "ROBOTS_BLOCKED",
        requestUrl: item.requestUrl,
        failureCode: "ROBOTS_DISALLOWED",
        fieldValidity: unknownHtmlFields(),
        fetchedAt: deps.now(),
      });
      await markFrontierDone(db, item.id);
      state.pages += 1;
      continue;
    }

    const result = await deps.fetcher(item.requestUrl);
    if (result.body) state.bytes += result.body.byteLength;

    if (result.outcome === "NETWORK_ERROR" || result.outcome === "TIMEOUT") {
      const attempts = item.attempts + 1;
      if (attempts <= MAX_PAGE_RETRIES) {
        await db.crawlFrontier.update({
          where: { id: item.id },
          data: {
            state: "PENDING",
            attempts,
            nextAttemptAt: new Date(deps.now().getTime() + RETRY_BACKOFF_MS * attempts),
          },
        });
        continue;
      }
      flags.unrecovered = true;
      await saveObservation(
        db,
        baseObservation(ctx, item.requestUrl, result, deps.now(), { failureCode: result.outcome }),
      );
      await markFrontierDone(db, item.id);
      state.pages += 1;
      continue;
    }

    if (result.outcome === "SECURITY_BLOCKED") flags.securityBlocked = true;
    if (result.outcome === "BODY_TOO_LARGE") flags.unrecovered = true;

    if (result.outcome === "HTTP_RESPONSE") {
      // Redirect sources never inherit the target's content (docs §6): only
      // direct 2xx HTML responses participate in extraction and discovery.
      const html =
        isHtmlContentType(result.contentType) &&
        (result.finalStatus ?? 0) >= 200 &&
        (result.finalStatus ?? 0) < 300 &&
        result.redirectChain.length === 0 &&
        result.body !== null;
      const text = html && result.body ? new TextDecoder("utf-8", { fatal: false }).decode(result.body) : "";
      const extracted = html ? extractPage(text, result.finalUrl ?? item.requestUrl) : null;

      const observation: UpsertObservationInput = baseObservation(ctx, item.requestUrl, result, deps.now(), {});
      if (extracted !== null) {
        const robotsSources = [...extracted.robotsRaw];
        if (result.xRobotsTag) robotsSources.push(result.xRobotsTag);
        observation.title = extracted.title;
        observation.metaDescription = extracted.metaDescription;
        observation.canonical = {
          raw: extracted.canonicalRaw,
          resolved: extracted.canonicalResolved,
          validity: "KNOWN",
        };
        // A fetched HTML page with no robots directives is decisively allowed
        // (Googlebot semantics); UNKNOWN is reserved for unobservable pages.
        observation.robots = {
          raw: robotsSources,
          index: robotsSources.length === 0 ? "ALLOWED" : synthesizeIndexState(robotsSources),
        };
        observation.internalLinksCount = extracted.internalLinks.length;
        observation.fieldValidity = {
          title: "KNOWN",
          metaDescription: "KNOWN",
          canonical: "KNOWN",
          robots: "KNOWN",
          internalLinksCount: "KNOWN",
        };

        // Link discovery within scope and frontier budget.
        for (const link of extracted.internalLinks) {
          await addCapped(db, ctx, { runId, identityUrl: link, depth: item.depth + 1, source: "LINK" }, frontierCount);
        }
      } else {
        observation.fieldValidity = notApplicableHtmlFields();
      }
      await saveObservation(db, observation);

      // Redirect chains end at an in-scope identity that deserves its own observation (docs §6).
      if (result.redirectChain.length > 0 && result.finalUrl) {
        try {
          await addCapped(
            db,
            ctx,
            { runId, identityUrl: normalizeUrl(result.finalUrl), depth: item.depth, source: "REDIRECT" },
            frontierCount,
          );
        } catch {
          /* invalid final URL: chain is already recorded */
        }
      }
    } else {
      await saveObservation(
        db,
        baseObservation(ctx, item.requestUrl, result, deps.now(), { failureCode: result.outcome }),
      );
    }

    await markFrontierDone(db, item.id);
    state.pages += 1;
  }

  return finalize(db, ctx, deps, leaseToken, flags, state, null);
}

async function addCapped(
  db: PrismaClient,
  ctx: RunContext,
  input: {
    runId: string;
    identityUrl: string;
    depth: number;
    source: "SEED" | "SITEMAP" | "LINK" | "REDIRECT" | "MONITORED";
  },
  frontierCount: () => Promise<number>,
): Promise<boolean> {
  try {
    new URL(input.identityUrl);
  } catch {
    return false;
  }
  if (input.identityUrl.length > 8192) return false;
  const current = await frontierCount();
  if (current >= ctx.policy.maxFrontierUrls) return false;
  return addFrontierUrl(db, input);
}

async function markFrontierDone(db: PrismaClient, frontierId: string): Promise<void> {
  await db.crawlFrontier.update({ where: { id: frontierId }, data: { state: "DONE" } });
}

function baseObservation(
  ctx: RunContext,
  requestUrl: string,
  result: SafeFetchResult,
  fetchedAt: Date,
  extra: { failureCode?: string },
): UpsertObservationInput {
  const htmlOutcome = result.outcome === "HTTP_RESPONSE";
  return {
    runId: ctx.runId,
    projectId: ctx.projectId,
    identityVersion: ctx.identityVersion,
    identityUrl: requestUrl,
    fetchOutcome: result.outcome,
    requestUrl,
    finalUrl: result.finalUrl,
    initialStatus: result.initialStatus,
    finalStatus: result.finalStatus,
    redirectChain: result.redirectChain,
    contentType: result.contentType,
    failureCode: extra.failureCode ?? result.error,
    fieldValidity: htmlOutcome ? notApplicableHtmlFields() : unknownHtmlFields(),
    fetchedAt,
  };
}

function unknownHtmlFields(): Record<string, string> {
  return {
    title: "UNKNOWN",
    metaDescription: "UNKNOWN",
    canonical: "UNKNOWN",
    robots: "UNKNOWN",
    internalLinksCount: "UNKNOWN",
  };
}

function notApplicableHtmlFields(): Record<string, string> {
  return {
    title: "NOT_APPLICABLE",
    metaDescription: "NOT_APPLICABLE",
    canonical: "NOT_APPLICABLE",
    robots: "NOT_APPLICABLE",
    internalLinksCount: "NOT_APPLICABLE",
  };
}

type RobotsPolicy =
  | { kind: "OK"; rules: ParsedRobots | null; origin: string }
  | { kind: "DENIED"; origin: string }
  | { kind: "UNAVAILABLE"; origin: string };

async function acquireRobotsPolicy(
  db: PrismaClient,
  ctx: RunContext,
  deps: CrawlDependencies,
  leaseToken: number,
  state: { bytes: number; pages: number; nextRequestAt: number },
): Promise<RobotsPolicy> {
  const httpsOrigin = `https://${ctx.hostname}`;
  const httpOrigin = `http://${ctx.hostname}`;
  // Try HTTPS first, then fall back to HTTP:80 (same hostname) only when the
  // HTTPS attempt failed at the network level — a site answering over TLS
  // never gets re-asked over plain HTTP.
  const attemptOrigin = async (origin: string, allowRetry: boolean): Promise<RobotsPolicy | null> => {
    for (let attempt = 1; attempt <= (allowRetry ? 3 : 1); attempt += 1) {
      if (!(await renewLease(db, ctx.runId, leaseToken, LEASE_MS, deps.now()))) {
        throw new Error("lost lease during robots acquisition");
      }
      const waitMs = state.nextRequestAt - deps.now().getTime();
      if (waitMs > 0) await deps.sleep(waitMs);
      state.nextRequestAt = deps.now().getTime() + 1000 / ctx.policy.hostRateRequestsPerSecond;

      const result = await deps.fetcher(`${origin}/robots.txt`);
      if (result.body) state.bytes += result.body.byteLength;

      if (result.outcome === "HTTP_RESPONSE") {
        const status = result.finalStatus ?? 0;
        if (status === 200 && result.body) {
          return { kind: "OK", rules: parseRobots(new TextDecoder().decode(result.body)), origin };
        }
        // A 404/410 over HTTPS is ambiguous on http-only sites (the TLS
        // listener may answer before the real HTTP server), so it triggers
        // the plain-HTTP probe. Only an HTTP 404/410 is authoritative.
        if (origin.startsWith("http:") && (status === 404 || status === 410)) {
          return { kind: "OK", rules: null, origin }; // no robots → unrestricted
        }
        if (status === 401 || status === 403) return { kind: "DENIED", origin }; // conservative refusal, no fallback
        // 429/5xx fall through to retry.
      }
      if (attempt < (allowRetry ? 3 : 1)) await deps.sleep(ROBOTS_RETRY_DELAY_MS);
    }
    return null; // network-level failure (or retries exhausted) → caller decides
  };

  const viaHttps = await attemptOrigin(httpsOrigin, true);
  if (viaHttps !== null) return viaHttps;

  const viaHttp = await attemptOrigin(httpOrigin, false);
  if (viaHttp !== null) return viaHttp;

  return { kind: "UNAVAILABLE", origin: httpsOrigin };
}

async function collectSitemapSeeds(
  db: PrismaClient,
  ctx: RunContext,
  deps: CrawlDependencies,
  leaseToken: number,
  state: { bytes: number; pages: number; nextRequestAt: number },
  sources: string[],
  flags: CrawlFlags,
): Promise<string[]> {
  const queue = [...sources];
  const seenDocuments = new Set<string>();
  const candidates = new Set<string>();
  const MAX_DOCS = 20;
  const MAX_CANDIDATES = 20000;

  while (queue.length > 0 && seenDocuments.size < MAX_DOCS && candidates.size < MAX_CANDIDATES) {
    if (!(await renewLease(db, ctx.runId, leaseToken, LEASE_MS, deps.now()))) {
      throw new Error("lost lease during sitemap discovery");
    }
    const url = queue.shift();
    if (!url || seenDocuments.has(url)) continue;
    seenDocuments.add(url);

    const waitMs = state.nextRequestAt - deps.now().getTime();
    if (waitMs > 0) await deps.sleep(waitMs);
    state.nextRequestAt = deps.now().getTime() + 1000 / ctx.policy.hostRateRequestsPerSecond;

    const result = await deps.fetcher(url);
    if (result.body) state.bytes += result.body.byteLength;
    if (result.outcome !== "HTTP_RESPONSE" || (result.finalStatus ?? 0) !== 200 || result.body === null) continue;

    const parsed = parseSitemap(new TextDecoder().decode(result.body));
    if (parsed.kind === "URLSET") {
      for (const loc of parsed.pageUrls) {
        if (candidates.size >= MAX_CANDIDATES) {
          flags.limitReached = true;
          break;
        }
        const identity = sameHostIdentity(loc, ctx.hostname);
        if (identity) candidates.add(identity);
      }
    } else if (parsed.kind === "INDEX") {
      for (const child of parsed.sitemapUrls) {
        if (seenDocuments.size + queue.length < MAX_DOCS) queue.push(child);
      }
    }
  }
  if (queue.length > 0 && seenDocuments.size >= MAX_DOCS) flags.limitReached = true;
  return [...candidates];
}

function sameHostIdentity(raw: string, hostname: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname.toLowerCase() !== hostname) return null;
    return normalizeUrl(url.toString());
  } catch {
    return null;
  }
}

async function finalize(
  db: PrismaClient,
  ctx: RunContext,
  deps: CrawlDependencies,
  leaseToken: number,
  flags: CrawlFlags,
  state: { bytes: number; pages: number; nextRequestAt: number },
  forced: { status: "FAILED"; failureCode: string } | null,
): Promise<ExecutorOutcome> {
  const observations = await countObservations(db, ctx.runId);

  const isFullCandidate =
    forced === null &&
    !flags.cancelled &&
    observations > 0 &&
    !flags.securityBlocked &&
    !flags.bodyBudgetExceeded &&
    !flags.unrecovered &&
    !flags.limitReached;

  // FULL path: freeze observations (FINALIZING), then publish atomically
  // behind the lease fence (docs/ARCHITECTURE.md §8). A crash between the
  // two steps re-enters via the Outbox retry and publishes idempotently.
  if (isFullCandidate) {
    const marked = await withRunFence(db, ctx.runId, leaseToken, async (tx) => {
      await tx.crawlRun.update({
        where: { id: ctx.runId },
        data: { status: "FINALIZING", bytesDownloaded: state.bytes, pagesDone: state.pages },
      });
      return true;
    });
    if (marked === null) {
      return { status: "CANCELLED", completeness: "NONE", failureCode: "FENCED_OUT", pages: state.pages };
    }
    const published = await publishRun(db, { runId: ctx.runId, projectId: ctx.projectId, leaseToken }, deps.now());
    if (!published.published) {
      return { status: "CANCELLED", completeness: "NONE", failureCode: "FENCED_OUT", pages: state.pages };
    }
    return { status: "COMPLETED", completeness: "FULL", failureCode: null, pages: state.pages };
  }

  const outcome = await withRunFence(db, ctx.runId, leaseToken, async (tx) => {
    let status: CrawlRunStatus;
    let completeness: CrawlCompleteness;
    let failureCode: string | null = null;

    if (forced) {
      status = forced.status;
      completeness = "NONE";
      failureCode = forced.failureCode;
    } else if (flags.cancelled) {
      status = "CANCELLED";
      completeness = "NONE";
    } else if (observations === 0) {
      status = "FAILED";
      completeness = "NONE";
      failureCode = "NO_OBSERVATIONS";
    } else if (flags.securityBlocked) {
      status = "COMPLETED";
      completeness = "PARTIAL";
      failureCode = "SECURITY_BLOCKED";
    } else if (flags.bodyBudgetExceeded) {
      status = "COMPLETED";
      completeness = "PARTIAL";
      failureCode = "BODY_BUDGET_EXCEEDED";
    } else if (flags.unrecovered || flags.limitReached) {
      status = "COMPLETED";
      completeness = "PARTIAL";
      failureCode = flags.limitReached ? "LIMIT_REACHED" : "UNRECOVERED_FETCH_ERRORS";
    } else {
      status = "COMPLETED";
      completeness = "FULL";
    }

    await tx.crawlRun.update({
      where: { id: ctx.runId },
      data: {
        status,
        completeness,
        failureCode,
        finishedAt: deps.now(),
        leaseExpiresAt: null,
        bytesDownloaded: state.bytes,
        pagesDone: state.pages,
      },
    });
    return { status, completeness, failureCode };
  });

  if (outcome === null) {
    return { status: "CANCELLED", completeness: "NONE", failureCode: "FENCED_OUT", pages: state.pages };
  }
  return { ...outcome, pages: state.pages };
}

function numberFromPolicy(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" && value > 0 ? value : fallback;
}
