/**
 * Shared contracts for the Indexly packages: DTOs, enums, API error codes,
 * and the runtime environment schema.
 *
 * Contracts stay dependency-light and pure: no imports from Next.js, Prisma,
 * the queue, or network code (see docs/ARCHITECTURE.md §3).
 */

export const SEVERITIES = ["CRITICAL", "WARNING", "INFO"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CHANGE_EVENT_TYPES = [
  "URL_ADDED",
  "URL_REMOVED",
  "HTTP_STATUS_CHANGED",
  "ROBOTS_CHANGED",
  "CANONICAL_CHANGED",
  "TITLE_CHANGED",
  "META_DESCRIPTION_CHANGED",
  "INTERNAL_LINKS_CHANGED",
] as const;
export type ChangeEventType = (typeof CHANGE_EVENT_TYPES)[number];

/**
 * Page facts captured for one URL in a crawl snapshot.
 *
 * This is the current MVP shape. Field-level validity (KNOWN / UNKNOWN /
 * NOT_APPLICABLE), redirect chains, and rule versions arrive with the full
 * observation contract in P3; `robots` will become a structured index state
 * instead of a raw string.
 */
export interface PageSnapshot {
  url: string;
  statusCode: number;
  robots: string;
  canonical: string;
  title: string;
  metaDescription: string;
  internalLinksCount: number;
}

/** A single fact observed between two comparable snapshots. */
export interface ChangeEvent {
  url: string;
  type: ChangeEventType;
  before: string | number | null;
  after: string | number | null;
  severity: Severity;
}

export interface ChangeSummary {
  total: number;
  critical: number;
  warning: number;
  info: number;
  byType: Partial<Record<ChangeEventType, number>>;
}

/** Stable API error codes (docs/ARCHITECTURE.md §10). */
export const ERROR_CODES = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  VERIFICATION_REQUIRED: "VERIFICATION_REQUIRED",
  CRAWL_ALREADY_ACTIVE: "CRAWL_ALREADY_ACTIVE",
  CRAWL_ALREADY_FINISHED: "CRAWL_ALREADY_FINISHED",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ApiSuccessBody<T> {
  data: T;
  requestId: string;
}

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
  requestId: string;
}

export { EnvConfigError, envSchema, parseEnv } from "./env.ts";
export type { AppConfig, LogLevel } from "./env.ts";

// ---------------------------------------------------------------------------
// Page observation contract (docs/ARCHITECTURE.md §6)
// ---------------------------------------------------------------------------

export const FETCH_OUTCOMES = [
  "HTTP_RESPONSE",
  "REDIRECT_BLOCKED",
  "SECURITY_BLOCKED",
  "SCOPE_BLOCKED",
  "ROBOTS_BLOCKED",
  "NETWORK_ERROR",
  "BODY_TOO_LARGE",
  "TIMEOUT",
  "REDIRECT_LIMIT",
] as const;
export type FetchOutcome = (typeof FETCH_OUTCOMES)[number];

export const FIELD_VALIDITY_STATES = ["KNOWN", "UNKNOWN", "NOT_APPLICABLE"] as const;
export type FieldValidity = (typeof FIELD_VALIDITY_STATES)[number];

export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

export const ROBOTS_INDEX_STATES = ["ALLOWED", "DISALLOWED", "UNKNOWN"] as const;
export type RobotsIndexState = (typeof ROBOTS_INDEX_STATES)[number];

export interface PageObservationDraft {
  requestUrl: string;
  finalUrl: string | null;
  fetchOutcome: FetchOutcome;
  initialStatus: number | null;
  finalStatus: number | null;
  redirectChain: RedirectHop[];
  contentType: string | null;
  title: string | null;
  metaDescription: string | null;
  canonical: { raw: string[]; resolved: string[]; validity: FieldValidity } | null;
  robots: { raw: string[]; index: RobotsIndexState };
  internalLinksCount: number | null;
  fieldValidity: Partial<Record<string, FieldValidity>>;
  failureCode: string | null;
  fetchedAt: string;
}
