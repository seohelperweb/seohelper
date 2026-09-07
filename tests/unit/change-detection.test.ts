import test from "node:test";
import assert from "node:assert/strict";
import { compareSnapshots, summarizeChanges } from "@seo/change-detection";
import type { PageSnapshot } from "@seo/contracts";

const page = (url: string, overrides: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url,
  statusCode: 200,
  robots: "index",
  canonical: url,
  title: "Title",
  metaDescription: "Description",
  internalLinksCount: 10,
  ...overrides,
});

test("detects meaningful page changes and classifies severity", () => {
  const previous = [page("https://example.com/a"), page("https://example.com/removed")];
  const current = [
    page("https://example.com/a", { statusCode: 404, robots: "noindex", title: "New title" }),
    page("https://example.com/new"),
  ];
  const changes = compareSnapshots(previous, current);
  assert.deepEqual(
    changes.map(({ type }) => type),
    ["HTTP_STATUS_CHANGED", "ROBOTS_CHANGED", "TITLE_CHANGED", "URL_ADDED", "URL_REMOVED"],
  );
  assert.equal(changes[0].severity, "CRITICAL");
  assert.equal(changes[2].severity, "WARNING");
  assert.deepEqual(summarizeChanges(changes), {
    total: 5,
    critical: 2,
    warning: 1,
    info: 2,
    byType: { HTTP_STATUS_CHANGED: 1, ROBOTS_CHANGED: 1, TITLE_CHANGED: 1, URL_ADDED: 1, URL_REMOVED: 1 },
  });
});

test("does not emit changes for identical snapshots", () => {
  const snapshot = [page("https://example.com")];
  assert.deepEqual(compareSnapshots(snapshot, snapshot), []);
});

test("keeps non-critical status changes at info severity", () => {
  const previous = [page("https://example.com/a", { statusCode: 301 })];
  const current = [page("https://example.com/a", { statusCode: 302 })];
  const changes = compareSnapshots(previous, current);
  assert.equal(changes[0].severity, "INFO");
});
