import * as cheerio from "cheerio";
import { normalizeUrl } from "./url-identity.ts";
import type { RobotsIndexState } from "@seo/contracts";

/**
 * HTML field extraction (docs/ARCHITECTURE.md §6). Cheerio only parses the
 * downloaded document — no network loading. Values reflect "parsed HTML but
 * field absent" (empty strings stay empty, missing tags stay null); callers
 * map failures to UNKNOWN via fieldValidity.
 */

export interface ExtractedPage {
  title: string | null;
  metaDescription: string | null;
  /** Raw canonical href attributes in document order; duplicates preserved. */
  canonicalRaw: string[];
  /** Canonical candidates resolved absolute against base/final URL. */
  canonicalResolved: string[];
  /** robots meta content values (may be several meta tags). */
  robotsRaw: string[];
  /** Index state synthesized per Googlebot rules: any noindex wins. */
  robotsIndex: RobotsIndexState;
  /** Distinct same-host link targets resolved via identity v1 (not a health claim). */
  internalLinks: string[];
}

const NON_HTML_HINT = /^(text\/html|application\/xhtml\+xml)/i;

export function isHtmlContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  return NON_HTML_HINT.test(contentType.split(";")[0]?.trim() ?? "");
}

export function extractPage(html: string, finalUrl: string): ExtractedPage {
  const $ = cheerio.load(html);
  const rawBase = $("base[href]").first().attr("href");
  // <base href> may itself be root-relative ("/docs/") — resolve it against the final URL first.
  let baseUrl: URL;
  try {
    baseUrl = rawBase ? new URL(rawBase, finalUrl) : new URL(finalUrl);
  } catch {
    baseUrl = new URL(finalUrl);
  }
  const resolve = (href: string): string | null => {
    try {
      return normalizeUrl(href, baseUrl);
    } catch {
      return null;
    }
  };

  const titleText = $("title").first().text().trim();
  const metaDescription = $('meta[name="description"]').first().attr("content")?.trim() ?? null;

  const canonicalRaw: string[] = [];
  const canonicalResolved: string[] = [];
  $('link[rel="canonical"][href]').each((_, element) => {
    const href = $(element).attr("href");
    if (href === undefined) return;
    canonicalRaw.push(href);
    const resolved = resolve(href);
    if (resolved !== null) canonicalResolved.push(resolved);
  });

  const robotsRaw: string[] = [];
  $('meta[name="robots"]').each((_, element) => {
    const content = $(element).attr("content");
    if (content) robotsRaw.push(content);
  });

  const finalHost = new URL(finalUrl).hostname.toLowerCase();
  const internalTargets = new Set<string>();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("javascript:")
    ) {
      return;
    }
    const resolved = resolve(href);
    if (resolved === null) return;
    try {
      if (new URL(resolved).hostname.toLowerCase() === finalHost) internalTargets.add(resolved);
    } catch {
      /* unreachable after normalize */
    }
  });

  return {
    title: titleText === "" ? null : titleText,
    metaDescription: metaDescription === "" ? null : metaDescription,
    canonicalRaw,
    canonicalResolved,
    robotsRaw,
    robotsIndex: synthesizeIndexState(robotsRaw),
    internalLinks: [...internalTargets],
  };
}

/**
 * Synthesize the effective index state from robots meta / X-Robots-Tag
 * directives (docs §6): directives split by comma; `noindex`/`none` always
 * wins; any directive set without a restriction implies allowed (Googlebot
 * semantics); an empty directive list means "no information" → UNKNOWN —
 * callers that parsed the HTML decide ALLOWED themselves.
 */
export function synthesizeIndexState(directiveSources: string[]): RobotsIndexState {
  const tokens = new Set<string>();
  for (const source of directiveSources) {
    for (const token of source.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized !== "") tokens.add(normalized);
    }
  }
  if (tokens.size === 0) return "UNKNOWN";
  if (tokens.has("noindex") || tokens.has("none")) return "DISALLOWED";
  return "ALLOWED";
}
