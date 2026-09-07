import { createDnsResolver, createNodeTransport, safeFetch } from "@seo/crawler";
import type { SafeFetchResult } from "@seo/crawler";

/**
 * Production fetcher: the real DNS resolver + node transport wired through
 * safeFetch. Tests inject their own fetcher — the production stack never
 * gains an "allow internal targets" switch (docs/ARCHITECTURE.md §5).
 *
 * Per-request limits come from the project policy (ProjectPolicy.config);
 * unspecified values fall back to the crawler package defaults. The same
 * limit caps the compressed stream (transport) and the decoded body
 * (safeFetch), mirroring docs §7.3.
 */
export interface FetcherLimits {
  requestTimeoutMs: number;
  maxRedirects: number;
  maxBodyBytes: number;
}

const DEFAULT_LIMITS: FetcherLimits = {
  requestTimeoutMs: 20_000,
  maxRedirects: 5,
  maxBodyBytes: 2 * 1024 * 1024,
};

export function createProductionFetcher(
  hostname: string,
  userAgent: string,
  limits?: Partial<FetcherLimits>,
): (url: string) => Promise<SafeFetchResult> {
  const resolved: FetcherLimits = { ...DEFAULT_LIMITS, ...limits };
  const dns = createDnsResolver();
  const transport = createNodeTransport(dns, {
    timeoutMs: resolved.requestTimeoutMs,
    maxBodyBytes: resolved.maxBodyBytes,
  });
  return (url) =>
    safeFetch(url, {
      resolveDns: dns,
      transport,
      allowedHostname: hostname,
      userAgent,
      limits: resolved,
    });
}
