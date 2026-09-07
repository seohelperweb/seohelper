import type { FieldValidity } from "@seo/contracts";

/**
 * Issue rules (docs/ARCHITECTURE.md §9): a rule evaluates one page
 * observation to PRESENT / ABSENT / UNKNOWN with evidence. Only verdicts on
 * KNOWN, applicable fields may flip an issue's state — UNKNOWN keeps it.
 * Pure logic: no database, no framework imports.
 */

export const RULE_VERDICTS = ["PRESENT", "ABSENT", "UNKNOWN"] as const;
export type RuleVerdict = (typeof RULE_VERDICTS)[number];

export interface RuleEvaluation {
  verdict: RuleVerdict;
  evidence: Record<string, string | number | null>;
}

/** Input shape shared with PageObservation rows (JSON columns decoded). */
export interface RuleObservation {
  pageId: string;
  identityUrl: string;
  fetchOutcome: string;
  initialStatus: number | null;
  finalStatus: number | null;
  title: string | null;
  canonical: { raw: string[]; resolved: string[] } | null;
  robots: { raw: string[]; index: string } | null;
  fieldValidity: Record<string, FieldValidity> | null;
}

export const ISSUE_RULE_KEYS = ["http_4xx_5xx", "noindex_on_indexable", "missing_title", "canonical_conflict"] as const;
export type IssueRuleKey = (typeof ISSUE_RULE_KEYS)[number];

function validity(observation: RuleObservation, field: string): FieldValidity {
  return observation.fieldValidity?.[field] ?? "UNKNOWN";
}

/**
 * HTTP 404/410/5xx rule. A decisive HTTP response is PRESENT (error status)
 * or ABSENT (healthy status); fetch failures and robots blocks are UNKNOWN —
 * they are not evidence of anything (docs §9).
 */
function evaluateHttpError(observation: RuleObservation): RuleEvaluation {
  if (observation.fetchOutcome !== "HTTP_RESPONSE" || observation.finalStatus === null) {
    return { verdict: "UNKNOWN", evidence: { fetchOutcome: observation.fetchOutcome } };
  }
  const status = observation.finalStatus;
  const isError = status === 404 || status === 410 || status >= 500;
  return {
    verdict: isError ? "PRESENT" : "ABSENT",
    evidence: { status },
  };
}

/** noindex on an expected-indexable page (per-path overrides arrive with policy config). */
function evaluateNoindex(observation: RuleObservation): RuleEvaluation {
  const state = validity(observation, "robots");
  if (state !== "KNOWN") return { verdict: "UNKNOWN", evidence: { fieldValidity: state } };
  if (observation.fetchOutcome !== "HTTP_RESPONSE" || !observation.robots) {
    return { verdict: "UNKNOWN", evidence: { fetchOutcome: observation.fetchOutcome } };
  }
  if (observation.robots.index === "DISALLOWED") {
    return { verdict: "PRESENT", evidence: { robots: observation.robots.raw.join(", ") } };
  }
  if (observation.robots.index === "ALLOWED") {
    return { verdict: "ABSENT", evidence: { robots: observation.robots.raw.join(", ") } };
  }
  return { verdict: "UNKNOWN", evidence: { robots: observation.robots.raw.join(", ") } };
}

/** HTML missing title: only "parsed HTML, field KNOWN, value absent" counts (docs §6). */
function evaluateMissingTitle(observation: RuleObservation): RuleEvaluation {
  const state = validity(observation, "title");
  if (state === "KNOWN") {
    return {
      verdict: observation.title === null || observation.title === "" ? "PRESENT" : "ABSENT",
      evidence: { title: observation.title },
    };
  }
  return { verdict: "UNKNOWN", evidence: { fieldValidity: state } };
}

/** Canonical invalid (unresolvable) or conflicting (multiple distinct targets); absence is not an issue. */
function evaluateCanonicalConflict(observation: RuleObservation): RuleEvaluation {
  const state = validity(observation, "canonical");
  if (state !== "KNOWN" || observation.canonical === null) {
    return { verdict: "UNKNOWN", evidence: { fieldValidity: state } };
  }
  const { raw, resolved } = observation.canonical;
  if (raw.length === 0) return { verdict: "ABSENT", evidence: { canonicalCount: 0 } };
  if (resolved.length < raw.length) {
    return { verdict: "PRESENT", evidence: { problem: "invalid", raw: raw.join(", ") } };
  }
  const distinct = new Set(resolved);
  if (distinct.size > 1) {
    return { verdict: "PRESENT", evidence: { problem: "conflict", raw: raw.join(", ") } };
  }
  return { verdict: "ABSENT", evidence: { canonical: resolved[0] } };
}

const EVALUATORS: Record<IssueRuleKey, (observation: RuleObservation) => RuleEvaluation> = {
  http_4xx_5xx: evaluateHttpError,
  noindex_on_indexable: evaluateNoindex,
  missing_title: evaluateMissingTitle,
  canonical_conflict: evaluateCanonicalConflict,
};

export function evaluateIssueRule(ruleKey: IssueRuleKey, observation: RuleObservation): RuleEvaluation {
  return EVALUATORS[ruleKey](observation);
}

export function evaluateAllRules(
  observation: RuleObservation,
): Array<{ ruleKey: IssueRuleKey; evaluation: RuleEvaluation }> {
  return ISSUE_RULE_KEYS.map((ruleKey) => ({ ruleKey, evaluation: evaluateIssueRule(ruleKey, observation) }));
}

// ---------------------------------------------------------------------------
// Issue state machine (docs/ARCHITECTURE.md §9)
// ---------------------------------------------------------------------------

export type IssueStateValue = "OPEN" | "RESOLVED";

export interface IssueStateTransition {
  /** New state, or null to keep the current one (UNKNOWN verdict). */
  nextState: IssueStateValue | null;
  /** Increment occurrence when an OPEN follows a RESOLVED period (re-open). */
  reopen: boolean;
}

/**
 * PRESENT opens (or re-opens, incrementing occurrence); ABSENT resolves;
 * UNKNOWN keeps the current state and freshness untouched beyond
 * lastEvaluatedRunId. Suppressed issues keep being evaluated but are not
 * reported as actionable.
 */
export function nextIssueState(current: IssueStateValue | null, verdict: RuleVerdict): IssueStateTransition {
  if (verdict === "UNKNOWN") return { nextState: null, reopen: false };
  const shouldBeOpen = verdict === "PRESENT";
  if (current === null) {
    return shouldBeOpen ? { nextState: "OPEN", reopen: false } : { nextState: null, reopen: false };
  }
  if (current === "RESOLVED" && shouldBeOpen) return { nextState: "OPEN", reopen: true };
  if (current === "OPEN" && !shouldBeOpen) return { nextState: "RESOLVED", reopen: false };
  return { nextState: null, reopen: false };
}
