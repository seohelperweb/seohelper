import { isVerificationValid, verificationRecordName, buildRecordValue } from "@/server/verification/challenge.ts";

interface VerificationLike {
  status: string;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  lastError: string | null;
  attempts: number;
}

interface ProjectLike {
  id: string;
  hostname: string;
  displayName: string | null;
  verificationStatus: string;
  archivedAt: Date | null;
  createdAt: Date;
}

/** Public project shape: verification summary plus the active DNS challenge when one is pending. */
export function projectDto<T extends VerificationLike & { challengeValue?: string }>(
  project: ProjectLike,
  latestVerification: T | null,
) {
  const valid = latestVerification?.verifiedAt ? isVerificationValid(latestVerification.verifiedAt) : false;
  const challengeActive =
    latestVerification !== null && (latestVerification.status === "PENDING" || latestVerification.status === "RUNNING");
  return {
    id: project.id,
    hostname: project.hostname,
    displayName: project.displayName,
    verificationStatus: project.verificationStatus,
    archivedAt: project.archivedAt,
    createdAt: project.createdAt,
    verification: latestVerification
      ? {
          status: latestVerification.status,
          verifiedAt: latestVerification.verifiedAt,
          expiresAt: latestVerification.expiresAt,
          valid,
          lastError: latestVerification.lastError,
          attempts: latestVerification.attempts,
        }
      : null,
    activeChallenge: challengeActive
      ? {
          recordName: verificationRecordName(project.hostname),
          recordValue:
            latestVerification.challengeValue !== undefined
              ? buildRecordValue(latestVerification.challengeValue)
              : null,
        }
      : null,
  };
}
