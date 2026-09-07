import type { DbClient, PrismaClient, Project } from "@seo/db";
import { encodeCursor } from "../api/cursor.ts";

export interface InitialPolicy {
  config: unknown;
  identityVersion: number;
  extractorVersion: number;
  ruleVersion: number;
  policyHash: string;
}

export async function createWithPolicy(
  db: PrismaClient,
  input: { workspaceId: string; hostname: string; displayName: string | null; policy: InitialPolicy },
): Promise<Project> {
  return db.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: { workspaceId: input.workspaceId, hostname: input.hostname, displayName: input.displayName },
    });
    const policy = await tx.projectPolicy.create({
      data: {
        projectId: project.id,
        version: 1,
        config: input.policy.config as object,
        identityVersion: input.policy.identityVersion,
        extractorVersion: input.policy.extractorVersion,
        ruleVersion: input.policy.ruleVersion,
        policyHash: input.policy.policyHash,
      },
    });
    return tx.project.update({ where: { id: project.id }, data: { currentPolicyId: policy.id } });
  });
}

export async function findScoped(db: DbClient, workspaceId: string, projectId: string) {
  return db.project.findFirst({
    where: { id: projectId, workspaceId },
    include: {
      currentPolicy: true,
      verifications: { orderBy: { challengeVersion: "desc" }, take: 1 },
    },
  });
}

export async function listScoped(db: DbClient, workspaceId: string, page: { where?: object; take: number }) {
  const items = await db.project.findMany({
    where: { workspaceId, ...(page.where ?? {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.take + 1,
    select: {
      id: true,
      hostname: true,
      displayName: true,
      verificationStatus: true,
      archivedAt: true,
      createdAt: true,
      verifications: {
        orderBy: { challengeVersion: "desc" },
        take: 1,
        select: {
          status: true,
          verifiedAt: true,
          expiresAt: true,
          lastError: true,
          attempts: true,
          challengeValue: true,
        },
      },
    },
  });
  const hasMore = items.length > page.take;
  const visible = hasMore ? items.slice(0, page.take) : items;
  const last = visible.at(-1);
  return { items: visible, nextCursor: hasMore && last ? encodeCursor(last) : null };
}

export async function update(
  db: DbClient,
  projectId: string,
  data: { displayName?: string | null; archivedAt?: Date | null },
): Promise<Project> {
  return db.project.update({ where: { id: projectId }, data });
}

/** Lock the project row for verification rotation and future crawl guards. */
export async function lockProject(db: DbClient, projectId: string): Promise<void> {
  await db.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
}
