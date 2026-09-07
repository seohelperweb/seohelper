import test from "node:test";
import assert from "node:assert/strict";
import { evaluateIssueRule, nextIssueState } from "@seo/issue-rules";
import type { RuleObservation } from "@seo/issue-rules";

const observation = (overrides: Partial<RuleObservation> = {}): RuleObservation => ({
  pageId: "p1",
  identityUrl: "https://example.com/a",
  fetchOutcome: "HTTP_RESPONSE",
  initialStatus: 200,
  finalStatus: 200,
  title: "Title",
  canonical: { raw: ["https://example.com/a"], resolved: ["https://example.com/a"] },
  robots: { raw: ["index"], index: "ALLOWED" },
  fieldValidity: {
    title: "KNOWN",
    canonical: "KNOWN",
    robots: "KNOWN",
    metaDescription: "KNOWN",
    internalLinksCount: "KNOWN",
  },
  ...overrides,
});

test("http error rule: decisive statuses only", () => {
  assert.equal(evaluateIssueRule("http_4xx_5xx", observation({ finalStatus: 404 })).verdict, "PRESENT");
  assert.equal(evaluateIssueRule("http_4xx_5xx", observation({ finalStatus: 410 })).verdict, "PRESENT");
  assert.equal(evaluateIssueRule("http_4xx_5xx", observation({ finalStatus: 503 })).verdict, "PRESENT");
  assert.equal(evaluateIssueRule("http_4xx_5xx", observation({ finalStatus: 301 })).verdict, "ABSENT");
  assert.equal(
    evaluateIssueRule("http_4xx_5xx", observation({ fetchOutcome: "NETWORK_ERROR", finalStatus: null })).verdict,
    "UNKNOWN",
  );
  assert.equal(
    evaluateIssueRule("http_4xx_5xx", observation({ fetchOutcome: "ROBOTS_BLOCKED", finalStatus: null })).verdict,
    "UNKNOWN",
  );
});

test("noindex rule follows the synthesized index state", () => {
  assert.equal(
    evaluateIssueRule("noindex_on_indexable", observation({ robots: { raw: ["noindex"], index: "DISALLOWED" } }))
      .verdict,
    "PRESENT",
  );
  assert.equal(evaluateIssueRule("noindex_on_indexable", observation()).verdict, "ABSENT");
  assert.equal(
    evaluateIssueRule("noindex_on_indexable", observation({ robots: { raw: [], index: "UNKNOWN" } })).verdict,
    "UNKNOWN",
  );
  assert.equal(
    evaluateIssueRule("noindex_on_indexable", observation({ fetchOutcome: "SECURITY_BLOCKED", robots: null })).verdict,
    "UNKNOWN",
  );
});

test("missing title distinguishes absent from unknown", () => {
  assert.equal(evaluateIssueRule("missing_title", observation({ title: null })).verdict, "PRESENT");
  assert.equal(evaluateIssueRule("missing_title", observation()).verdict, "ABSENT");
  assert.equal(
    evaluateIssueRule("missing_title", observation({ title: null, fieldValidity: { title: "NOT_APPLICABLE" } }))
      .verdict,
    "UNKNOWN",
  );
  // A 500 error page must not confirm "title missing resolved" either (docs §9).
  assert.equal(
    evaluateIssueRule("missing_title", observation({ finalStatus: 500, fieldValidity: { title: "UNKNOWN" } })).verdict,
    "UNKNOWN",
  );
});

test("canonical rule flags invalid and conflicting values; absence is fine", () => {
  assert.equal(
    evaluateIssueRule("canonical_conflict", observation({ canonical: { raw: [], resolved: [] } })).verdict,
    "ABSENT",
  );
  assert.equal(
    evaluateIssueRule("canonical_conflict", observation({ canonical: { raw: ["::bad::"], resolved: [] } })).verdict,
    "PRESENT",
  );
  assert.equal(
    evaluateIssueRule(
      "canonical_conflict",
      observation({ canonical: { raw: ["/a", "/b"], resolved: ["https://example.com/a", "https://example.com/b"] } }),
    ).verdict,
    "PRESENT",
  );
  assert.equal(evaluateIssueRule("canonical_conflict", observation()).verdict, "ABSENT");
  assert.equal(
    evaluateIssueRule("canonical_conflict", observation({ canonical: null, fieldValidity: { canonical: "UNKNOWN" } }))
      .verdict,
    "UNKNOWN",
  );
});

test("issue state machine: unknown keeps, absent resolves, reopen bumps occurrence", () => {
  assert.deepEqual(nextIssueState(null, "PRESENT"), { nextState: "OPEN", reopen: false });
  assert.deepEqual(nextIssueState(null, "ABSENT"), { nextState: null, reopen: false });
  assert.deepEqual(nextIssueState("OPEN", "UNKNOWN"), { nextState: null, reopen: false });
  assert.deepEqual(nextIssueState("OPEN", "ABSENT"), { nextState: "RESOLVED", reopen: false });
  assert.deepEqual(nextIssueState("RESOLVED", "UNKNOWN"), { nextState: null, reopen: false });
  assert.deepEqual(nextIssueState("RESOLVED", "PRESENT"), { nextState: "OPEN", reopen: true });
  assert.deepEqual(nextIssueState("OPEN", "PRESENT"), { nextState: null, reopen: false });
  assert.deepEqual(nextIssueState("RESOLVED", "ABSENT"), { nextState: null, reopen: false });
});
