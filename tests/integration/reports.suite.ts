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
import { getOverview, listChanges, listIssues } from "../../server/services/report-service.ts";
import { updateIssueSuppression } from "../../server/services/issue-service.ts";
import { pageParams } from "../../server/api/page-params.ts";
import { ApiError } from "../../server/api/errors.ts";
import { publishRun } from "../../server/crawl/publisher.ts";

const HOSTNAME = `report-${uniqueId()}.test`;

/**
 * P3 acceptance (docs/IMPLEMENTATION_PLAN.md §4): three crawls demonstrate
 * "baseline → change → resolution"; PARTIAL never advances the baseline.
 */

const SITE: Record<string, { status: number; location?: string; body?: string; contentType?: string }> = {};

function html(title: string, extraHead = "", body = ""): string {
  return `<html><head><title>${title}</title>${extraHead}</head><body>${body}</body></html>`;
}

function deploySiteV1(): void {
  for (const key of Object.keys(SITE)) delete SITE[key];
  const urlset = (paths: string[]) =>
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
      .map((p) => `<url><loc>https://${HOSTNAME}${p}</loc></url>`)
      .join("")}</urlset>`;
  SITE[`https://${HOSTNAME}/robots.txt`] = {
    status: 200,
    contentType: "text/plain",
    body: `User-agent: *\nSitemap: https://${HOSTNAME}/sitemap.xml\n`,
  };
  SITE[`https://${HOSTNAME}/sitemap.xml`] = {
    status: 200,
    contentType: "application/xml",
    body: urlset(["/", "/a", "/b", "/gone-later", "/noindex-page"]),
  };
  SITE[`https://${HOSTNAME}/`] = {
    status: 200,
    contentType: "text/html",
    body: html("Home", "", `<a href="/a">A</a>`),
  };
  SITE[`https://${HOSTNAME}/a`] = { status: 200, contentType: "text/html", body: html("A v1") };
  SITE[`https://${HOSTNAME}/b`] = {
    status: 200,
    contentType: "text/html",
    body: html("B", `<meta name="robots" content="noindex">`),
  };
  SITE[`https://${HOSTNAME}/gone-later`] = { status: 200, contentType: "text/html", body: html("Gone") };
  SITE[`https://${HOSTNAME}/noindex-page`] = {
    status: 200,
    contentType: "text/html",
    body: html("N", `<meta name="robots" content="noindex">`),
  };
}

function deploySiteV2(): void {
  deploySiteV1();
  SITE[`https://${HOSTNAME}/a`] = { status: 200, contentType: "text/html", body: html("A v2") };
  SITE[`https://${HOSTNAME}/b`] = { status: 200, contentType: "text/html", body: html("B") };
  SITE[`https://${HOSTNAME}/gone-later`] = { status: 404, contentType: "text/html", body: html("404") };
  SITE[`https://${HOSTNAME}/`] = {
    status: 200,
    contentType: "text/html",
    body: html("Home", "", `<a href="/a">A</a><a href="/c">C</a>`),
  };
  SITE[`https://${HOSTNAME}/c`] = { status: 200, contentType: "text/html", body: html("C") };
  SITE[`https://${HOSTNAME}/sitemap.xml`].body = SITE[`https://${HOSTNAME}/sitemap.xml`].body!.replace(
    "</urlset>",
    `<url><loc>https://${HOSTNAME}/c</loc></url></urlset>`,
  );
}

function deploySiteV3(): void {
  deploySiteV2();
  SITE[`https://${HOSTNAME}/gone-later`] = { status: 200, contentType: "text/html", body: html("Gone") };
}

function fetcher(): (url: string) => Promise<SafeFetchResult> {
  const dns: DnsResolver = async () => ["93.184.216.34"];
  const transport: Transport = async (request) => {
    const entry = SITE[request.url.toString()] ?? { status: 404, contentType: "text/plain" };
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

const clockDeps: Omit<CrawlDependencies, "fetcher"> = {
  now: () => new Date(),
  sleep: async () => {},
};

interface SummaryLike {
  healthComponents: unknown;
}

function componentOf(summary: SummaryLike, ruleKey: string): { deduction: number; openIssues: number } {
  const components = summary.healthComponents as Array<{
    ruleKey: string;
    deduction: number;
    openIssues: number;
  }>;
  return components.find((component) => component.ruleKey === ruleKey)!;
}

interface Setup {
  workspaceId: string;
  owner: { id: string; email: string; emailVerified: boolean };
  projectId: string;
}

async function setup(): Promise<Setup> {
  const client = db();
  const owner = await createUser(client);
  const workspaceId = await createWorkspaceWithOwner(client, owner, "Report WS");
  const project = await createProject(client, actor(owner.id, workspaceId, "OWNER"), { hostname: HOSTNAME });
  const request = await requestVerification(client, actor(owner.id, workspaceId, "OWNER"), project.id);
  const events = await claimBatch(client, { type: VERIFICATION_REQUESTED, limit: 5, leaseMs: 30_000 });
  assert.equal(events.length, 1);
  await processVerificationJob(client, events[0], async () => [[request.recordValue]]);
  return { workspaceId, owner, projectId: project.id };
}

async function runCrawl(setup: Setup, key: string): Promise<string> {
  const client = db();
  const created = await createCrawl(client, actor(setup.owner.id, setup.workspaceId, "OWNER"), setup.projectId, key);
  // Backdate so consecutive demo crawls don't trip the 5-minute manual quota.
  await client.crawlRun.update({
    where: { id: created.crawlId },
    data: { createdAt: new Date(Date.now() - 6 * 60 * 1000) },
  });
  await executeCrawl(client, created.crawlId, { fetcher: fetcher(), ...clockDeps });
  return created.crawlId;
}

before(async () => {
  await cleanDatabase(db());
});

test("three crawls: baseline → changes → resolution", async () => {
  const client = db();
  const setupResult = await setup();

  // ---- Run 1: baseline ----
  deploySiteV1();
  const run1 = await runCrawl(setupResult, "report-1");
  const published1 = await client.crawlRun.findUniqueOrThrow({ where: { id: run1 } });
  assert.equal(published1.status, "COMPLETED");
  assert.equal(published1.completeness, "FULL");
  assert.equal(published1.comparisonMode, "BASELINE");
  assert.ok(published1.publishedAt);
  assert.equal(await client.changeEvent.count({ where: { runId: run1 } }), 0, "baseline reports no changes");

  const project1 = await client.project.findUniqueOrThrow({ where: { id: setupResult.projectId } });
  assert.equal(project1.latestPublishedRunId, run1);

  const issues1 = await client.issue.findMany({ where: { projectId: setupResult.projectId }, include: { page: true } });
  const issueKeys1 = new Set(issues1.map((issue) => `${issue.ruleKey}:${issue.page.identityUrl}`));
  assert.ok(issueKeys1.has(`noindex_on_indexable:https://${HOSTNAME}/b`));
  assert.ok(issueKeys1.has(`noindex_on_indexable:https://${HOSTNAME}/noindex-page`));
  assert.equal(
    issues1.every((issue) => issue.state === "OPEN"),
    true,
  );

  const summary1 = await client.crawlSummary.findUniqueOrThrow({ where: { runId: run1 } });
  assert.equal(summary1.issuesOpen, 2);

  // Health v1: 2 of 5 evaluated pages noindex → rate 0.4 saturates the
  // 25-point component; every page answered decisively → coverage 1.
  assert.equal(summary1.healthScore, 75);
  assert.equal(summary1.healthScoreVersion, 1);
  assert.equal(summary1.healthCoverage, 1);
  assert.equal(summary1.healthReason, "OK");
  assert.equal(componentOf(summary1, "noindex_on_indexable").deduction, 25);
  assert.equal(componentOf(summary1, "noindex_on_indexable").openIssues, 2);
  assert.equal(componentOf(summary1, "http_4xx_5xx").deduction, 0);

  // ---- Run 2: changes ----
  deploySiteV2();
  const run2 = await runCrawl(setupResult, "report-2");
  const published2 = await client.crawlRun.findUniqueOrThrow({ where: { id: run2 } });
  assert.equal(published2.comparisonMode, "DIFF");
  assert.equal(published2.baseRunId, run1);

  const events2 = await client.changeEvent.findMany({ where: { runId: run2 }, include: { page: true } });
  const eventKeys = events2.map((event) => `${event.type}:${event.page.identityUrl}`).sort();
  assert.deepEqual(eventKeys, [
    `HTTP_STATUS_CHANGED:https://${HOSTNAME}/gone-later`,
    `INTERNAL_LINKS_CHANGED:https://${HOSTNAME}/`,
    `ROBOTS_CHANGED:https://${HOSTNAME}/b`,
    `TITLE_CHANGED:https://${HOSTNAME}/a`,
    `URL_ADDED:https://${HOSTNAME}/c`,
  ]);
  const goneEvent = events2.find((event) => event.type === "HTTP_STATUS_CHANGED")!;
  assert.equal(goneEvent.severity, "CRITICAL");
  assert.equal(goneEvent.before, 200);
  assert.equal(goneEvent.after, 404);

  const issueB = await client.issue.findFirstOrThrow({
    where: { projectId: setupResult.projectId, page: { identityUrl: `https://${HOSTNAME}/b` } },
  });
  assert.equal(issueB.state, "RESOLVED");
  const issueGone = await client.issue.findFirstOrThrow({
    where: {
      projectId: setupResult.projectId,
      ruleKey: "http_4xx_5xx",
      page: { identityUrl: `https://${HOSTNAME}/gone-later` },
    },
  });
  assert.equal(issueGone.state, "OPEN");
  const issueNoindex = await client.issue.findFirstOrThrow({
    where: { projectId: setupResult.projectId, page: { identityUrl: `https://${HOSTNAME}/noindex-page` } },
  });
  assert.equal(issueNoindex.state, "OPEN", "unchanged issue keeps its state");
  assert.equal(issueNoindex.occurrence, 1);

  const summary2 = await client.crawlSummary.findUniqueOrThrow({ where: { runId: run2 } });
  assert.equal(summary2.changesTotal, 5);
  assert.equal(summary2.changesCritical, 1);
  assert.equal(summary2.changesWarning, 1);
  assert.equal(summary2.changesInfo, 3);
  assert.equal(summary2.affectedPages, 5);
  assert.equal(summary2.issuesResolvedThisRun, 1);
  assert.equal(summary2.issuesOpen, 2);

  // 6 evaluated pages: 1 http error (rate 1/6 → −33) and 1 noindex (−21).
  assert.equal(summary2.healthScore, 46);
  assert.equal(summary2.healthScoreVersion, 1);
  assert.equal(componentOf(summary2, "http_4xx_5xx").deduction, 33);
  assert.equal(componentOf(summary2, "noindex_on_indexable").deduction, 21);

  // ---- Run 3: resolution ----
  deploySiteV3();
  const run3 = await runCrawl(setupResult, "report-3");
  const events3 = await client.changeEvent.findMany({ where: { runId: run3 }, include: { page: true } });
  assert.deepEqual(
    events3.map((event) => `${event.type}:${event.page.identityUrl}`),
    [`HTTP_STATUS_CHANGED:https://${HOSTNAME}/gone-later`],
  );
  assert.equal(events3[0].severity, "INFO", "404→200 recovery is informational");
  assert.equal((await client.issue.findFirstOrThrow({ where: { id: issueGone.id } })).state, "RESOLVED");
  const summary3 = await client.crawlSummary.findUniqueOrThrow({ where: { runId: run3 } });
  assert.equal(summary3.issuesResolvedThisRun, 1);
  assert.equal(summary3.issuesOpen, 1);
  // Recovery is visible in the score: only the carried-over noindex (−21).
  assert.equal(summary3.healthScore, 79);
  assert.equal(componentOf(summary3, "http_4xx_5xx").deduction, 0);
  assert.equal(
    (await client.project.findUniqueOrThrow({ where: { id: setupResult.projectId } })).latestPublishedRunId,
    run3,
  );

  // Re-open bumps occurrence (docs §9): break /b again and confirm.
  deploySiteV3();
  SITE[`https://${HOSTNAME}/b`] = {
    status: 200,
    contentType: "text/html",
    body: html("B", `<meta name="robots" content="noindex">`),
  };
  const run4 = await runCrawl(setupResult, "report-4");
  const issueBReopened = await client.issue.findFirstOrThrow({ where: { id: issueB.id } });
  assert.equal(issueBReopened.state, "OPEN");
  assert.equal(issueBReopened.occurrence, 2);
  const transitionsB = await client.issueTransition.count({ where: { issueId: issueB.id } });
  assert.equal(transitionsB, 3, "OPEN→RESOLVED→OPEN plus creation");
  // Re-opened /b saturates the noindex component again (2 of 6 → −25).
  const summary4 = await client.crawlSummary.findUniqueOrThrow({ where: { runId: run4 } });
  assert.equal(summary4.healthScore, 75);
  void run4;
});

test("PARTIAL completes unpublished and never advances the baseline", async () => {
  const client = db();
  const setupResult = await setup();

  deploySiteV1();
  const run1 = await runCrawl(setupResult, "partial-1");
  const baselineSummary = await client.crawlSummary.findUniqueOrThrow({ where: { runId: run1 } });

  // Shrink the page budget so the next crawl must truncate.
  const project = await client.project.findUniqueOrThrow({
    where: { id: setupResult.projectId },
    include: { currentPolicy: true },
  });
  await client.projectPolicy.update({
    where: { id: project.currentPolicyId! },
    data: { config: { ...(project.currentPolicy!.config as object), maxPages: 1 } },
  });

  deploySiteV2();
  const run2 = await runCrawl(setupResult, "partial-2");
  const partial = await client.crawlRun.findUniqueOrThrow({ where: { id: run2 } });
  assert.equal(partial.status, "COMPLETED");
  assert.equal(partial.completeness, "PARTIAL");
  assert.equal(partial.publishedAt, null);
  assert.equal(partial.comparisonMode, "NONE");
  assert.equal(await client.changeEvent.count({ where: { runId: run2 } }), 0);
  assert.equal(await client.crawlSummary.count({ where: { runId: run2 } }), 0);

  // Baseline untouched: the project still points at run 1.
  const projectAfter = await client.project.findUniqueOrThrow({ where: { id: setupResult.projectId } });
  assert.equal(projectAfter.latestPublishedRunId, run1);
  void baselineSummary;

  // A FULL crawl after restoring the budget diffs against run 1, not the partial.
  await client.projectPolicy.update({
    where: { id: project.currentPolicyId! },
    data: { config: project.currentPolicy!.config as object },
  });
  const run3 = await runCrawl(setupResult, "partial-3");
  const published3 = await client.crawlRun.findUniqueOrThrow({ where: { id: run3 } });
  assert.equal(published3.completeness, "FULL");
  assert.equal(published3.comparisonMode, "DIFF");
  assert.equal(published3.baseRunId, run1);
  // The FULL run carries a health score; the PARTIAL run never did.
  const restoredSummary = await client.crawlSummary.findUniqueOrThrow({ where: { runId: run3 } });
  assert.notEqual(restoredSummary.healthScore, null);
  assert.equal(restoredSummary.healthScoreVersion, 1);
});

test("health score is suppressed when decisive coverage is insufficient", async () => {
  const client = db();
  const setupResult = await setup();

  // robots.txt disallows 3 of the 4 sitemap pages (plus the seed homepage,
  // which is always crawled): they are observed as ROBOTS_BLOCKED (no page
  // evidence), so decisive coverage is 2/5 = 40% < 50%.
  for (const key of Object.keys(SITE)) delete SITE[key];
  SITE[`https://${HOSTNAME}/robots.txt`] = {
    status: 200,
    contentType: "text/plain",
    body: `User-agent: *\nDisallow: /secret-a\nDisallow: /secret-b\nDisallow: /secret-c\nSitemap: https://${HOSTNAME}/sitemap.xml\n`,
  };
  SITE[`https://${HOSTNAME}/sitemap.xml`] = {
    status: 200,
    contentType: "application/xml",
    body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${HOSTNAME}/ok</loc></url><url><loc>https://${HOSTNAME}/secret-a</loc></url><url><loc>https://${HOSTNAME}/secret-b</loc></url><url><loc>https://${HOSTNAME}/secret-c</loc></url></urlset>`,
  };
  SITE[`https://${HOSTNAME}/`] = { status: 200, contentType: "text/html", body: html("Home") };
  SITE[`https://${HOSTNAME}/ok`] = { status: 200, contentType: "text/html", body: html("OK") };

  const run = await runCrawl(setupResult, "health-coverage");
  const published = await client.crawlRun.findUniqueOrThrow({ where: { id: run } });
  assert.equal(published.completeness, "FULL", "robots-blocked pages do not degrade completeness");

  const summary = await client.crawlSummary.findUniqueOrThrow({ where: { runId: run } });
  assert.equal(summary.urlsCrawled, 2);
  assert.equal(summary.healthScore, null, "insufficient coverage suppresses the score");
  assert.equal(summary.healthScoreVersion, null);
  assert.equal(summary.healthReason, "INSUFFICIENT_COVERAGE");
  assert.ok(summary.healthCoverage !== null && Math.abs(summary.healthCoverage - 0.4) < 1e-9);
  // The breakdown is stored without deductions.
  const components = summary.healthComponents as Array<{ ruleKey: string; deduction: number }>;
  assert.equal(
    components.every((component) => component.deduction === 0),
    true,
  );
});

test("report cursors visit every change and issue once, including equal timestamps", async () => {
  const client = db();
  const context = await setup();
  const ownerActor = actor(context.owner.id, context.workspaceId, "OWNER");
  deploySiteV1();
  await runCrawl(context, "pagination-baseline");
  deploySiteV2();
  const runId = await runCrawl(context, "pagination-diff");
  const timestamp = new Date("2025-01-01T00:00:00Z");
  await client.changeEvent.updateMany({ where: { runId }, data: { createdAt: timestamp } });
  await client.issue.updateMany({
    where: { projectId: context.projectId },
    data: { createdAt: timestamp, updatedAt: new Date("2025-02-01T00:00:00Z") },
  });

  for (const kind of ["changes", "issues"] as const) {
    const expected =
      kind === "changes"
        ? await client.changeEvent.findMany({ where: { runId }, select: { id: true }, orderBy: { id: "desc" } })
        : await client.issue.findMany({
            where: { projectId: context.projectId },
            select: { id: true },
            orderBy: { id: "desc" },
          });
    const visited: string[] = [];
    let cursor: string | null = null;
    for (let request = 0; request <= expected.length; request += 1) {
      const url = new URL(`https://app.example.test/${kind}?limit=1`);
      if (cursor) url.searchParams.set("cursor", cursor);
      const page =
        kind === "changes"
          ? await listChanges(client, ownerActor, context.projectId, { runId }, pageParams(url))
          : await listIssues(client, ownerActor, context.projectId, { state: "ALL" }, pageParams(url));
      visited.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, null, `${kind} pagination must terminate`);
    assert.deepEqual(
      visited,
      expected.map((item) => item.id),
      `${kind} must not omit or repeat rows`,
    );
  }
});

test("current issue reads exclude prior policy scopes and rule versions", async () => {
  const client = db();
  const context = await setup();
  const ownerActor = actor(context.owner.id, context.workspaceId, "OWNER");
  deploySiteV1();
  await runCrawl(context, "issue-scope");
  const issue = await client.issue.findFirstOrThrow({ where: { projectId: context.projectId } });
  for (const version of [
    { scopeGeneration: issue.scopeGeneration + 1, ruleVersion: issue.ruleVersion },
    { scopeGeneration: issue.scopeGeneration, ruleVersion: issue.ruleVersion + 1 },
  ]) {
    await client.issue.create({
      data: { projectId: issue.projectId, pageId: issue.pageId, ruleKey: issue.ruleKey, ...version },
    });
  }
  const overview = await getOverview(client, ownerActor, context.projectId);
  assert.equal(overview.openIssues, 2);
  const issues = await listIssues(client, ownerActor, context.projectId, { state: "ALL" }, { take: 50 });
  assert.equal(issues.items.length, 2);
});

test("issue suppression rejects another workspace and records authorized changes atomically", async () => {
  const client = db();
  const context = await setup();
  deploySiteV1();
  await runCrawl(context, "suppression-isolation");
  const issue = await client.issue.findFirstOrThrow({ where: { projectId: context.projectId } });
  const outsider = await createUser(client);
  const outsiderWorkspaceId = await createWorkspaceWithOwner(client, outsider);
  const until = new Date(Date.now() + 86_400_000);
  const assertNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;
  await assert.rejects(
    updateIssueSuppression(client, actor(outsider.id, outsiderWorkspaceId, "OWNER"), context.projectId, issue.id, {
      suppressedUntil: until,
    }),
    assertNotFound,
  );
  assert.equal((await client.issue.findUniqueOrThrow({ where: { id: issue.id } })).suppressedUntil, null);
  assert.equal(await client.auditLog.count({ where: { resourceId: issue.id } }), 0);

  const ownerActor = actor(context.owner.id, context.workspaceId, "OWNER");
  await updateIssueSuppression(client, ownerActor, context.projectId, issue.id, { suppressedUntil: until });
  assert.deepEqual((await client.issue.findUniqueOrThrow({ where: { id: issue.id } })).suppressedUntil, until);
  assert.equal(await client.auditLog.count({ where: { resourceId: issue.id, action: "issue.suppressed" } }), 1);
  assert.equal((await getOverview(client, ownerActor, context.projectId)).openIssues, 1);

  // PostgreSQL text cannot contain NUL. A failed audit write must roll the
  // overlay back as well, even though its update has already succeeded.
  await assert.rejects(
    updateIssueSuppression(
      client,
      ownerActor,
      context.projectId,
      issue.id,
      { suppressedUntil: null },
      "invalid\u0000request-id",
    ),
  );
  assert.deepEqual((await client.issue.findUniqueOrThrow({ where: { id: issue.id } })).suppressedUntil, until);
});

test("publication refuses cancelled runs, cancellation requests, and unfinished crawls", async () => {
  const client = db();
  const context = await setup();
  const project = await client.project.findUniqueOrThrow({ where: { id: context.projectId } });
  for (const state of [
    { status: "CANCELLED", cancelRequestedAt: null },
    { status: "RUNNING", cancelRequestedAt: null },
    { status: "FINALIZING", cancelRequestedAt: new Date() },
  ] as const) {
    const run = await client.crawlRun.create({
      data: { projectId: project.id, policyId: project.currentPolicyId!, leaseToken: 1, ...state },
    });
    const outcome = await publishRun(client, { projectId: project.id, runId: run.id, leaseToken: 1 });
    assert.equal(outcome.published, false, `${state.status} must not publish`);
    assert.equal(await client.crawlSummary.count({ where: { runId: run.id } }), 0);
    assert.equal((await client.crawlRun.findUniqueOrThrow({ where: { id: run.id } })).publishedAt, null);
    assert.equal((await client.project.findUniqueOrThrow({ where: { id: project.id } })).latestPublishedRunId, null);
    await client.crawlRun.update({ where: { id: run.id }, data: { status: "CANCELLED" } });
  }
});

test("publication evaluates the run's immutable policy and repeated publication is idempotent", async () => {
  const client = db();
  const context = await setup();
  const project = await client.project.findUniqueOrThrow({
    where: { id: context.projectId },
    include: { currentPolicy: true },
  });
  const policy = project.currentPolicy!;
  const run = await client.crawlRun.create({
    data: { projectId: project.id, policyId: policy.id, status: "FINALIZING", leaseToken: 1 },
  });
  const page = await client.page.create({
    data: {
      projectId: project.id,
      identityVersion: policy.identityVersion,
      identityUrl: `https://${HOSTNAME}/`,
      urlKey: uniqueId(),
    },
  });
  await client.pageObservation.create({
    data: {
      runId: run.id,
      pageId: page.id,
      requestUrl: page.identityUrl,
      fetchOutcome: "HTTP_RESPONSE",
      initialStatus: 200,
      finalStatus: 200,
      title: null,
      fieldValidity: { title: "KNOWN" },
    },
  });
  const newerPolicy = await client.projectPolicy.create({
    data: {
      projectId: project.id,
      version: policy.version + 1,
      scopeGeneration: policy.scopeGeneration + 1,
      ruleVersion: policy.ruleVersion + 1,
      identityVersion: policy.identityVersion,
      extractorVersion: policy.extractorVersion,
      config: policy.config as object,
      policyHash: `new-${uniqueId()}`,
    },
  });
  await client.project.update({ where: { id: project.id }, data: { currentPolicyId: newerPolicy.id } });
  const input = { projectId: project.id, runId: run.id, leaseToken: 1 };
  const first = await publishRun(client, input);
  assert.equal(first.published, true);
  const issue = await client.issue.findFirstOrThrow({ where: { projectId: project.id, ruleKey: "missing_title" } });
  assert.equal(issue.scopeGeneration, policy.scopeGeneration);
  assert.equal(issue.ruleVersion, policy.ruleVersion);
  assert.deepEqual(await publishRun(client, input), first);
  assert.equal(await client.issueTransition.count({ where: { runId: run.id } }), 1);
});

export {};
