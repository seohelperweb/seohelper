/**
 * In-memory sliding-window rate limiter for authentication endpoints
 * (brute-force defence). Per-process only — adequate for the single-worker
 * first version; a shared store (Redis/Postgres) is required if auth runs
 * across many processes (docs/ARCHITECTURE.md §12 keeps config in one place).
 */

export interface RateLimitRule {
  windowMs: number;
  max: number;
}

const AUTH_LIMITS: Record<string, RateLimitRule> = {
  "sign-in/email": { windowMs: 15 * 60_000, max: 20 },
  "sign-up/email": { windowMs: 60 * 60_000, max: 20 },
  "send-verification-email": { windowMs: 60 * 60_000, max: 10 },
};

const buckets = new Map<string, number[]>();
let lastCleanup = 0;

/** Drop expired windows so the map cannot grow without bound. */
export function cleanupBuckets(now: number = Date.now()): void {
  for (const [key, timestamps] of buckets) {
    const recent = timestamps.filter((timestamp) => timestamp > now - 24 * 60 * 60 * 1000);
    if (recent.length === 0) buckets.delete(key);
    else buckets.set(key, recent);
  }
}

/** Returns true when the request is within budget (allowed). */
export function checkAuthRateLimit(path: string, subject: string, now: number = Date.now()): boolean {
  if (now - lastCleanup >= 60_000) {
    cleanupBuckets(now);
    lastCleanup = now;
  }
  // path like "/api/auth/sign-in/email"
  const route = path.replace(/^\/api\/auth\//, "").replace(/\/$/, "");
  const rule = AUTH_LIMITS[route];
  if (!rule) return true;
  const key = `${route}:${subject.toLowerCase()}`;
  const recent = (buckets.get(key) ?? []).filter((timestamp) => timestamp > now - rule.windowMs);
  if (recent.length >= rule.max) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}

/** Best-effort client identity: forwarded IP, else the peer address, else unknown. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  const connection = (request as Request & { ip?: string }).ip;
  return connection ?? "unknown";
}

export function authRateLimitExceeded(path: string, request: Request): boolean {
  const route = path.replace(/^\/api\/auth\//, "").replace(/\/$/, "");
  const rule = AUTH_LIMITS[route];
  if (!rule) return false;
  return !checkAuthRateLimit(path, clientKey(request));
}

export function authRateLimitWindowMs(path: string): number | null {
  const route = path.replace(/^\/api\/auth\//, "").replace(/\/$/, "");
  return AUTH_LIMITS[route]?.windowMs ?? null;
}
