import test from "node:test";
import assert from "node:assert/strict";
import { isSameDomain, normalizeUrl } from "@seo/crawler";

test("identity v1 preserves trailing slash, query order, duplicates, and tracking parameters", () => {
  assert.equal(
    normalizeUrl("HTTPS://Example.COM:443/a/?utm_source=x&b=2&a=1&a=1#top"),
    "https://example.com/a/?utm_source=x&b=2&a=1&a=1",
  );
});

test("tracking parameters are removed only when explicitly configured", () => {
  const url = "https://example.com/a/?UTM_Source=x&b=2";
  assert.equal(normalizeUrl(url), "https://example.com/a/?UTM_Source=x&b=2");
  assert.equal(normalizeUrl(url, undefined, { stripTrackingParameters: true }), "https://example.com/a/?b=2");
});

test("non-default-port removal applies to http:80 and https:443 only", () => {
  assert.equal(normalizeUrl("http://Example.com:80/a"), "http://example.com/a");
  assert.equal(normalizeUrl("https://example.com:443/a"), "https://example.com/a");
});

test("resolves relative internal links and checks exact-hostname scope", () => {
  const url = normalizeUrl("../pricing/", "https://example.com/docs/start");
  assert.equal(url, "https://example.com/pricing/");
  assert.equal(isSameDomain(url, "https://example.com"), true);
  assert.equal(isSameDomain("https://cdn.example.com/a", "https://example.com"), false);
  assert.equal(isSameDomain("https://www.example.com/", "https://example.com"), false);
});
