import type { DbClient, PrismaClient } from "@seo/db";
import type { ClaimedEvent, VerificationRequestedPayload } from "../repositories/outbox.ts";
import { markDelivered, reschedule } from "../repositories/outbox.ts";
import * as verifications from "../repositories/verifications.ts";
import { lockProject } from "../repositories/projects.ts";
import { matchesChallengeRecord, verificationExpiry, verificationRecordName } from "../verification/challenge.ts";

export type TxtResolver = (hostname: string) => Promise<string[][]>;

export const VERIFICATION_MAX_ATTEMPTS = 3;
export const VERIFICATION_RETRY_BASE_MS = 60_000;

export type VerificationJobOutcome = "delivered" | "rescheduled";

/**
 * Worker-side verification job (docs/ARCHITECTURE.md §4):
 * - challenge fencing: results from a rotated challenge are discarded;
 * - success marks verification SUCCEEDED + project ACTIVE (30-day validity);
 * - failures retry with linear backoff up to VERIFICATION_MAX_ATTEMPTS.
 */
export async function processVerificationJob(
  db: PrismaClient,
  event: ClaimedEvent,
  resolver: TxtResolver,
  now?: Date,
): Promise<VerificationJobOutcome> {
  const verification = await db.$transaction(async (tx) => {
    const checkedAt = now ?? new Date();
    const current = await loadCurrentVerification(tx, event, checkedAt);
    if (!current) return null;
    await verifications.setStatus(tx, current.id, "RUNNING", { checkedAt, attempts: event.attempts });
    return current;
  });
  if (!verification) return "delivered";

  let matched = false;
  let message = "challenge TXT record not found or mismatch";
  try {
    const records = await resolver(verificationRecordName(verification.project.hostname));
    matched = matchesChallengeRecord(records, verification.challengeValue);
  } catch (error) {
    message = error instanceof Error ? error.message : "DNS lookup failed";
  }

  // DNS runs outside transactions. Revalidate both the event lease and current
  // challenge before atomically committing the result and acknowledgement.
  return db.$transaction(async (tx) => {
    const checkedAt = now ?? new Date();
    const current = await loadCurrentVerification(tx, event, checkedAt);
    if (!current) return "delivered";
    if (matched) {
      await verifications.setStatus(tx, current.id, "SUCCEEDED", {
        checkedAt,
        verifiedAt: checkedAt,
        expiresAt: verificationExpiry(checkedAt),
        lastError: null,
      });
      await verifications.markProjectActive(tx, current.projectId, checkedAt);
      await markDelivered(tx, event.id, event.claimToken, checkedAt);
      return "delivered";
    }
    return failOrRetry(tx, event, current.id, message, checkedAt);
  });
}

async function loadCurrentVerification(db: DbClient, event: ClaimedEvent, now: Date) {
  const claims = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "OutboxEvent"
    WHERE "id" = ${event.id} AND "claimToken" = ${event.claimToken}
      AND "deliveredAt" IS NULL AND "claimUntil" > ${now}
    FOR UPDATE`;
  if (claims.length !== 1) return null;
  const payload = event.payload as VerificationRequestedPayload;
  const verification = await verifications.findById(db, payload.verificationId);
  if (verification) await lockProject(db, verification.projectId);
  const latest = verification ? await verifications.findLatest(db, verification.projectId) : null;
  if (
    !verification ||
    verification.project.workspaceId !== payload.workspaceId ||
    verification.challengeVersion !== payload.challengeVersion ||
    latest?.id !== verification.id ||
    latest.status === "SUCCEEDED" ||
    latest.status === "FAILED"
  ) {
    await markDelivered(db, event.id, event.claimToken, now);
    return null;
  }
  return verification;
}

async function failOrRetry(
  db: DbClient,
  event: ClaimedEvent,
  verificationId: string,
  message: string,
  now: Date,
): Promise<VerificationJobOutcome> {
  // claimBatch increments attempts on every claim; event.attempts is 1-based per processing round.
  if (event.attempts >= VERIFICATION_MAX_ATTEMPTS) {
    await verifications.setStatus(db, verificationId, "FAILED", { checkedAt: now, lastError: message });
    await markDelivered(db, event.id, event.claimToken, now);
    return "delivered";
  }
  await verifications.setStatus(db, verificationId, "PENDING", { checkedAt: now, lastError: message });
  await reschedule(db, event.id, event.claimToken, VERIFICATION_RETRY_BASE_MS * event.attempts, now);
  return "rescheduled";
}
