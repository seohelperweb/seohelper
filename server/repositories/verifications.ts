import type { DomainVerification, DbClient, VerificationJobStatus } from "@seo/db";

export async function findLatest(db: DbClient, projectId: string): Promise<DomainVerification | null> {
  return db.domainVerification.findFirst({ where: { projectId }, orderBy: { challengeVersion: "desc" } });
}

export async function findById(db: DbClient, id: string) {
  return db.domainVerification.findUnique({ where: { id }, include: { project: true } });
}

export async function create(
  db: DbClient,
  input: { projectId: string; challengeValue: string; challengeValueHash: string; challengeVersion: number },
): Promise<DomainVerification> {
  return db.domainVerification.create({ data: { ...input, status: "PENDING" } });
}

export async function setStatus(
  db: DbClient,
  id: string,
  status: VerificationJobStatus,
  extra?: { checkedAt?: Date; lastError?: string | null; verifiedAt?: Date | null; expiresAt?: Date | null },
): Promise<DomainVerification> {
  return db.domainVerification.update({ where: { id }, data: { status, ...extra } });
}

export async function markProjectActive(db: DbClient, projectId: string, now: Date): Promise<void> {
  await db.project.update({
    where: { id: projectId },
    data: { verificationStatus: "ACTIVE", archivedAt: undefined, updatedAt: now },
  });
}
