import test from "node:test";
import assert from "node:assert/strict";
import {
  computeHealthScore,
  healthGrade,
  HEALTH_RULE_WEIGHTS,
  MIN_COVERAGE_RATIO,
  SATURATION_RATE,
  SCORE_VERSION,
} from "@seo/health-score";

const input = (overrides: Partial<Parameters<typeof computeHealthScore>[0]> = {}) => ({
  evaluatedPages: 10,
  observedPages: 10,
  openIssuesByRule: {},
  ...overrides,
});

test("healthy site scores 100 with zero deductions and full coverage", () => {
  const result = computeHealthScore(input());
  assert.equal(result.score, 100);
  assert.equal(result.scoreVersion, SCORE_VERSION);
  assert.equal(result.reason, "OK");
  assert.equal(result.totalDeduction, 0);
  assert.deepEqual(result.coverage, { evaluatedPages: 10, observedPages: 10, ratio: 1, sufficient: true });
  assert.deepEqual(
    result.components.map((component) => component.deduction),
    [0, 0, 0, 0],
  );
  assert.equal(result.unrecognizedRules.length, 0);
});

test("weights sum to 100 and saturation reaches the full deduction", () => {
  const totalWeight = Object.values(HEALTH_RULE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  assert.equal(totalWeight, 100, "a fully saturated site must be able to reach 0");

  // 1 of 5 pages (20%) with an http error saturates the 40-point component.
  const result = computeHealthScore({
    evaluatedPages: 5,
    observedPages: 5,
    openIssuesByRule: { http_4xx_5xx: 1 },
  });
  const http = result.components.find((component) => component.ruleKey === "http_4xx_5xx")!;
  assert.equal(http.rate, SATURATION_RATE);
  assert.equal(http.deduction, 40);
  assert.equal(result.score, 60);
});

test("deduction is linear below saturation", () => {
  // 1 of 20 pages (5%) → quarter of the 40-point component.
  const result = computeHealthScore({
    evaluatedPages: 20,
    observedPages: 20,
    openIssuesByRule: { http_4xx_5xx: 1 },
  });
  const http = result.components.find((component) => component.ruleKey === "http_4xx_5xx")!;
  assert.equal(http.rate, 0.05);
  assert.equal(http.deduction, 10);
  assert.equal(result.score, 90);
});

test("components combine and the score is floored at 0", () => {
  const mixed = computeHealthScore({
    evaluatedPages: 6,
    observedPages: 6,
    openIssuesByRule: { http_4xx_5xx: 1, noindex_on_indexable: 1 },
  });
  // rate 1/6 → factor (1/6)/0.2 = 5/6: round(40·5/6)=33, round(25·5/6)=21.
  assert.equal(mixed.components.find((component) => component.ruleKey === "http_4xx_5xx")!.deduction, 33);
  assert.equal(mixed.components.find((component) => component.ruleKey === "noindex_on_indexable")!.deduction, 21);
  assert.equal(mixed.totalDeduction, 54);
  assert.equal(mixed.score, 46);

  const saturated = computeHealthScore({
    evaluatedPages: 10,
    observedPages: 10,
    openIssuesByRule: {
      http_4xx_5xx: 10,
      noindex_on_indexable: 10,
      missing_title: 10,
      canonical_conflict: 10,
    },
  });
  assert.equal(saturated.totalDeduction, 100);
  assert.equal(saturated.score, 0);
});

test("carried-over issues clamp the rate at 1 instead of exceeding it", () => {
  const result = computeHealthScore({
    evaluatedPages: 2,
    observedPages: 2,
    openIssuesByRule: { http_4xx_5xx: 5 },
  });
  const http = result.components.find((component) => component.ruleKey === "http_4xx_5xx")!;
  assert.equal(http.rate, 1);
  assert.equal(http.deduction, 40);
  assert.equal(result.score, 60);
});

test("insufficient coverage suppresses the score but keeps the ratio", () => {
  // 1 decisive page out of 3 observations (robots-blocked majority).
  const result = computeHealthScore({
    evaluatedPages: 1,
    observedPages: 3,
    openIssuesByRule: { http_4xx_5xx: 1 },
  });
  assert.equal(result.score, null);
  assert.equal(result.reason, "INSUFFICIENT_COVERAGE");
  assert.equal(result.totalDeduction, 0);
  assert.ok(Math.abs(result.coverage.ratio - 1 / 3) < 1e-12);
  assert.equal(result.coverage.sufficient, false);
  // Components still list the open issues for explainability, without deductions.
  assert.equal(result.components.find((component) => component.ruleKey === "http_4xx_5xx")!.deduction, 0);
});

test("the exact coverage threshold still emits a score", () => {
  const result = computeHealthScore({
    evaluatedPages: 1,
    observedPages: 2,
    openIssuesByRule: {},
  });
  assert.equal(result.coverage.ratio, MIN_COVERAGE_RATIO);
  assert.equal(result.score, 100);
});

test("a run without decisive pages never scores", () => {
  const empty = computeHealthScore({ evaluatedPages: 0, observedPages: 0, openIssuesByRule: {} });
  assert.equal(empty.score, null);
  assert.equal(empty.reason, "INSUFFICIENT_COVERAGE");
  assert.equal(empty.coverage.ratio, 0);

  const blockedOnly = computeHealthScore({
    evaluatedPages: 0,
    observedPages: 4,
    openIssuesByRule: { missing_title: 2 },
  });
  assert.equal(blockedOnly.score, null);
});

test("unknown rule keys do not shift the score and are reported", () => {
  const result = computeHealthScore({
    evaluatedPages: 10,
    observedPages: 10,
    openIssuesByRule: { future_rule: 10 },
  });
  assert.equal(result.score, 100);
  assert.deepEqual(result.unrecognizedRules, ["future_rule"]);
});

test("negative and fractional counts are clamped defensively", () => {
  const result = computeHealthScore({
    evaluatedPages: -5,
    observedPages: 2.7,
    openIssuesByRule: { http_4xx_5xx: -3 },
  });
  assert.equal(result.coverage.evaluatedPages, 0);
  assert.equal(result.coverage.observedPages, 2);
  assert.equal(result.components.find((component) => component.ruleKey === "http_4xx_5xx")!.openIssues, 0);
  assert.equal(result.score, null);
});

test("computation is deterministic", () => {
  const payload = {
    evaluatedPages: 7,
    observedPages: 8,
    openIssuesByRule: { http_4xx_5xx: 2, noindex_on_indexable: 1 },
  };
  assert.deepEqual(computeHealthScore(payload), computeHealthScore(payload));
});

test("grade thresholds", () => {
  assert.equal(healthGrade(100), "good");
  assert.equal(healthGrade(90), "good");
  assert.equal(healthGrade(89), "fair");
  assert.equal(healthGrade(75), "fair");
  assert.equal(healthGrade(74), "poor");
  assert.equal(healthGrade(50), "poor");
  assert.equal(healthGrade(49), "critical");
  assert.equal(healthGrade(0), "critical");
});
