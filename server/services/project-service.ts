import { createHash } from "node:crypto";
import type { DbClient, PrismaClient, Project } from "@seo/db";
import { assertSafeCrawlUrl } from "@seo/crawler";
import { ApiError } from "../api/errors.ts";
import type { ActorContext } from "../auth/actor.ts";
import { can } from "../auth/permissions.ts";
import { record as recordAudit } from "../repositories/audit.ts";
import { VERIFICATION_REQUESTED, emit } from "../repositories/outbox.ts";
import * as projects from "../repositories/projects.ts";
import * as verifications from "../repositories/verifications.ts";
import { ACTIVE_RUN_STATUSES } from "../repositories/crawls.ts";
import {
  createChallengeValue,
  hashChallengeValue,
  verificationRecordName,
  buildRecordValue,
} from "../verification/challenge.ts";

/** Crawl defaults recorded on policy v1 (docs/ARCHITECTURE.md §7.3 budgets). */
export const DEFAULT_POLICY_CONFIG = {
  maxPages: 5000,
  maxFrontierUrls: 20000,
  crawlMaxDurationMinutes: 120,
  finishGraceMinutes: 10,
  requestTimeoutMs: 20000,
  dnsConnectTimeoutMs: 5000,
  maxRedirects: 5,
  maxBodyBytes: 2097152,
  totalBodyBudgetBytes: 524288000,
  hostRateRequestsPerSecond: 1,
  hostMaxInFlight: 2,
} as const;

export function defaultPolicyHash(): string {
  return createHash("sha256").update(JSON.stringify(DEFAULT_POLICY_CONFIG), "utf8").digest("hex");
}

/**
 * Validate a crawl hostname: exact public hostname, no scheme/path/credentials,
 * no localhost variants, no literal private addresses — the same literal rules
 * as assertSafeCrawlUrl (docs/ARCHITECTURE.md §4, §11).
 */
export function validateHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (!normalized || normalized.includes("/")) throw ApiError.badRequest("Hostname must not contain a path");
  let parsed: URL;
  try {
    parsed = assertSafeCrawlUrl(`https://${normalized}`);
  } catch (error) {
    throw ApiError.badRequest(`Invalid hostname: ${error instanceof Error ? error.message : "rejected"}`);
  }
  if (parsed.hostname !== normalized) throw ApiError.badRequest("Hostname contains unexpected syntax");
  if (parsed.pathname !== "/" || parsed.search) throw ApiError.badRequest("Hostname must not contain a path or query");
  return normalized;
}

export async function createProject(
  db: PrismaClient,
  actor: ActorContext,
  input: { hostname: string; displayName?: string | null },
  requestId?: string,
): Promise<Project> {
  if (!can(actor.role, "manage-project")) throw ApiError.forbidden();
  const hostname = validateHostname(input.hostname);
  const project = await projects.createWithPolicy(db, {
    workspaceId: actor.workspaceId,
    hostname,
    displayName: input.displayName?.trim() || null,
    policy: {
      config: DEFAULT_POLICY_CONFIG,
      identityVersion: 1,
      extractorVersion: 1,
      ruleVersion: 1,
      policyHash: defaultPolicyHash(),
    },
  });
  await recordAudit(db, {
    workspaceId: actor.workspaceId,
    actorId: actor.userId,
    action: "project.created",
    resourceId: project.id,
    requestId,
    details: { hostname },
  });
  return project;
}

export async function listProjects(db: DbClient, actor: ActorContext, page: { where?: object; take: number }) {
  if (!can(actor.role, "view")) throw ApiError.forbidden();
  return projects.listScoped(db, actor.workspaceId, page);
}

export type ProjectDetail = NonNullable<Awaited<ReturnType<typeof projects.findScoped>>>;

export async function getProject(db: DbClient, actor: ActorContext, projectId: string): Promise<ProjectDetail> {
  if (!can(actor.role, "view")) throw ApiError.forbidden();
  const project = await projects.findScoped(db, actor.workspaceId, projectId);
  if (!project) throw ApiError.notFound("Project not found");
  return project;
}

export async function updateProject(
  db: PrismaClient,
  actor: ActorContext,
  projectId: string,
  input: { displayName?: string | null; archived?: boolean },
  requestId?: string,
): Promise<ProjectDetail> {
  if (!can(actor.role, "manage-project")) throw ApiError.forbidden();
  return db.$transaction(async (tx) => {
    await projects.lockProject(tx, projectId);
    const existing = await projects.findScoped(tx, actor.workspaceId, projectId);
    if (!existing) throw ApiError.notFound("Project not found");
    const archiveChanged = input.archived !== undefined && input.archived !== (existing.archivedAt !== null);
    if (archiveChanged && input.archived) {
      const active = await tx.crawlRun.findFirst({
        where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: { id: true },
      });
      if (active) throw ApiError.conflict("A project with an active crawl cannot be archived", "CRAWL_ALREADY_ACTIVE");
    }
    await projects.update(tx, projectId, {
      ...(archiveChanged ? { archivedAt: input.archived ? new Date() : null } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName?.trim() || null } : {}),
    });
    if (archiveChanged) {
      await recordAudit(tx, {
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        action: input.archived ? "project.archived" : "project.unarchived",
        resourceId: projectId,
        requestId,
      });
    }
    const updated = await projects.findScoped(tx, actor.workspaceId, projectId);
    if (!updated) throw ApiError.notFound("Project not found");
    return updated;
  });
}

export interface VerificationRequestResult {
  verificationId: string;
  status: "PENDING";
  recordName: string;
  recordValue: string;
}

/**
 * Rotate the DNS TXT challenge and queue a verification job via the Outbox
 * (docs/ARCHITECTURE.md §4). At most one active check per project; the
 * project row lock serializes concurrent requests.
 */
export async function requestVerification(
  db: PrismaClient,
  actor: ActorContext,
  projectId: string,
  requestId?: string,
): Promise<VerificationRequestResult> {
  if (!can(actor.role, "manage-project")) throw ApiError.forbidden();
  const result = await db.$transaction(async (tx) => {
    const project = await projects.findScoped(tx, actor.workspaceId, projectId);
    if (!project) throw ApiError.notFound("Project not found");
    await projects.lockProject(tx, project.id);

    const latest = await verifications.findLatest(tx, project.id);
    if (latest && (latest.status === "PENDING" || latest.status === "RUNNING")) {
      throw ApiError.conflict("A verification check is already in progress for this project");
    }
    const challengeVersion = (latest?.challengeVersion ?? 0) + 1;
    const challengeValue = createChallengeValue();
    const verification = await verifications.create(tx, {
      projectId: project.id,
      challengeValue,
      challengeValueHash: hashChallengeValue(challengeValue),
      challengeVersion,
    });
    await emit(tx, {
      type: VERIFICATION_REQUESTED,
      aggregateId: verification.id,
      payload: { workspaceId: actor.workspaceId, verificationId: verification.id, challengeVersion },
    });
    await recordAudit(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "project.verification_requested",
      resourceId: verification.id,
      requestId,
      details: { challengeVersion },
    });
    return {
      verificationId: verification.id,
      recordName: verificationRecordName(project.hostname),
      recordValue: buildRecordValue(challengeValue),
    };
  });
  return {
    verificationId: result.verificationId,
    status: "PENDING",
    recordName: result.recordName,
    recordValue: result.recordValue,
  };
}
