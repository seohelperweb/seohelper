import type { PrismaClient } from "@seo/db";
import { compareObservations, summarizeObservationChanges } from "@seo/change-detection";
import type { ComparableObservation } from "@seo/change-detection";
import { evaluateAllRules, nextIssueState } from "@seo/issue-rules";
import type { RuleObservation, RuleVerdict } from "@seo/issue-rules";
import { computeHealthScore } from "@seo/health-score";
import { withRunFence } from "../repositories/crawls.ts";

/**
 * Report publisher (docs/ARCHITECTURE.md §8-9): computes change events and
 * issue transitions from the run's frozen observations outside the
 * transaction, then writes them atomically behind the run lease fence.
 * FULL runs publish (BASELINE or DIFF vs. the latest published FULL run on
 * the same immutable policy); PARTIAL/CANCELLED runs never reach here. The
 * site health score (P5) is computed from the same frozen inputs and stored
 * on the summary with its version and coverage ratio.
 */

export interface PublishOutcome {
  published: boolean;
  comparisonMode: "BASELINE" | "DIFF" | "NONE";
  changes: number;
  resolvedIssues: number;
}

function toComparable(row: {
  pageId: string;
  title: string | null;
  metaDescription: string | null;
  initialStatus: number | null;
  fetchOutcome: string;
  canonical: unknown;
  robots: unknown;
  internalLinksCount: number | null;
  fieldValidity: unknown;
  page: { identityUrl: string };
}): ComparableObservation {
  return {
    pageId: row.pageId,
    identityUrl: row.page.identityUrl,
    fetchOutcome: row.fetchOutcome,
    initialStatus: row.initialStatus,
    title: row.title,
    metaDescription: row.metaDescription,
    canonical: (row.canonical ?? null) as ComparableObservation["canonical"],
    robots: (row.robots ?? null) as ComparableObservation["robots"],
    internalLinksCount: row.internalLinksCount,
    fieldValidity: (row.fieldValidity ?? null) as ComparableObservation["fieldValidity"],
  };
}

function toRuleObservation(comparable: ComparableObservation, fetchOutcome: string): RuleObservation {
  return {
    pageId: comparable.pageId,
    identityUrl: comparable.identityUrl,
    fetchOutcome,
    initialStatus: comparable.initialStatus,
    finalStatus: comparable.initialStatus,
    title: comparable.title,
    canonical: comparable.canonical,
    robots: comparable.robots,
    fieldValidity: comparable.fieldValidity as RuleObservation["fieldValidity"],
  };
}

export async function publishRun(
  db: PrismaClient,
  input: { runId: string; projectId: string; leaseToken: number },
  now: Date = new Date(),
): Promise<PublishOutcome> {
  const run = await db.crawlRun.findUniqueOrThrow({
    where: { id: input.runId },
  });
  if (run.projectId !== input.projectId) throw new Error("run does not belong to the project");
  if (run.publishedAt !== null) {
    const summary = await db.crawlSummary.findUnique({ where: { runId: run.id } });
    return {
      published: true,
      comparisonMode: run.comparisonMode,
      changes: summary?.changesTotal ?? 0,
      resolvedIssues: summary?.issuesResolvedThisRun ?? 0,
    };
  }
  const policy = await db.projectPolicy.findUnique({ where: { id: run.policyId } });
  if (!policy) throw new Error("run has no resolvable policy");

  // ---- frozen observations (run is FINALIZING; no further writes) ----
  const currentRows = await db.pageObservation.findMany({
    where: { runId: run.id },
    include: { page: { select: { identityUrl: true } } },
  });
  const current = currentRows.map(toComparable);
  const rowByPageId = new Map(currentRows.map((row) => [row.pageId, row]));

  // ---- baseline: latest published FULL run on the same immutable policy ----
  const baseRun = await db.crawlRun.findFirst({
    where: { projectId: run.projectId, policyId: run.policyId, publishedAt: { not: null }, completeness: "FULL" },
    orderBy: { publishedAt: "desc" },
  });
  const baseRows = baseRun
    ? await db.pageObservation.findMany({
        where: { runId: baseRun.id },
        include: { page: { select: { identityUrl: true } } },
      })
    : [];
  const base = baseRows.map(toComparable);

  // ---- change events ----
  const changes = compareObservations(base, current, baseRun !== null);
  const changeSummary = summarizeObservationChanges(changes);

  // ---- issue evaluation (pure) ----
  const verdicts = new Map<
    string,
    { pageId: string; ruleKey: string; verdict: RuleVerdict; evidence: Record<string, string | number | null> }
  >();
  for (const observation of current) {
    const row = rowByPageId.get(observation.pageId);
    const ruleInput = toRuleObservation(observation, row?.fetchOutcome ?? observation.fetchOutcome);
    for (const { ruleKey, evaluation } of evaluateAllRules(ruleInput)) {
      verdicts.set(`${observation.pageId}:${ruleKey}`, {
        pageId: observation.pageId,
        ruleKey,
        verdict: evaluation.verdict,
        evidence: evaluation.evidence,
      });
    }
  }

  const outcome = await withRunFence<PublishOutcome>(
    db,
    run.id,
    input.leaseToken,
    async (tx) => {
      const fence = await tx.crawlRun.findUniqueOrThrow({
        where: { id: run.id },
        select: { publishedAt: true, status: true, comparisonMode: true, cancelRequestedAt: true },
      });
      if (fence.publishedAt !== null) {
        const existing = await tx.crawlSummary.findUnique({ where: { runId: run.id } });
        return {
          published: true,
          comparisonMode: fence.comparisonMode as "BASELINE" | "DIFF" | "NONE",
          changes: existing?.changesTotal ?? 0,
          resolvedIssues: existing?.issuesResolvedThisRun ?? 0,
        };
      }
      if (fence.status !== "FINALIZING" || fence.cancelRequestedAt !== null) {
        return { published: false, comparisonMode: "NONE", changes: 0, resolvedIssues: 0 };
      }

      // Change events (idempotent on (runId, pageId, type)).
      if (changes.length > 0) {
        await tx.changeEvent.createMany({
          data: changes.map((change) => ({
            runId: run.id,
            baseRunId: baseRun?.id ?? null,
            pageId: change.pageId,
            type: change.type,
            before: change.before as never,
            after: change.after as never,
            severity: change.severity,
            ruleVersion: policy.ruleVersion,
          })),
          skipDuplicates: true,
        });
      }

      // Issue transitions.
      const existingIssues = await tx.issue.findMany({
        where: { projectId: run.projectId, scopeGeneration: policy.scopeGeneration, ruleVersion: policy.ruleVersion },
      });
      const issuesByPageRule = new Map(existingIssues.map((issue) => [`${issue.pageId}:${issue.ruleKey}`, issue]));
      const evaluatedPageIds = new Set(current.map((observation) => observation.pageId));
      let resolvedThisRun = 0;

      for (const issue of existingIssues) {
        if (!evaluatedPageIds.has(issue.pageId)) {
          // Page not observed this run: not evidence of anything (docs §9).
          await tx.issue.update({ where: { id: issue.id }, data: { lastEvaluatedRunId: run.id } });
        }
      }

      for (const [key, verdictEntry] of verdicts) {
        const existing = issuesByPageRule.get(key);
        const transition = nextIssueState(existing?.state ?? null, verdictEntry.verdict);

        if (!existing && verdictEntry.verdict === "PRESENT") {
          const issue = await tx.issue.create({
            data: {
              projectId: run.projectId,
              pageId: verdictEntry.pageId,
              scopeGeneration: policy.scopeGeneration,
              ruleKey: verdictEntry.ruleKey,
              ruleVersion: policy.ruleVersion,
              state: "OPEN",
              occurrence: 1,
              lastEvaluatedRunId: run.id,
              lastConfirmedRunId: run.id,
              lastConfirmedAt: now,
              evidence: verdictEntry.evidence as never,
            },
          });
          await tx.issueTransition
            .create({
              data: {
                issueId: issue.id,
                runId: run.id,
                fromState: null,
                toState: "OPEN",
                occurrence: 1,
                idempotencyKey: `${run.id}:${key}:open`,
              },
            })
            .catch((error) => {
              if ((error as { code?: string }).code !== "P2002") throw error;
            });
          continue;
        }
        if (!existing) continue;

        if (transition.nextState === null) {
          await tx.issue.update({
            where: { id: existing.id },
            data: {
              lastEvaluatedRunId: run.id,
              ...(verdictEntry.verdict !== "UNKNOWN" ? { lastConfirmedRunId: run.id, lastConfirmedAt: now } : {}),
              ...(verdictEntry.verdict === "PRESENT" ? { evidence: verdictEntry.evidence as never } : {}),
            },
          });
          continue;
        }

        const occurrence = existing.occurrence + (transition.reopen ? 1 : 0);
        const nextState = transition.nextState;
        await tx.issue.update({
          where: { id: existing.id },
          data: {
            state: nextState,
            occurrence,
            lastEvaluatedRunId: run.id,
            lastConfirmedRunId: run.id,
            lastConfirmedAt: now,
            ...(verdictEntry.verdict === "PRESENT" ? { evidence: verdictEntry.evidence as never } : {}),
          },
        });
        await tx.issueTransition
          .create({
            data: {
              issueId: existing.id,
              runId: run.id,
              fromState: existing.state,
              toState: nextState,
              occurrence,
              idempotencyKey: `${run.id}:${existing.id}:${nextState}`,
            },
          })
          .catch((error) => {
            if ((error as { code?: string }).code !== "P2002") throw error;
          });
        if (existing.state === "OPEN" && nextState === "RESOLVED") resolvedThisRun += 1;
      }

      const openIssueWhere = {
        projectId: run.projectId,
        scopeGeneration: policy.scopeGeneration,
        ruleVersion: policy.ruleVersion,
        state: "OPEN" as const,
        OR: [{ suppressedUntil: null }, { suppressedUntil: { lt: now } }],
      };
      const openIssues = await tx.issue.count({ where: openIssueWhere });
      const urlsCrawled = current.filter(
        (observation) => rowByPageId.get(observation.pageId)?.fetchOutcome === "HTTP_RESPONSE",
      ).length;

      // ---- site health score (P5, docs/ARCHITECTURE.md §9) ----
      // Same frozen inputs and the same open-issue scope as the summary counts;
      // decisive pages (HTTP responses) over all observations form the coverage
      // ratio that gates whether a score is emitted at all.
      const openByRule = await tx.issue.groupBy({ by: ["ruleKey"], where: openIssueWhere, _count: { _all: true } });
      const openIssuesByRule: Record<string, number> = {};
      for (const row of openByRule) openIssuesByRule[row.ruleKey] = row._count._all;
      const health = computeHealthScore({
        evaluatedPages: urlsCrawled,
        observedPages: currentRows.length,
        openIssuesByRule,
      });

      await tx.crawlSummary.upsert({
        where: { runId: run.id },
        create: {
          runId: run.id,
          comparisonMode: baseRun ? "DIFF" : "BASELINE",
          urlsCrawled,
          changesTotal: changeSummary.total,
          changesCritical: changeSummary.critical,
          changesWarning: changeSummary.warning,
          changesInfo: changeSummary.info,
          affectedPages: changeSummary.affectedPages,
          issuesOpen: openIssues,
          issuesResolvedThisRun: resolvedThisRun,
          healthScore: health.score,
          healthScoreVersion: health.score !== null ? health.scoreVersion : null,
          healthCoverage: health.coverage.ratio,
          healthReason: health.reason,
          healthComponents: health.components as never,
        },
        update: {},
      });

      const comparisonMode = baseRun ? "DIFF" : "BASELINE";
      await tx.crawlRun.update({
        where: { id: run.id },
        data: {
          status: "COMPLETED",
          completeness: "FULL",
          comparisonMode,
          baseRunId: baseRun?.id ?? null,
          publishedAt: now,
          finishedAt: now,
          leaseExpiresAt: null,
        },
      });
      await tx.project.update({ where: { id: run.projectId }, data: { latestPublishedRunId: run.id } });

      return { published: true, comparisonMode, changes: changeSummary.total, resolvedIssues: resolvedThisRun };
    },
    run.projectId,
  );

  if (outcome === null) {
    return { published: false, comparisonMode: "NONE", changes: 0, resolvedIssues: 0 };
  }
  return outcome;
}
