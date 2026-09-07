/**
 * URL identity v1 (docs/ARCHITECTURE.md §6).
 *
 * The default identity performs only: standard WHATWG parsing, lowercase
 * scheme and hostname, default-port removal, and dropping the fragment.
 * Trailing slashes, path case, query values, order, and duplicate parameters
 * are all preserved. Removing tracking parameters is explicit configuration
 * and changes identity semantics — callers that enable it must record a new
 * identityVersion.
 */

export const TRACKING_PARAMETERS: ReadonlySet<string> = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
]);

export interface UrlIdentityOptions {
  /** Remove known tracking parameters. Requires a new identityVersion and scopeGeneration. */
  stripTrackingParameters?: boolean;
}

export function normalizeUrl(input: string | URL, base?: string | URL, options: UrlIdentityOptions = {}): string {
  const url = new URL(input, base);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  url.protocol = url.protocol.toLowerCase();
  if (options.stripTrackingParameters) {
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
  }
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  return url.toString();
}
