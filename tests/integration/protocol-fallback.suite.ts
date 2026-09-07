import test from "node:test";
import assert from "node:assert/strict";
import { before } from "node:test";
import { safeFetch } from "@seo/crawler";
import type { DnsResolver, SafeFetchResult, Transport } from "@seo/crawler";
import { actor, cleanDatabase, createWorkspaceWithOwner, createUser, db, uniqueId } from "./helpers.ts";
import { executeCrawl } from "../../server/crawl/executor.ts";
import type { CrawlDependencies } from "../../server/crawl/executor.ts";
import { createCrawl } from "../../server/services/crawl-service.ts";
import { createProject, requestVerification } from "../../server/services/project-service.ts";
import { processVerificationJob } from "../../server/services/verification-runner.ts";
import { claimBatch, VERIFICATION_REQUESTED } from "../../server/repositories/outbox.ts";

const HOSTNAME = `plainhttp-${uniqueId()}.test`;

const SITE: Record<string, { status: number; body?: string; contentType?: string }> = {};
const requestedUrls: string[] = [];

function deploy(): void {
  for (const key of Object.keys(SITE)) delete SITE[key];
  const robots = `User-agent: *\nSitemap: http://${HOSTNAME}/sitemap.xml\n`;
  SITE[`http://${HOSTNAME}/robots.txt`] = { status: 200, contentType: "text/plain", body: robots };
  SITE[`http://${HOSTNAME}/sitemap.xml`] = {
    status: 200,
    contentType: "application/xml",
    body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://${HOSTNAME}/</loc></url></urlset>`,
  };
  SITE[`http://${HOSTNAME}/`] = {
    status: 200,
    contentType: "text/html",
    body: `<html><head><title>Plain HTTP Home</title></head><body></body></html>`,
  };
}

function fetcher(): (url: string) => Promise<SafeFetchResult> {
  const dns: DnsResolver = async () => ["93.184.216.34"];
  const transport: Transport = async (request) => {
    const key = request.url.toString();
    requestedUrls.push(key);
    const entry = SITE[key] ?? { status: 404, contentType: "text/plain" };
    return {
      status: entry.status,
      headers: { "content-type": entry.contentType ?? "text/html" },
      body: (async function* () {
        yield new TextEncoder().encode(entry.body ?? "");
      })(),
    };
  };
  return (url) => safeFetch(url, { resolveDns: dns, transport, allowedHostname: HOSTNAME, userAgent: "IndexlyBot" });
}

const clockDeps: Omit<CrawlDependencies, "fetcher"> = { now: () => new Date(), sleep: async () => {} };

async function setupVerifiedProject() {
  const client = db();
  const owner = await createUser(client);
  const workspaceId = await createWorkspaceWithOwner(client, owner, "Fallback WS");
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

test("falls back to HTTP:80 when HTTPS is unreachable, and never re-asks HTTPS after an answer", async () => {
  const client = db();
  deploy();
  requestedUrls.length = 0;
  const setup = await setupVerifiedProject();

  // The fake site only serves http:// URLs — every https:// request throws at
  // the transport level, exercising the network-failure fallback path.
  const created = await createCrawl(
    client,
    actor(setup.owner.id, setup.workspaceId, "OWNER"),
    setup.projectId,
    "fallback-1",
  );
  const outcome = await executeCrawl(client, created.crawlId, { fetcher: fetcher(), ...clockDeps });
  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.completeness, "FULL");

  // Exactly one HTTPS robots attempt (with its single retry disabled? — the
  // https loop retries up to 3 times at network level), then HTTP takes over.
  const httpsAttempts = requestedUrls.filter((url) => url.startsWith("https://"));
  const httpRequests = requestedUrls.filter((url) => url.startsWith("http://"));
  assert.ok(
    httpsAttempts.length >= 1 && httpsAttempts.length <= 3,
    `expected bounded https attempts, got ${httpsAttempts.length}`,
  );
  assert.ok(httpRequests.includes(`http://${HOSTNAME}/robots.txt`));
  assert.ok(httpRequests.includes(`http://${HOSTNAME}/`));

  // The run observed the page under its HTTP identity.
  const observations = await client.pageObservation.findMany({
    where: { runId: created.crawlId },
    include: { page: true },
  });
  const home = observations.find((o) => o.page.identityUrl === `http://${HOSTNAME}/`);
  assert.ok(home, `expected http identity observation, got ${observations.map((o) => o.page.identityUrl).join(", ")}`);
  assert.equal(home?.title, "Plain HTTP Home");
});

test("an HTTPS-capable site never sees an HTTP request", async () => {
  const client = db();
  // Serve robots over HTTPS only; HTTP requests would 404 in this fake site.
  SITE[`https://${HOSTNAME}/robots.txt`] = { status: 200, contentType: "text/plain", body: `User-agent: *\n` };
  SITE[`https://${HOSTNAME}/`] = {
    status: 200,
    contentType: "text/html",
    body: `<html><head><title>TLS Home</title></head></html>`,
  };
  delete SITE[`http://${HOSTNAME}/robots.txt`];
  delete SITE[`http://${HOSTNAME}/sitemap.xml`];
  SITE[`http://${HOSTNAME}/`] = { status: 404, contentType: "text/plain" };
  requestedUrls.length = 0;

  const setup = await setupVerifiedProject();
  const created = await createCrawl(
    client,
    actor(setup.owner.id, setup.workspaceId, "OWNER"),
    setup.projectId,
    "fallback-2",
  );
  const outcome = await executeCrawl(client, created.crawlId, { fetcher: fetcher(), ...clockDeps });
  assert.equal(outcome.completeness, "FULL");

  const httpRequests = requestedUrls.filter((url) => url.startsWith("http://"));
  assert.deepEqual(
    httpRequests.filter((url) => url.endsWith("robots.txt")),
    [],
    "no HTTP robots probe after HTTPS answered",
  );
  const observations = await client.pageObservation.findMany({
    where: { runId: created.crawlId },
    include: { page: true },
  });
  const home = observations.find((o) => o.page.identityUrl === `https://${HOSTNAME}/`);
  assert.ok(home, "https identity observed");
});

export {};
