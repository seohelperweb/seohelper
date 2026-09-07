import test from "node:test";
import assert from "node:assert/strict";
import { compareObservations, summarizeObservationChanges } from "@seo/change-detection";
import type { ComparableObservation } from "@seo/change-detection";

const KNOWN_FIELDS = {
  title: "KNOWN",
  metaDescription: "KNOWN",
  canonical: "KNOWN",
  robots: "KNOWN",
  internalLinksCount: "KNOWN",
};

const observation = (pageId: string, overrides: Partial<ComparableObservation> = {}): ComparableObservation => ({
  pageId,
  identityUrl: `https://example.com/${pageId}`,
  fetchOutcome: "HTTP_RESPONSE",
  initialStatus: 200,
  title: "Title",
  metaDescription: "Desc",
  canonical: { raw: [`https://example.com/${pageId}`], resolved: [`https://example.com/${pageId}`] },
  robots: { raw: ["index"], index: "ALLOWED" },
  internalLinksCount: 5,
  fieldValidity: KNOWN_FIELDS,
  ...overrides,
});

test("emits severity-classified events only for KNOWN, comparable fields", () => {
  const base = [observation("a"), observation("b")];
  const current = [
    observation("a", { initialStatus: 404, title: "New", fieldValidity: { ...KNOWN_FIELDS } }),
    observation("b", { robots: { raw: ["noindex"], index: "DISALLOWED" } }),
  ];
  const changes = compareObservations(base, current, true);
  assert.deepEqual(
    changes.map((c) => c.type),
    ["HTTP_STATUS_CHANGED", "TITLE_CHANGED", "ROBOTS_CHANGED"],
  );
  assert.equal(changes[0].severity, "CRITICAL");
  assert.equal(changes[1].severity, "WARNING");
  assert.equal(changes[2].severity, "CRITICAL");
});

test("error pages and redirect sources are not content-compared", () => {
  const base = [observation("a")];
  // Side becomes an error page: only the HTTP fact counts, fields are UNKNOWN.
  const current = [
    observation("a", {
      initialStatus: 500,
      title: null,
      robots: null,
      fieldValidity: {
        title: "UNKNOWN",
        metaDescription: "UNKNOWN",
        canonical: "UNKNOWN",
        robots: "UNKNOWN",
        internalLinksCount: "UNKNOWN",
      },
    }),
  ];
  const changes = compareObservations(base, current, true);
  assert.deepEqual(
    changes.map((c) => c.type),
    ["HTTP_STATUS_CHANGED"],
  );
  assert.equal(changes[0].severity, "CRITICAL");

  // Redirect source (NOT_APPLICABLE fields) keeps status facts only.
  const redirectSource = observation("a", {
    initialStatus: 301,
    fieldValidity: {
      title: "NOT_APPLICABLE",
      metaDescription: "NOT_APPLICABLE",
      canonical: "NOT_APPLICABLE",
      robots: "NOT_APPLICABLE",
      internalLinksCount: "NOT_APPLICABLE",
    },
  });
  const onlyStatus = compareObservations(base, [redirectSource], true);
  assert.deepEqual(
    onlyStatus.map((c) => c.type),
    ["HTTP_STATUS_CHANGED"],
  );
  assert.equal(onlyStatus[0].severity, "INFO", "301→200-healthy page change is not critical");
});

test("URL_ADDED only when a base exists; absence never emits URL_REMOVED", () => {
  const base = [observation("a")];
  const current = [observation("a"), observation("new")];
  const withBase = compareObservations(base, current, true);
  assert.ok(withBase.some((c) => c.type === "URL_ADDED" && c.pageId === "new"));
  assert.equal(
    withBase.some((c) => c.type === "URL_REMOVED"),
    false,
  );

  const firstRun = compareObservations([], current, false);
  assert.equal(firstRun.length, 0, "baseline run reports no additions");
});

test("unknown verdicts on either side suppress content events", () => {
  const base = [observation("a", { fieldValidity: { ...KNOWN_FIELDS, title: "UNKNOWN" } })];
  const current = [observation("a", { title: "Changed" })];
  assert.equal(compareObservations(base, current, true).length, 0);
});

test("summary separates event counts from affected pages", () => {
  const base = [observation("a"), observation("b")];
  const current = [
    observation("a", { title: "New", metaDescription: "New desc" }),
    observation("b", { initialStatus: 500 }),
  ];
  const changes = compareObservations(base, current, true);
  const summary = summarizeObservationChanges(changes);
  assert.equal(summary.total, 3);
  assert.equal(summary.critical, 1);
  assert.equal(summary.warning, 2);
  assert.equal(summary.info, 0);
  assert.equal(summary.affectedPages, 2);
});
