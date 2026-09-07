import { assertSafeCrawlUrl } from "./safe-url.ts";
import { classifyIpAddress } from "./address-classification.ts";

/**
 * Safe crawl transport (docs/ARCHITECTURE.md §11).
 *
 * Every hop — the root URL and each redirect — goes through the same checks:
 * literal URL policy, exact-hostname scope, DNS resolution with EVERY resolved
 * address classified as public, then a bounded response read. The transport is
 * injected so tests run without real sockets; production wiring lives in
 * node-transport.ts. No code path may bypass these checks.
 */

export type DnsResolver = (hostname: string) => Promise<string[]>;

export interface TransportRequest {
  url: URL;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}

/** Executes one HTTP(S) request. MUST NOT follow redirects by itself. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export const DEFAULT_FETCH_LIMITS = {
  maxRedirects: 5,
  maxBodyBytes: 2 * 1024 * 1024,
  requestTimeoutMs: 20_000,
  maxUrlLength: 8 * 1024,
} as const;

/** Mutable limit shape: callers may override any subset with plain numbers. */
export interface SafeFetchLimits {
  maxRedirects: number;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  maxUrlLength: number;
}

export interface SafeFetchResult {
  requestUrl: string;
  finalUrl: string | null;
  outcome:
    | "HTTP_RESPONSE"
    | "REDIRECT_BLOCKED"
    | "SECURITY_BLOCKED"
    | "SCOPE_BLOCKED"
    | "NETWORK_ERROR"
    | "BODY_TOO_LARGE"
    | "TIMEOUT"
    | "REDIRECT_LIMIT";
  initialStatus: number | null;
  finalStatus: number | null;
  redirectChain: Array<{ url: string; status: number; location: string }>;
  contentType: string | null;
  /** Combined X-Robots-Tag header values, fed into the index-state synthesis. */
  xRobotsTag: string | null;
  body: Uint8Array | null;
  error: string | null;
}

export interface SafeFetchOptions {
  resolveDns: DnsResolver;
  transport: Transport;
  /** Exact-hostname scope of the project; redirect targets outside are recorded, not followed. */
  allowedHostname: string;
  userAgent: string;
  limits?: Partial<SafeFetchLimits>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function readCappedBody(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | "BODY_TOO_LARGE"> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) return "BODY_TOO_LARGE";
    chunks.push(chunk);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function validateResolvedAddresses(resolveDns: DnsResolver, url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolveDns(hostname);
  if (addresses.length === 0) {
    throw new SafeFetchError("NETWORK_ERROR", `DNS returned no addresses for ${hostname}`);
  }
  // Any non-public resolved address rejects the whole request (docs §11.3).
  for (const address of addresses) {
    if (classifyIpAddress(address) !== "PUBLIC") {
      throw new SafeFetchError("SECURITY_BLOCKED", `Resolved address ${address} for ${hostname} is not public`);
    }
  }
}

export class SafeFetchError extends Error {
  readonly outcome: SafeFetchResult["outcome"];

  constructor(outcome: SafeFetchResult["outcome"], message: string) {
    super(message);
    this.outcome = outcome;
    this.name = "SafeFetchError";
  }
}

/** Thrown by transports when the COMPRESSED byte stream exceeds its cap; safeFetch maps it to BODY_TOO_LARGE. */
export class BodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyTooLargeError";
  }
}

/** Fetch one URL through the full safety pipeline, following redirects manually. */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const limits = { ...DEFAULT_FETCH_LIMITS, ...options.limits };
  const result: SafeFetchResult = {
    requestUrl: rawUrl,
    finalUrl: null,
    outcome: "NETWORK_ERROR",
    initialStatus: null,
    finalStatus: null,
    redirectChain: [],
    contentType: null,
    xRobotsTag: null,
    body: null,
    error: null,
  };
  const allowedHostname = options.allowedHostname.toLowerCase();

  let current: URL;
  try {
    current = assertSafeCrawlUrl(rawUrl);
  } catch (cause) {
    return { ...result, outcome: "SECURITY_BLOCKED", error: cause instanceof Error ? cause.message : "invalid URL" };
  }
  if (rawUrl.length > limits.maxUrlLength) {
    return { ...result, outcome: "SECURITY_BLOCKED", error: "URL exceeds maximum length" };
  }
  if (current.hostname !== allowedHostname) {
    return { ...result, outcome: "SCOPE_BLOCKED", error: `target ${current.hostname} is outside project scope` };
  }

  let redirects = 0;
  // Each iteration = one hop with the full check pipeline; redirects restart it.
  for (;;) {
    if (current.hostname !== allowedHostname) {
      return {
        ...result,
        outcome: "REDIRECT_BLOCKED",
        finalUrl: null,
        error: `redirect target ${current.hostname} is out of scope`,
      };
    }
    try {
      await validateResolvedAddresses(options.resolveDns, current);
    } catch (error) {
      const outcome = error instanceof SafeFetchError ? error.outcome : "NETWORK_ERROR";
      return { ...result, outcome, error: error instanceof Error ? error.message : "DNS failure" };
    }

    let response: TransportResponse;
    try {
      response = await options.transport({
        url: current,
        headers: { "user-agent": options.userAgent, accept: "text/html,application/xhtml+xml" },
        timeoutMs: limits.requestTimeoutMs,
      });
    } catch (error) {
      const outcome = error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR";
      return { ...result, outcome, error: error instanceof Error ? error.message : "transport failure" };
    }

    if (result.initialStatus === null) result.initialStatus = response.status;
    result.finalStatus = response.status;
    result.contentType = response.headers["content-type"] ?? null;
    result.xRobotsTag = response.headers["x-robots-tag"] ?? null;
    result.finalUrl = current.toString();

    const location = response.headers["location"];
    if (REDIRECT_STATUSES.has(response.status) && location) {
      if (location.length > limits.maxUrlLength) {
        return { ...result, outcome: "SECURITY_BLOCKED", error: "Redirect location exceeds maximum length" };
      }
      let target: URL;
      try {
        target = assertSafeCrawlUrl(new URL(location, current).toString());
      } catch (cause) {
        return {
          ...result,
          outcome: "SECURITY_BLOCKED",
          error: cause instanceof Error ? cause.message : "invalid redirect location",
        };
      }
      result.redirectChain.push({ url: current.toString(), status: response.status, location });
      if (redirects >= limits.maxRedirects) {
        return { ...result, outcome: "REDIRECT_LIMIT", error: `more than ${limits.maxRedirects} redirects` };
      }
      redirects += 1;
      current = target;
      continue;
    }

    let body: Uint8Array | "BODY_TOO_LARGE";
    try {
      body = await readCappedBody(response.body, limits.maxBodyBytes);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return { ...result, outcome: "TIMEOUT", error: error.message };
      }
      if (error instanceof BodyTooLargeError) {
        return { ...result, outcome: "BODY_TOO_LARGE", error: error.message };
      }
      return {
        ...result,
        outcome: "NETWORK_ERROR",
        error: error instanceof Error ? error.message : "body read failure",
      };
    }
    if (body === "BODY_TOO_LARGE") {
      return { ...result, outcome: "BODY_TOO_LARGE", error: `response body exceeded ${limits.maxBodyBytes} bytes` };
    }
    return { ...result, outcome: "HTTP_RESPONSE", body };
  }
}
