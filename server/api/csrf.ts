import { ApiError } from "./errors.ts";
import { getConfigSafe } from "../config.ts";

/**
 * CSRF protection for state-changing requests (docs/ARCHITECTURE.md §10):
 * browsers send an Origin header on every cross-site (and same-site POST)
 * request, so an Origin that exists and does not match the configured app
 * origin is rejected. Clients that send no Origin at all (curl, server-side)
 * are not part of the browser CSRF model and pass through. The SameSite
 * session cookie remains the first line of defence.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string | null): boolean {
  return method !== null && SAFE_METHODS.has(method.toUpperCase());
}

/** Extract the request's effective origin (scheme://host[:port]). */
export function requestOrigin(request: Request): string | null {
  const header = request.headers.get("origin");
  if (header === null) return null;
  try {
    return new URL(header).origin;
  } catch {
    return null;
  }
}

/** Expected origin: the configured APP_ORIGIN, else the request's own origin. */
export function expectedOrigin(request: Request): string | null {
  const configured = getConfigSafe()?.origin ?? null;
  if (configured !== null) return configured;
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

/**
 * Throws 403 when the request carries a browser Origin that does not match
 * the app origin. Missing Origin headers are allowed (non-browser clients).
 */
export function assertSameOrigin(request: Request): void {
  if (isSafeMethod(request.method)) return;
  if (!request.headers.has("origin")) return;
  const origin = requestOrigin(request);
  if (origin === null || origin === "null" || origin !== expectedOrigin(request)) {
    throw ApiError.forbidden("Cross-origin request rejected");
  }
}
