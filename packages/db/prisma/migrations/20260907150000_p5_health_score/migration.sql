-- Site health score (P5, docs/ARCHITECTURE.md §9): one score per published
-- run, versioned and explainable. Null when coverage is insufficient or the
-- run predates the feature; healthComponents stores the per-rule deduction
-- breakdown computed by @seo/health-score.

-- AlterTable
ALTER TABLE "CrawlSummary" ADD COLUMN     "healthScore" INTEGER,
ADD COLUMN     "healthScoreVersion" INTEGER,
ADD COLUMN     "healthCoverage" DOUBLE PRECISION,
ADD COLUMN     "healthReason" TEXT,
ADD COLUMN     "healthComponents" JSONB;
