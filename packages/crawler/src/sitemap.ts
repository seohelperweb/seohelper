import * as cheerio from "cheerio";

/**
 * Sitemap parsing (docs/ARCHITECTURE.md §7.3): <sitemapindex> and <urlset>
 * documents; recursion depth ≤ 3, ≤ 20 documents, ≤ 20,000 candidate URLs,
 * DTD/external entities disabled by Cheerio's default XML mode.
 */

export const SITEMAP_LIMITS = { maxDepth: 3, maxDocuments: 20, maxCandidateUrls: 20_000 } as const;

export interface ParsedSitemap {
  kind: "INDEX" | "URLSET" | "UNKNOWN";
  /** From <sitemapindex><sitemap><loc>. */
  sitemapUrls: string[];
  /** From <urlset><url><loc>. */
  pageUrls: string[];
}

export function parseSitemap(xml: string): ParsedSitemap {
  const $ = cheerio.load(xml, { xmlMode: true });
  const locs = (selector: string) =>
    $(selector)
      .map((_, element) => $(element).text().trim())
      .get()
      .filter((value) => value !== "" && value.length <= 8 * 1024);

  const isIndex = $("sitemapindex").length > 0;
  const isUrlset = $("urlset").length > 0;
  if (isIndex) {
    return { kind: "INDEX", sitemapUrls: locs("sitemap > loc"), pageUrls: [] };
  }
  if (isUrlset) {
    return { kind: "URLSET", sitemapUrls: [], pageUrls: locs("url > loc") };
  }
  return { kind: "UNKNOWN", sitemapUrls: [], pageUrls: [] };
}

/** Enforce document/candidate budgets across a sitemap walk (docs §7.3). */
export function collectSitemapCandidates(
  root: ParsedSitemap,
  fetchIndex: (url: string) => ParsedSitemap | null,
): { urls: string[]; truncated: boolean } {
  const urls: string[] = [];
  const seen = new Set<string>();
  const truncated = { value: false };
  let documents = 1;

  const addPages = (pages: string[]) => {
    for (const page of pages) {
      if (urls.length >= SITEMAP_LIMITS.maxCandidateUrls) {
        truncated.value = true;
        return;
      }
      if (!seen.has(page)) {
        seen.add(page);
        urls.push(page);
      }
    }
  };

  addPages(root.pageUrls);
  const queue = [...root.sitemapUrls];
  while (queue.length > 0 && documents < SITEMAP_LIMITS.maxDocuments && urls.length < SITEMAP_LIMITS.maxCandidateUrls) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    documents += 1;
    const child = fetchIndex(next);
    if (!child) continue; // unreachable child sitemaps are skipped, not fatal
    addPages(child.pageUrls);
    for (const grandChild of child.sitemapUrls) {
      if (documents + queue.length < SITEMAP_LIMITS.maxDocuments) queue.push(grandChild);
    }
  }
  if (queue.length > 0 && documents >= SITEMAP_LIMITS.maxDocuments) truncated.value = true;
  return { urls, truncated: truncated.value };
}
