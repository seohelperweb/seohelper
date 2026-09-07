CREATE TYPE "CrawlRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'FINALIZING', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "CrawlTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "CrawlCompleteness" AS ENUM ('NONE', 'FULL', 'PARTIAL');

-- CreateEnum
CREATE TYPE "ComparisonMode" AS ENUM ('NONE', 'BASELINE', 'DIFF');

-- CreateEnum
CREATE TYPE "CrawlFetchOutcome" AS ENUM ('HTTP_RESPONSE', 'REDIRECT_BLOCKED', 'SECURITY_BLOCKED', 'SCOPE_BLOCKED', 'ROBOTS_BLOCKED', 'NETWORK_ERROR', 'BODY_TOO_LARGE', 'TIMEOUT', 'REDIRECT_LIMIT');

-- CreateEnum
CREATE TYPE "FrontierState" AS ENUM ('PENDING', 'FETCHING', 'DONE', 'SKIPPED');

-- CreateEnum
CREATE TYPE "FrontierSource" AS ENUM ('SEED', 'SITEMAP', 'LINK', 'REDIRECT', 'MONITORED');

-- CreateTable
CREATE TABLE "CrawlRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "trigger" "CrawlTrigger" NOT NULL DEFAULT 'MANUAL',
    "status" "CrawlRunStatus" NOT NULL DEFAULT 'QUEUED',
    "completeness" "CrawlCompleteness" NOT NULL DEFAULT 'NONE',
    "comparisonMode" "ComparisonMode" NOT NULL DEFAULT 'NONE',
    "baseRunId" TEXT,
    "failureCode" TEXT,
    "pagesDone" INTEGER NOT NULL DEFAULT 0,
    "pagesKnown" INTEGER NOT NULL DEFAULT 0,
    "bytesDownloaded" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "detailsExpiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrawlRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlFrontier" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "urlKey" TEXT NOT NULL,
    "requestUrl" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "source" "FrontierSource" NOT NULL DEFAULT 'SEED',
    "state" "FrontierState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlFrontier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Page" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "identityVersion" INTEGER NOT NULL,
    "urlKey" TEXT NOT NULL,
    "identityUrl" TEXT NOT NULL,
    "firstSeenRunId" TEXT,
    "lastSeenRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageObservation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "fetchOutcome" "CrawlFetchOutcome" NOT NULL,
    "requestUrl" TEXT NOT NULL,
    "finalUrl" TEXT,
    "initialStatus" INTEGER,
    "finalStatus" INTEGER,
    "redirectChain" JSONB,
    "contentType" TEXT,
    "title" TEXT,
    "metaDescription" TEXT,
    "canonical" JSONB,
    "robots" JSONB,
    "internalLinksCount" INTEGER,
    "fieldValidity" JSONB,
    "failureCode" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrawlRun_projectId_createdAt_idx" ON "CrawlRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "CrawlFrontier_runId_state_nextAttemptAt_depth_idx" ON "CrawlFrontier"("runId", "state", "nextAttemptAt", "depth");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlFrontier_runId_urlKey_key" ON "CrawlFrontier"("runId", "urlKey");

-- CreateIndex
CREATE INDEX "Page_projectId_lastSeenRunId_idx" ON "Page"("projectId", "lastSeenRunId");

-- CreateIndex
CREATE UNIQUE INDEX "Page_projectId_identityVersion_urlKey_key" ON "Page"("projectId", "identityVersion", "urlKey");

-- CreateIndex
CREATE INDEX "PageObservation_runId_fetchOutcome_idx" ON "PageObservation"("runId", "fetchOutcome");

-- CreateIndex
CREATE UNIQUE INDEX "PageObservation_runId_pageId_key" ON "PageObservation"("runId", "pageId");

-- AddForeignKey
ALTER TABLE "CrawlRun" ADD CONSTRAINT "CrawlRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlFrontier" ADD CONSTRAINT "CrawlFrontier_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CrawlRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Page" ADD CONSTRAINT "Page_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageObservation" ADD CONSTRAINT "PageObservation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CrawlRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageObservation" ADD CONSTRAINT "PageObservation_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

