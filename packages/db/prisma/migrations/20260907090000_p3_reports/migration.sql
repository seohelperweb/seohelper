CREATE TYPE "ChangeSeverity" AS ENUM ('CRITICAL', 'WARNING', 'INFO');

-- CreateEnum
CREATE TYPE "IssueState" AS ENUM ('OPEN', 'RESOLVED');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "latestPublishedRunId" TEXT;

-- CreateTable
CREATE TABLE "ChangeEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "baseRunId" TEXT,
    "pageId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "severity" "ChangeSeverity" NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "scopeGeneration" INTEGER NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "state" "IssueState" NOT NULL DEFAULT 'OPEN',
    "occurrence" INTEGER NOT NULL DEFAULT 1,
    "suppressedUntil" TIMESTAMP(3),
    "lastEvaluatedRunId" TEXT,
    "lastConfirmedRunId" TEXT,
    "lastConfirmedAt" TIMESTAMP(3),
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueTransition" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "occurrence" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlSummary" (
    "runId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "comparisonMode" "ComparisonMode" NOT NULL,
    "urlsCrawled" INTEGER NOT NULL,
    "changesTotal" INTEGER NOT NULL,
    "changesCritical" INTEGER NOT NULL,
    "changesWarning" INTEGER NOT NULL,
    "changesInfo" INTEGER NOT NULL,
    "affectedPages" INTEGER NOT NULL,
    "issuesOpen" INTEGER NOT NULL,
    "issuesResolvedThisRun" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlSummary_pkey" PRIMARY KEY ("runId")
);

-- CreateIndex
CREATE INDEX "ChangeEvent_runId_severity_type_id_idx" ON "ChangeEvent"("runId", "severity", "type", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeEvent_runId_pageId_type_key" ON "ChangeEvent"("runId", "pageId", "type");

-- CreateIndex
CREATE INDEX "Issue_projectId_state_ruleKey_idx" ON "Issue"("projectId", "state", "ruleKey");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_projectId_pageId_scopeGeneration_ruleKey_ruleVersion_key" ON "Issue"("projectId", "pageId", "scopeGeneration", "ruleKey", "ruleVersion");

-- CreateIndex
CREATE UNIQUE INDEX "IssueTransition_idempotencyKey_key" ON "IssueTransition"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Project_latestPublishedRunId_key" ON "Project"("latestPublishedRunId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_latestPublishedRunId_fkey" FOREIGN KEY ("latestPublishedRunId") REFERENCES "CrawlRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeEvent" ADD CONSTRAINT "ChangeEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CrawlRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeEvent" ADD CONSTRAINT "ChangeEvent_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueTransition" ADD CONSTRAINT "IssueTransition_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlSummary" ADD CONSTRAINT "CrawlSummary_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CrawlRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

