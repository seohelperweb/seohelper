/**
 * Guard evaluated before any crawl is created or claimed: the project's
 * domain verification must have succeeded within the last 30 days
 * (docs/ARCHITECTURE.md §4). Returns the reason instead of throwing for
 * callers that want to record SKIPPED_UNVERIFIED; use assertProjectCrawlable
 * in request paths.
 */

export class CrawlBlockedError extends Error {
  readonly code: "VERIFICATION_REQUIRED";

  constructor(code: "VERIFICATION_REQUIRED", message: string) {
    super(message);
    this.code = code;
    this.name = "CrawlBlockedError";
  }
}

export interface CrawlableProject {
  id: string;
  hostname: string;
  verificationStatus: string;
  latestVerification: { verifiedAt: Date | null } | null;
}

export function crawlBlockReason(project: CrawlableProject, validityMs: number, now: Date = new Date()): string | null {
  const verifiedAt = project.latestVerification?.verifiedAt ?? null;
  if (!verifiedAt) return "domain verification has never succeeded";
  if (project.verificationStatus !== "ACTIVE") return "project is not in the verified state";
  if (now.getTime() >= verifiedAt.getTime() + validityMs) return "domain verification expired";
  return null;
}

export function assertProjectCrawlable(project: CrawlableProject, validityMs: number, now: Date = new Date()): void {
  const reason = crawlBlockReason(project, validityMs, now);
  if (reason !== null) {
    throw new CrawlBlockedError("VERIFICATION_REQUIRED", `Crawl blocked: ${reason}`);
  }
}
