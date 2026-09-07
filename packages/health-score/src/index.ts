/**
 * Site health score v1 (docs/ARCHITECTURE.md §9, IMPLEMENTATION_PLAN.md P5).
 *
 * The score is only shown when it has an explainable formula, coverage
 * requirements and a version — all three are defined here and persisted with
 * every published summary.
 *
 * Formula (v1):
 *   score = 100 − Σ deduction(rule), floored at 0
 *   deduction(rule) = round(weight(rule) × min(1, rate(rule) / SATURATION_RATE))
 *   rate(rule) = min(1, openIssues(rule) / evaluatedPages)
 *
 * - `evaluatedPages` are the run's decisive HTTP responses (urlsCrawled);
 *   `observedPages` counts every observation, including robots-blocked and
 *   out-of-scope redirect sources that carry no page evidence.
 * - Open issues are counted per rule over the current policy scope
 *   (projectId + scopeGeneration + ruleVersion, state OPEN, not suppressed).
 *   Issues carried over from pages not re-observed still count as open; their
 *   rate contribution is clamped at 1.
 * - A rule's deduction saturates when its affected-page share reaches
 *   SATURATION_RATE (20% of evaluated pages).
 * - A single denominator keeps v1 explainable; per-field applicability
 *   (e.g. titles on non-HTML pages) is deliberately not modeled.
 *
 * Coverage gate: a score is only emitted when at least MIN_EVALUATED_PAGES
 * decisive pages were observed AND decisive pages make up at least
 * MIN_COVERAGE_RATIO of all observations. Otherwise the score is null with
 * reason INSUFFICIENT_COVERAGE — the coverage ratio is still returned so the
 * UI can explain why no score exists.
 *
 * Versioning: any change to weights, saturation, gate thresholds or
 * aggregation semantics bumps SCORE_VERSION; stored scores keep their
 * original interpretation. Rule keys absent from HEALTH_RULE_WEIGHTS never
 * affect the score (forward compatibility) and are surfaced separately.
 *
 * Pure logic: no database, no framework imports.
 */

export const SCORE_VERSION = 1;

/** Maximum deduction per issue rule; the weights sum to 100. */
export const HEALTH_RULE_WEIGHTS = {
  /** Broken pages are the most severe availability problem. */
  http_4xx_5xx: 40,
  /** Expected-indexable pages excluded from the index. */
  noindex_on_indexable: 25,
  /** Missing basic on-page SEO element. */
  missing_title: 20,
  /** Canonical invalid or conflicting. */
  canonical_conflict: 15,
} as const;

export type HealthRuleKey = keyof typeof HEALTH_RULE_WEIGHTS;

/** Affected-page share at which a rule's deduction saturates. */
export const SATURATION_RATE = 0.2;

/** Minimum share of decisive observations for a score to be emitted. */
export const MIN_COVERAGE_RATIO = 0.5;

/** Minimum number of decisive pages for a score to be emitted. */
export const MIN_EVALUATED_PAGES = 1;

export interface HealthScoreComponent {
  ruleKey: string;
  openIssues: number;
  /** Share of evaluated pages affected, clamped to [0, 1]. */
  rate: number;
  /** Integer points deducted by this component (0 when no score is emitted). */
  deduction: number;
  maxDeduction: number;
}

export type HealthScoreReason = "OK" | "INSUFFICIENT_COVERAGE";

export interface HealthScoreCoverage {
  evaluatedPages: number;
  observedPages: number;
  ratio: number;
  sufficient: boolean;
}

export interface HealthScoreResult {
  scoreVersion: typeof SCORE_VERSION;
  score: number | null;
  reason: HealthScoreReason;
  coverage: HealthScoreCoverage;
  components: HealthScoreComponent[];
  /** Rule keys present in the input but without a registered weight. */
  unrecognizedRules: string[];
  totalDeduction: number;
}

export interface HealthScoreInput {
  /** Decisive HTTP responses in the published run (urlsCrawled). */
  evaluatedPages: number;
  /** All observations in the published run. */
  observedPages: number;
  /** Currently open (unsuppressed) issue counts per rule key. */
  openIssuesByRule: Record<string, number>;
}

function clampCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Compute the health score for one published run. Deterministic: the same
 * input always produces the same output.
 */
export function computeHealthScore(input: HealthScoreInput): HealthScoreResult {
  const evaluatedPages = clampCount(input.evaluatedPages);
  const observedPages = clampCount(input.observedPages);
  const ratio = observedPages > 0 ? evaluatedPages / observedPages : 0;
  const sufficient = evaluatedPages >= MIN_EVALUATED_PAGES && ratio >= MIN_COVERAGE_RATIO;

  const components: HealthScoreComponent[] = [];
  let totalDeduction = 0;
  for (const [ruleKey, maxDeduction] of Object.entries(HEALTH_RULE_WEIGHTS)) {
    const openIssues = clampCount(input.openIssuesByRule[ruleKey] ?? 0);
    const rate = evaluatedPages > 0 ? Math.min(1, openIssues / evaluatedPages) : 0;
    const deduction = sufficient ? Math.round(maxDeduction * Math.min(1, rate / SATURATION_RATE)) : 0;
    totalDeduction += deduction;
    components.push({ ruleKey, openIssues, rate, deduction, maxDeduction });
  }

  const unrecognizedRules = Object.keys(input.openIssuesByRule)
    .filter((ruleKey) => !(ruleKey in HEALTH_RULE_WEIGHTS))
    .sort();

  return {
    scoreVersion: SCORE_VERSION,
    score: sufficient ? Math.max(0, 100 - totalDeduction) : null,
    reason: sufficient ? "OK" : "INSUFFICIENT_COVERAGE",
    coverage: { evaluatedPages, observedPages, ratio, sufficient },
    components,
    unrecognizedRules,
    totalDeduction: sufficient ? totalDeduction : 0,
  };
}

export type HealthGrade = "good" | "fair" | "poor" | "critical";

/** Presentation bucket for a non-null score (dashboard card coloring). */
export function healthGrade(score: number): HealthGrade {
  if (score >= 90) return "good";
  if (score >= 75) return "fair";
  if (score >= 50) return "poor";
  return "critical";
}
