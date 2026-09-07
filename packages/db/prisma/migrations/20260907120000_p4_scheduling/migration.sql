CREATE TABLE "CrawlSchedule" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "intervalDays" INTEGER NOT NULL DEFAULT 7,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "displayTimezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrawlSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleOccurrence" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "runId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrawlSchedule_projectId_key" ON "CrawlSchedule"("projectId");

-- CreateIndex
CREATE INDEX "ScheduleOccurrence_projectId_scheduledFor_idx" ON "ScheduleOccurrence"("projectId", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleOccurrence_projectId_scheduledFor_key" ON "ScheduleOccurrence"("projectId", "scheduledFor");

-- AddForeignKey
ALTER TABLE "CrawlSchedule" ADD CONSTRAINT "CrawlSchedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleOccurrence" ADD CONSTRAINT "ScheduleOccurrence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleOccurrence" ADD CONSTRAINT "ScheduleOccurrence_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "CrawlSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

