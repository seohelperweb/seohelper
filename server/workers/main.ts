import { Resolver } from "node:dns/promises";
import { getDb } from "@seo/db";
import type { DbClient } from "@seo/db";
import type { ClaimedEvent } from "../repositories/outbox.ts";
import {
  claimBatch,
  CRAWL_REQUESTED,
  markDelivered,
  reschedule,
  VERIFICATION_REQUESTED,
} from "../repositories/outbox.ts";
import { getConfig } from "../config.ts";
import { executeCrawl } from "../crawl/executor.ts";
import { createProductionFetcher } from "../crawl/fetcher.ts";
import { processDueSchedules } from "../schedule/schedule-service.ts";
import { cleanupRunDetails } from "../maintenance/cleanup.ts";
import { processVerificationJob, type TxtResolver } from "../services/verification-runner.ts";

/**
 * P1/P2 worker: polls the Outbox for verification and crawl jobs. The queue
 * adapter (direct Outbox polling with SKIP LOCKED claims and leases) can be
 * swapped for pg-boss without touching executor semantics
 * (docs/ARCHITECTURE.md §7).
 */

const POLL_INTERVAL_MS = 3_000;
const BATCH_LIMIT = 5;
const LEASE_MS = 30_000;
const CRAWL_RETRY_DELAY_MS = 90_000;
const MAX_CRAWL_DELIVERIES = 5;

const dnsResolver = new Resolver();
const txtResolver: TxtResolver = (hostname) => dnsResolver.resolveTxt(hostname);
const realSleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};
const realNow = () => new Date();

async function processCrawlJob(db: DbClient, event: ClaimedEvent): Promise<void> {
  const payload = event.payload as { projectId: string; crawlId: string };
  const project = await db.project.findUnique({
    where: { id: payload.projectId },
    include: { currentPolicy: true },
  });
  if (!project) {
    await markDelivered(db, event.id, event.claimToken);
    return;
  }
  if (event.attempts > MAX_CRAWL_DELIVERIES) {
    // Repeated failures with no live lease: converge to a terminal state.
    await db.crawlRun.updateMany({
      where: {
        id: payload.crawlId,
        status: { in: ["QUEUED", "RUNNING"] },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: realNow() } }],
      },
      data: { status: "FAILED", failureCode: "WORKER_EXHAUSTED", finishedAt: realNow(), leaseExpiresAt: null },
    });
    await markDelivered(db, event.id, event.claimToken);
    return;
  }
  try {
    // Wire the immutable policy into the fetcher (docs/ARCHITECTURE.md §7.3):
    // per-request limits live in ProjectPolicy.config, the user agent in the
    // environment; both fall back to safe defaults when absent.
    const policyConfig = (project.currentPolicy?.config ?? {}) as Record<string, unknown>;
    const policyNumber = (key: string): number | undefined => {
      const value = policyConfig[key];
      return typeof value === "number" && value > 0 ? value : undefined;
    };
    const userAgent = getConfig().crawlerUserAgent ?? "IndexlyBot/0.1";
    const outcome = await executeCrawl(getDb(), payload.crawlId, {
      fetcher: createProductionFetcher(project.hostname, userAgent, {
        requestTimeoutMs: policyNumber("requestTimeoutMs"),
        maxRedirects: policyNumber("maxRedirects"),
        maxBodyBytes: policyNumber("maxBodyBytes"),
      }),
      now: realNow,
      sleep: realSleep,
    });
    console.log(
      `[worker] crawl ${payload.crawlId} → ${outcome.status}/${outcome.completeness} (${outcome.pages} pages)`,
    );
    await markDelivered(db, event.id, event.claimToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`[worker] crawl ${payload.crawlId} attempt ${event.attempts} failed: ${message}`);
    // Lease contention and transient errors both retry after the lease window.
    await reschedule(db, event.id, event.claimToken, CRAWL_RETRY_DELAY_MS);
  }
}

async function tick(): Promise<number> {
  const db = getDb();
  const verificationEvents = await claimBatch(db, {
    type: VERIFICATION_REQUESTED,
    limit: BATCH_LIMIT,
    leaseMs: LEASE_MS,
  });
  for (const event of verificationEvents) {
    try {
      const outcome = await processVerificationJob(db, event, txtResolver);
      console.log(`[worker] verification ${event.aggregateId} → ${outcome}`);
    } catch (error) {
      console.error(`[worker] verification ${event.aggregateId} failed:`, error);
    }
  }

  const crawlEvents = await claimBatch(db, { type: CRAWL_REQUESTED, limit: 1, leaseMs: LEASE_MS });
  for (const event of crawlEvents) {
    await processCrawlJob(db, event);
  }
  return verificationEvents.length + crawlEvents.length;
}

const SCHEDULE_SCAN_INTERVAL_MS = 30_000;
const CLEANUP_INTERVAL_MS = 10 * 60_000;

/** Maintenance side loops: due schedules every 30s, retention every 10 minutes. */
async function runMaintenanceLoops(): Promise<void> {
  let lastScheduleScan = 0;
  let lastCleanup = 0;
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (running) {
    const now = Date.now();
    try {
      if (now - lastScheduleScan >= SCHEDULE_SCAN_INTERVAL_MS) {
        lastScheduleScan = now;
        const scan = await processDueSchedules(getDb());
        if (scan.triggered + scan.missedSlots + scan.skippedBusy + scan.skippedUnverified + scan.skippedArchived > 0) {
          console.log(`[worker] schedule scan: ${JSON.stringify(scan)}`);
        }
      }
      if (now - lastCleanup >= CLEANUP_INTERVAL_MS) {
        lastCleanup = now;
        const cleanup = await cleanupRunDetails(getDb());
        if (cleanup.runsPruned > 0) {
          console.log(`[worker] retention cleanup: ${JSON.stringify(cleanup)}`);
        }
      }
    } catch (error) {
      console.error("[worker] maintenance loop failed:", error);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function main() {
  const config = getConfig();
  if (!config.databaseUrl) {
    console.error("[worker] DATABASE_URL is required. Start the local database (npm run db:up) and set .env.");
    process.exit(1);
  }
  console.log(`[worker] starting (env=${config.appEnv}, log=${config.logLevel})`);
  let running = true;
  const stop = () => {
    if (!running) return;
    running = false;
    console.log("[worker] shutting down…");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  void runMaintenanceLoops();
  while (running) {
    try {
      await tick();
    } catch (error) {
      console.error("[worker] tick failed:", error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  await getDb().$disconnect();
}

main().catch((error) => {
  console.error("[worker] fatal:", error);
  process.exit(1);
});
