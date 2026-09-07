import { isIP } from "node:net";
import { classifyIpAddress } from "./address-classification.ts";

/**
 * Literal crawl-target safety checks (docs/ARCHITECTURE.md §11).
 *
 * This is the syntactic layer only: protocol, credentials, ports, localhost
 * names, and literal IP addresses. It does not resolve DNS — the fetch worker
 * (P2) must resolve the hostname and re-run the address classification against
 * every resolved address, including after each redirect.
 */

export const UNSAFE_CRAWL_URL_CODES = [
  "UNSUPPORTED_PROTOCOL",
  "CREDENTIALS_NOT_ALLOWED",
  "NON_DEFAULT_PORT",
  "BLOCKED_HOST",
] as const;
export type UnsafeCrawlUrlCode = (typeof UNSAFE_CRAWL_URL_CODES)[number];

export class UnsafeCrawlUrlError extends Error {
  readonly code: UnsafeCrawlUrlCode;

  constructor(code: UnsafeCrawlUrlCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "UnsafeCrawlUrlError";
  }
}

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

export function assertSafeCrawlUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new UnsafeCrawlUrlError("BLOCKED_HOST", "Crawl target is not a valid URL", { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeCrawlUrlError("UNSUPPORTED_PROTOCOL", "Only HTTP and HTTPS URLs are supported");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeCrawlUrlError("CREDENTIALS_NOT_ALLOWED", "Credentials in crawl URLs are not allowed");
  }
  if (url.port !== "") {
    throw new UnsafeCrawlUrlError("NON_DEFAULT_PORT", "Only the default HTTP and HTTPS ports are supported");
  }

  const hostname = stripBrackets(url.hostname.toLowerCase());
  // Trailing dots are legal DNS syntax; compare them away for the localhost checks.
  const bare = hostname.replace(/\.+$/, "");
  const address = bare.split("%", 1)[0];

  const isLocalhost = bare === "localhost" || bare.endsWith(".localhost");
  const isBlockedAddress = isIP(address) !== 0 && classifyIpAddress(address) !== "PUBLIC";
  if (isLocalhost || isBlockedAddress) {
    throw new UnsafeCrawlUrlError("BLOCKED_HOST", "Local and private crawl targets are not allowed");
  }
  return url;
}
