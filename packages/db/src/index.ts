import { Prisma, PrismaClient } from "@prisma/client";

export { PrismaClient, Prisma } from "@prisma/client";
export type DbClient = Prisma.TransactionClient;
export {
  WorkspaceRole,
  ProjectVerificationStatus,
  VerificationJobStatus,
  CrawlRunStatus,
  CrawlTrigger,
  CrawlCompleteness,
  ComparisonMode,
  CrawlFetchOutcome,
  FrontierState,
  FrontierSource,
  ChangeSeverity,
  IssueState,
} from "@prisma/client";
export type {
  Workspace,
  Membership,
  Invitation,
  Project,
  ProjectPolicy,
  DomainVerification,
  OutboxEvent,
  IdempotencyRecord,
  AuditLog,
  User,
  CrawlRun,
  CrawlFrontier,
  Page,
  PageObservation,
  ChangeEvent,
  Issue,
  IssueTransition,
  CrawlSummary,
} from "@prisma/client";

/**
 * Prisma client factory with a global cache so Next.js dev HMR and the worker
 * process reuse one connection pool. Tests may create isolated instances.
 */
export function createDb(log?: ("query" | "info" | "warn" | "error")[]): PrismaClient {
  return new PrismaClient(log ? { log } : undefined);
}

const globalForDb = globalThis as { __indexlyDb?: PrismaClient };

export function getDb(): PrismaClient {
  if (!globalForDb.__indexlyDb) {
    globalForDb.__indexlyDb = createDb();
  }
  return globalForDb.__indexlyDb;
}
