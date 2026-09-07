import test from "node:test";
import assert from "node:assert/strict";
import { collectSitemapCandidates, parseSitemap, SITEMAP_LIMITS } from "@seo/crawler";
import { extractPage, isHtmlContentType, synthesizeIndexState } from "@seo/crawler";

test("parses urlset and sitemapindex documents", () => {
  const urlset = parseSitemap(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://example.com/a</loc></url>
    <url><loc>https://example.com/b</loc></url>
  </urlset>`);
  assert.equal(urlset.kind, "URLSET");
  assert.deepEqual(urlset.pageUrls, ["https://example.com/a", "https://example.com/b"]);

  const index = parseSitemap(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>https://example.com/s1.xml</loc></sitemap>
  </sitemapindex>`);
  assert.equal(index.kind, "INDEX");
  assert.deepEqual(index.sitemapUrls, ["https://example.com/s1.xml"]);
  assert.equal(parseSitemap("<html>not a sitemap</html>").kind, "UNKNOWN");
});

test("sitemap walk respects the document budget", () => {
  const root = {
    kind: "INDEX" as const,
    sitemapUrls: Array.from({ length: 50 }, (_, i) => `https://example.com/s${i}.xml`),
    pageUrls: [],
  };
  const fetched = new Set<string>();
  const { urls, truncated } = collectSitemapCandidates(root, (url) => {
    fetched.add(url);
    const prefix = url.replace(".xml", "/p");
    return { kind: "URLSET", sitemapUrls: [], pageUrls: Array.from({ length: 30 }, (_, i) => `${prefix}${i}`) };
  });
  assert.equal(fetched.size, SITEMAP_LIMITS.maxDocuments - 1); // 1 root + (max-1) children
  assert.equal(urls.length, (SITEMAP_LIMITS.maxDocuments - 1) * 30);
  assert.equal(truncated, true);
});

test("candidate budget caps the walk", () => {
  const many = Array.from({ length: SITEMAP_LIMITS.maxCandidateUrls + 50 }, (_, i) => `https://example.com/x${i}`);
  const root = { kind: "URLSET" as const, sitemapUrls: [], pageUrls: many };
  const { urls, truncated } = collectSitemapCandidates(root, () => null);
  assert.equal(urls.length, SITEMAP_LIMITS.maxCandidateUrls);
  assert.equal(truncated, true);
});

const page = `
<html>
  <head>
    <base href="/docs/">
    <title>Docs Home</title>
    <meta name="description" content="Guide">
    <link rel="canonical" href="https://example.com/docs">
    <link rel="canonical" href="/other">
    <meta name="robots" content="index, follow">
  </head>
  <body>
    <a href="start">Intro</a>
    <a href="/pricing/">Plans</a>
    <a href="/pricing/">Duplicate</a>
    <a href="https://cdn.example.com/x">External</a>
    <a href="mailto:hi@example.com">Mail</a>
    <a href="#top">Anchor</a>
  </body>
</html>`;

test("extracts title, description, canonicals, robots, and internal links", () => {
  const result = extractPage(page, "https://example.com/docs/");
  assert.equal(result.title, "Docs Home");
  assert.equal(result.metaDescription, "Guide");
  assert.deepEqual(result.canonicalRaw, ["https://example.com/docs", "/other"]);
  assert.deepEqual(result.canonicalResolved, ["https://example.com/docs", "https://example.com/other"]);
  assert.deepEqual(result.robotsRaw, ["index, follow"]);
  assert.equal(result.robotsIndex, "ALLOWED");
  // base href /docs/ resolves "start"; external/mail/anchor links excluded; duplicates collapsed.
  assert.deepEqual(result.internalLinks, ["https://example.com/docs/start", "https://example.com/pricing/"]);
});

test("index state synthesis: noindex/none win, any directive set otherwise allows", () => {
  assert.equal(synthesizeIndexState([]), "UNKNOWN");
  assert.equal(synthesizeIndexState(["index, follow"]), "ALLOWED");
  assert.equal(synthesizeIndexState(["follow"]), "ALLOWED");
  assert.equal(synthesizeIndexState(["noindex, follow"]), "DISALLOWED");
  assert.equal(synthesizeIndexState(["none"]), "DISALLOWED");
  assert.equal(synthesizeIndexState(["index", "noindex"]), "DISALLOWED");
});

test("content type gate accepts html variants only", () => {
  assert.equal(isHtmlContentType("text/html; charset=utf-8"), true);
  assert.equal(isHtmlContentType("application/xhtml+xml"), true);
  assert.equal(isHtmlContentType("application/pdf"), false);
  assert.equal(isHtmlContentType(null), false);
});

test("missing optional fields stay null rather than empty strings", () => {
  const result = extractPage("<html><head></head><body></body></html>", "https://example.com/");
  assert.equal(result.title, null);
  assert.equal(result.metaDescription, null);
  assert.deepEqual(result.canonicalRaw, []);
  assert.equal(result.robotsIndex, "UNKNOWN");
  assert.deepEqual(result.internalLinks, []);
});
