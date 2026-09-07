import test from "node:test";
import assert from "node:assert/strict";
import { before } from "node:test";
import { safeFetch } from "@seo/crawler";
import type { DnsResolver, SafeFetchResult, Transport } from "@seo/crawler";
import { actor, cleanDatabase, createWorkspaceWithOwner, createUser, db, uniqueId } from "./helpers.ts";
import { ApiError } from "../../server/api/errors.ts";
import { executeCrawl } from "../../server/crawl/executor.ts";
import type { CrawlDependencies } from "../../server/crawl/executor.ts";
import { cancelCrawl, createCrawl } from "../../server/services/crawl-service.ts";
import { createProject, requestVerification } from "../../server/services/project-service.ts";
import { processVerificationJob } from "../../server/services/verification-runner.ts";
import { claimBatch, VERIFICATION_REQUESTED } from "../../server/repositories/outbox.ts";

const HOSTNAME = `site-${uniqueId()}.test`;

// ---------------------------------------------------------------------------
// Synthetic site served through the REAL safeFetch pipeline (fake DNS + fake
// transport) — the production safety path is fully exercised.
// ---------------------------------------------------------------------------

type SiteEntry = { status: number; location?: string; body?: string; contentType?: string };

const SITE: Record<string, SiteEntry> = {};

function resetSite(): void {
  const urlset = (paths: string[]) =>
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
      .map((p) => `<url><loc>https://${HOSTNAME}${p}</loc></url>`)
      .join("")}</urlset>`;

  for (const key of Object.keys(SITE)) delete SITE[key];
  SITE[`https://${HOSTNAME}/robots.txt`] = {
    status: 200,
    contentType: "text/plain",
    body: `User-agent: *\nDisallow: /blocked-by-robots\nSitemap: https://${HOSTNAME}/sitemap.xml\n`,
  };
  SITE[`https://${HOSTNAME}/sitemap.xml`] = {
    status: 200,
    contentType: "application/xml",
    body: urlset(["/a", "/b", "/noindex-page", "/redirect", "/missing", "/blocked-by-robots", "/pdf"]),
  };
  SITE[`https://${HOSTNAME}/`] = {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: `<html><head><title>Home</title></head><body><a href="/a">A</a><a href="https://cdn.${HOSTNAME}/x">Ext</a></body></html>`,
  };
  SITE[`https://${HOSTNAME}/a`] = {
    status: 200,
    contentType: "text/html",
    body: `<html><head><title>Page A</title><link rel="canonical" href="https://${HOSTNAME}/a"><meta name="robots" content="index,follow"></head><body><a href="/b">B</a></body></html>`,
  };
  SITE[`https://${HOSTNAME}/b`] = {
    status: 200,
    contentType: "text/html",
    body: `<html><head><title>Page B</title><meta name="robots" content="noindex"></head><body></body></html>`,
  };
  SITE[`https://${HOSTNAME}/noindex-page`] = {
    status: 200,
    contentType: "text/html",
    body: `<html><head><title>N</title><meta name="robots" content="noindex"></head></html>`,
  };
  SITE[`https://${HOSTNAME}/redirect`] = { status: 301, location: `https://${HOSTNAME}/a` };
  SITE[`https://${HOSTNAME}/missing`] = {
    status: 404,
    contentType: "text/html",
    body: `<html><head><title>404</title></head></html>`,
  };
  SITE[`https://${HOSTNAME}/pdf`] = { status: 200, contentType: "application/pdf" };
}

const recordedFetches: string[] = [];

function siteFetcher(): (url: string) => Promise<SafeFetchResult> {
  const dns: DnsResolver = async () => ["93.184.216.34"];
  const transport: Transport = async (request) => {
    const key = request.url.toString();
    recordedFetches.push(key);
    const entry = SITE[key] ?? { status: 404, contentType: "text/plain" };
    const headers: Record<string, string> = { "content-type": entry.contentType ?? "text/html" };
    if (entry.location) headers.location = entry.location;
    const body = entry.body ?? "";
    return {
      status: entry.status,
      headers,
      body: (async function* () {
        yield new TextEncoder().encode(body);
      })(),
    };
  };
  return (url) => safeFetch(url, { resolveDns: dns, transport, allowedHostname: HOSTNAME, userAgent: "IndexlyBot" });
}

/** Deterministic clock: sleep advances a controllable offset. */
function fakeClock(): { deps: Omit<CrawlDependencies, "fetcher">; advance(ms: number): void } {
  let offset = 0;
  return {
    deps: {
      now: () => new Date(Date.now() + offset),
      sleep: async (ms) => {
        offset += ms;
      },
    },
    advance: (ms) => {
      offset += ms;
    },
  };
}

interface Setup {
  workspaceId: string;
  owner: { id: string; email: string; emailVerified: boolean };
  projectId: string;
}

async function setupVerifiedProject(): Promise<Setup> {
  const client = db();
  const owner = await createUser(client);
  const workspaceId = await createWorkspaceWithOwner(client, owner, "Crawl WS");
  const project = await createProject(client, actor(owner.id, workspaceId, "OWNER"), { hostname: HOSTNAME });

  const request = await requestVerification(client, actor(owner.id, workspaceId, "OWNER"), project.id);
  const events = await claimBatch(client, { type: VERIFICATION_REQUESTED, limit: 5, leaseMs: 30_000 });
  assert.equal(events.length, 1);
  await processVerificationJob(client, events[0], async () => [[request.recordValue]]);
  return { workspaceId, owner, projectId: project.id };
}

before(async () => {
  await cleanDatabase(db());
});

test("crawl creation is guarded, idempotent, and single-active", async () => {
  const client = db();
  const { workspaceId, owner, projectId } = await setupVerifiedProject();

  // Unverified second project cannot start a crawl.
  const other = await createProject(client, actor(owner.id, workspaceId, "OWNER"), {
    hostname: `unverified-${uniqueId()}.test`,
  });
  await assert.rejects(
    createCrawl(client, actor(owner.id, workspaceId, "OWNER"), other.id, "key-unverified"),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "VERIFICATION_REQUIRED");
      return true;
    },
  );

  // Viewer role cannot create crawls.
  const viewer = await createUser(client);
  await client.membership.create({ data: { workspaceId, userId: viewer.id, role: "VIEWER" } });
  await assert.rejects(createCrawl(client, actor(viewer.id, workspaceId, "VIEWER"), projectId, "key-viewer"), ApiError);

  const first = await createCrawl(client, actor(owner.id, workspaceId, "OWNER"), projectId, "idem-1");
  assert.equal(first.status, "QUEUED");
  const replay = await createCrawl(client, actor(owner.id, workspaceId, "OWNER"), projectId, "idem-1");
  assert.equal(replay.replay, true);
  assert.equal(replay.crawlId, first.crawlId);
  assert.equal(await client.crawlRun.count({ where: { projectId } }), 1);

  await assert.rejects(
    createCrawl(client, actor(owner.id, workspaceId, "OWNER"), projectId, "idem-2"),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "CRAWL_ALREADY_ACTIVE");
      return true;
    },
  );
  await client.crawlRun.update({ where: { id: first.crawlId }, data: { status: "CANCELLED", finishedAt: new Date() } });
});

test("a full crawl observes pages, redirects, 404s, robots blocks, and stays scoped", async () => {
  const client = db();
  resetSite();
  recordedFetches.length = 0;
  const { workspaceId, owner, projectId } = await setupVerifiedProject();
  const created = await createCrawl(client, actor(owner.id, workspaceId, "OWNER"), projectId, "run-full");
  const clock = fakeClock();

  const outcome = await executeCrawl(client, created.crawlId, { fetcher: siteFetcher(), ...clock.deps });
  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.completeness, "FULL");
  assert.equal(outcome.failureCode, null);

  const observations = await client.pageObservation.findMany({
    where: { runId: created.crawlId },
    include: { page: true },
  });
  const byUrl = new Map(observations.map((o) => [o.page.identityUrl, o]));

  const home = byUrl.get(`https://${HOSTNAME}/`);
  assert.ok(home, "home observed");
  assert.equal(home?.title, "Home");

  const pageA = byUrl.get(`https://${HOSTNAME}/a`);
  assert.ok(pageA);
  assert.equal(pageA?.title, "Page A");
  const robots = pageA?.robots as { raw: string[]; index: string } | null;
  assert.equal(robots?.index, "ALLOWED");

  const pageB = byUrl.get(`https://${HOSTNAME}/b`);
  assert.ok(pageB);
  assert.equal((pageB?.robots as { index: string } | null)?.index, "DISALLOWED");

  // Redirect source: own observation, chain kept, target content NOT backfilled.
  const redirect = byUrl.get(`https://${HOSTNAME}/redirect`);
  assert.ok(redirect);
  assert.equal(redirect?.initialStatus, 301);
  assert.equal(redirect?.finalStatus, 200);
  assert.equal(redirect?.title, null);
  const validity = redirect?.fieldValidity as Record<string, string>;
  assert.equal(validity?.title, "NOT_APPLICABLE");

  const missing = byUrl.get(`https://${HOSTNAME}/missing`);
  assert.ok(missing);
  assert.equal(missing?.finalStatus, 404);

  const blocked = byUrl.get(`https://${HOSTNAME}/blocked-by-robots`);
  assert.ok(blocked);
  assert.equal(blocked?.fetchOutcome, "ROBOTS_BLOCKED");
  assert.equal(blocked?.title, null);
  assert.equal(
    recordedFetches.includes(`https://${HOSTNAME}/blocked-by-robots`),
    false,
    "robots-blocked URL must not be fetched",
  );

  const pdf = byUrl.get(`https://${HOSTNAME}/pdf`);
  assert.ok(pdf);
  assert.equal(pdf?.contentType, "application/pdf");
  assert.equal((pdf?.fieldValidity as Record<string, string>)?.title, "NOT_APPLICABLE");

  // External links are neither fetched nor observed.
  assert.equal(
    recordedFetches.some((url) => !url.includes(HOSTNAME) || url.includes(`cdn.${HOSTNAME}`)),
    false,
  );
  assert.equal(
    observations.some((o) => o.page.identityUrl.includes(`cdn.${HOSTNAME}`)),
    false,
  );

  // Sitemap seeds entered the frontier even without links pointing at them.
  assert.ok(byUrl.get(`https://${HOSTNAME}/noindex-page`));

  // Re-execution on a terminal run is a no-op (no duplicate observations).
  const again = await executeCrawl(client, created.crawlId, { fetcher: siteFetcher(), ...fakeClock().deps });
  assert.equal(again.status, "COMPLETED");
  assert.equal(await client.pageObservation.count({ where: { runId: created.crawlId } }), observations.length);
});

test("page budgets truncate the crawl into PARTIAL", async () => {
  const client = db();
  resetSite();
  const { workspaceId, owner, projectId } = await setupVerifiedProject();
  // Shrink the page budget on the current policy.
  const project = await client.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { currentPolicy: true },
  });
  await client.projectPolicy.update({
    where: { id: project.currentPolicyId! },
    data: { config: { ...(project.currentPolicy!.config as object), maxPages: 2 } },
  });

  const created = await createCrawl(client, actor(owner.id, workspaceId, "OWNER"), projectId, "run-partial");
  const outcome = await executeCrawl(client, created.crawlId, { fetcher: siteFetcher(), ...fakeClock().deps });
  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.completeness, "PARTIAL");
  assert.equal(outcome.failureCode, "LIMIT_REACHED");
  const run = await client.crawlRun.findUniqueOrThrow({ where: { id: created.crawlId } });
  assert.equal(run.publishedAt, null); // PARTIAL never publishes (docs §8)
});

test("a crashed worker recovers after lease expiry without duplicate observations", async () => {
  const client = db();
  resetSite();
  const { workspaceId, owner, projectId } = await setupVerifiedProject();
  const created = await createCrawl(client, actor(owner.id, workspaceId, "OWNER"), projectId, "run-crash");

  // First attempt: the fetcher dies on the first page fetch (after robots/sitemap).
  const crashFetcher = async (url: string): Promise<SafeFetchResult> => {
    if (url.endsWith("robots.txt") || url.endsWith("sitemap.xml")) return siteFetcher()(url);
    throw new Error("simulated worker crash");
  };
  await assert.rejects(executeCrawl(client, created.crawlId, { fetcher: crashFetcher, ...fakeClock().deps }));

  // The crashed worker's lease must expire before takeover (docs §7.1).
  await client.crawlRun.update({
    where: { id: created.crawlId },
    data: { leaseExpiresAt: new Date(Date.now() - 1000) },
  });

  const outcome = await executeCrawl(client, created.crawlId, { fetcher: siteFetcher(), ...fakeClock().deps });
  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.completeness, "FULL");

  const observations = await client.pageObservation.findMany({
    where: { runId: created.crawlId },
    include: { page: true },
  });
  assert.equal(observations.length, new Set(observations.map((o) => o.pageId)).size, "no duplicate observations");
  assert.ok(observations.length >= 7, `expected the recovered crawl to observe the site, got ${observations.length}`);
});

test("cancellation of a queued run is immediate and idempotent", async () => {
  const client = db();
  resetSite();
  const { workspaceId, owner, projectId } = await setupVerifiedProject();
  const created = await createCrawl(client, actor(owner.id, workspaceId, "OWNER"), projectId, "run-cancel");

  const cancelled = await cancelCrawl(client, actor(owner.id, workspaceId, "OWNER"), projectId, created.crawlId);
  assert.equal(cancelled.status, "CANCELLED");

  const repeat = await cancelCrawl(client, actor(owner.id, workspaceId, "OWNER"), projectId, created.crawlId);
  assert.equal(repeat.status, "CANCELLED");
  assert.equal(repeat.alreadyFinished, true);

  // The executor treats the terminal run as done; nothing is fetched.
  const outcome = await executeCrawl(client, created.crawlId, { fetcher: siteFetcher(), ...fakeClock().deps });
  assert.equal(outcome.status, "CANCELLED");
  assert.equal(await client.pageObservation.count({ where: { runId: created.crawlId } }), 0);
});

export {};
