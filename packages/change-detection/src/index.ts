import type { ChangeEvent, ChangeEventType, ChangeSummary, PageSnapshot, Severity } from "@seo/contracts";

/**
 * Pure snapshot comparison (docs/ARCHITECTURE.md §9).
 *
 * Compares two snapshots keyed by normalized URL. "URL_REMOVED" here is set
 * membership only: the production report must not treat "not observed this
 * run" as deletion — crawl completeness decides removal upstream, and field
 * validity (KNOWN / UNKNOWN / NOT_APPLICABLE) gates which facts can be
 * compared at all. Those contracts arrive with the P3 report loop.
 */

const severityFor = (
  type: ChangeEventType,
  before: string | number | null,
  after: string | number | null,
): Severity => {
  if (type === "HTTP_STATUS_CHANGED" && typeof before === "number" && typeof after === "number") {
    if (before >= 200 && before < 300 && (after === 404 || after >= 500)) return "CRITICAL";
  }
  if (type === "ROBOTS_CHANGED" && before === "index" && after === "noindex") return "CRITICAL";
  if (type === "CANONICAL_CHANGED" || type === "TITLE_CHANGED" || type === "META_DESCRIPTION_CHANGED") {
    return "WARNING";
  }
  return "INFO";
};

const event = (
  url: string,
  type: ChangeEventType,
  before: string | number | null,
  after: string | number | null,
): ChangeEvent => ({
  url,
  type,
  before,
  after,
  severity: severityFor(type, before, after),
});

export function compareSnapshots(previous: PageSnapshot[], current: PageSnapshot[]): ChangeEvent[] {
  const beforeByUrl = new Map(previous.map((page) => [page.url, page]));
  const afterByUrl = new Map(current.map((page) => [page.url, page]));
  const changes: ChangeEvent[] = [];

  for (const [url, after] of afterByUrl) {
    const before = beforeByUrl.get(url);
    if (!before) {
      changes.push(event(url, "URL_ADDED", null, url));
      continue;
    }
    if (before.statusCode !== after.statusCode) {
      changes.push(event(url, "HTTP_STATUS_CHANGED", before.statusCode, after.statusCode));
    }
    if (before.robots !== after.robots) changes.push(event(url, "ROBOTS_CHANGED", before.robots, after.robots));
    if (before.canonical !== after.canonical) {
      changes.push(event(url, "CANONICAL_CHANGED", before.canonical, after.canonical));
    }
    if (before.title !== after.title) changes.push(event(url, "TITLE_CHANGED", before.title, after.title));
    if (before.metaDescription !== after.metaDescription) {
      changes.push(event(url, "META_DESCRIPTION_CHANGED", before.metaDescription, after.metaDescription));
    }
    if (before.internalLinksCount !== after.internalLinksCount) {
      changes.push(event(url, "INTERNAL_LINKS_CHANGED", before.internalLinksCount, after.internalLinksCount));
    }
  }
  for (const url of beforeByUrl.keys()) {
    if (!afterByUrl.has(url)) changes.push(event(url, "URL_REMOVED", url, null));
  }
  return changes;
}

export function summarizeChanges(changes: ChangeEvent[]): ChangeSummary {
  const summary: ChangeSummary = { total: 0, critical: 0, warning: 0, info: 0, byType: {} };
  for (const change of changes) {
    summary.total += 1;
    summary[change.severity.toLowerCase() as "critical" | "warning" | "info"] += 1;
    summary.byType[change.type] = (summary.byType[change.type] ?? 0) + 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Observation comparison (P3, docs/ARCHITECTURE.md §9)
// ---------------------------------------------------------------------------

/** Shape shared with PageObservation rows; JSON columns already decoded. */
export interface ComparableObservation {
  pageId: string;
  identityUrl: string;
  fetchOutcome: string;
  initialStatus: number | null;
  title: string | null;
  metaDescription: string | null;
  canonical: { raw: string[]; resolved: string[] } | null;
  robots: { raw: string[]; index: string } | null;
  internalLinksCount: number | null;
  fieldValidity: Record<string, string> | null;
}

export interface ObservationChange {
  pageId: string;
  identityUrl: string;
  type: ChangeEventType;
  before: string | number | null;
  after: string | number | null;
  severity: Severity;
}

function bothKnown(base: ComparableObservation, current: ComparableObservation, field: string): boolean {
  return base.fieldValidity?.[field] === "KNOWN" && current.fieldValidity?.[field] === "KNOWN";
}

const canonicalValue = (canonical: { raw: string[]; resolved: string[] } | null): string | null =>
  canonical === null ? null : canonical.resolved.join(" ");

/**
 * Compare a current run's observations against a published base run.
 * Field-level validity gates every comparison (error pages and redirect
 * sources never produce content events); "not observed this run" is NOT a
 * deletion event (docs §9) — URL_ADDED is emitted only when a base exists.
 */
export function compareObservations(
  base: ComparableObservation[],
  current: ComparableObservation[],
  hasBase: boolean,
): ObservationChange[] {
  const baseByPage = new Map(base.map((observation) => [observation.pageId, observation]));
  const changes: ObservationChange[] = [];

  const push = (
    observation: ComparableObservation,
    type: ChangeEventType,
    before: string | number | null,
    after: string | number | null,
    severity: Severity,
  ) =>
    changes.push({ pageId: observation.pageId, identityUrl: observation.identityUrl, type, before, after, severity });

  for (const after of current) {
    const before = baseByPage.get(after.pageId);

    if (!before) {
      if (hasBase) push(after, "URL_ADDED", null, after.identityUrl, "INFO");
      continue;
    }

    // HTTP status: comparable whenever both sides produced a decisive HTTP response.
    const httpComparable = before.fetchOutcome === "HTTP_RESPONSE" && after.fetchOutcome === "HTTP_RESPONSE";
    if (httpComparable && before.initialStatus !== after.initialStatus) {
      const wasHealthy = before.initialStatus !== null && before.initialStatus >= 200 && before.initialStatus < 300;
      const isError = after.initialStatus === 404 || after.initialStatus === 410 || (after.initialStatus ?? 0) >= 500;
      push(
        after,
        "HTTP_STATUS_CHANGED",
        before.initialStatus,
        after.initialStatus,
        wasHealthy && isError ? "CRITICAL" : "INFO",
      );
    }

    if (bothKnown(before, after, "robots") && before.robots?.index !== after.robots?.index) {
      const blocked = after.robots?.index === "DISALLOWED";
      push(
        after,
        "ROBOTS_CHANGED",
        before.robots?.index ?? null,
        after.robots?.index ?? null,
        blocked ? "CRITICAL" : "INFO",
      );
    }

    if (bothKnown(before, after, "title") && before.title !== after.title) {
      push(after, "TITLE_CHANGED", before.title, after.title, "WARNING");
    }
    if (bothKnown(before, after, "metaDescription") && before.metaDescription !== after.metaDescription) {
      push(after, "META_DESCRIPTION_CHANGED", before.metaDescription, after.metaDescription, "WARNING");
    }
    if (bothKnown(before, after, "canonical") && canonicalValue(before.canonical) !== canonicalValue(after.canonical)) {
      push(after, "CANONICAL_CHANGED", canonicalValue(before.canonical), canonicalValue(after.canonical), "WARNING");
    }
    if (bothKnown(before, after, "internalLinksCount") && before.internalLinksCount !== after.internalLinksCount) {
      push(after, "INTERNAL_LINKS_CHANGED", before.internalLinksCount, after.internalLinksCount, "INFO");
    }
  }
  return changes;
}

export function summarizeObservationChanges(changes: ObservationChange[]): {
  total: number;
  critical: number;
  warning: number;
  info: number;
  affectedPages: number;
} {
  const summary = { total: changes.length, critical: 0, warning: 0, info: 0, affectedPages: new Set<string>().size };
  const pages = new Set<string>();
  for (const change of changes) {
    summary[change.severity.toLowerCase() as "critical" | "warning" | "info"] += 1;
    pages.add(change.pageId);
  }
  summary.affectedPages = pages.size;
  return summary;
}
