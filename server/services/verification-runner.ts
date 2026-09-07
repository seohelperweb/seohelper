import type { DbClient, PrismaClient } from "@seo/db";
import type { ClaimedEvent, VerificationRequestedPayload } from "../repositories/outbox.ts";
import { markDelivered, reschedule } from "../repositories/outbox.ts";
import * as verifications from "../repositories/verifications.ts";
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
  now: Date = new Date(),
): Promise<VerificationJobOutcome> {
  const payload = event.payload as VerificationRequestedPayload;
  const verification = await verifications.findById(db, payload.verificationId);

  if (!verification || verification.challengeVersion !== payload.challengeVersion) {
    // Stale job from a rotated challenge — never update the new one.
    await markDelivered(db, event.id, event.claimToken, now);
    return "delivered";
  }
  if (verification.status === "SUCCEEDED" || verification.status === "FAILED") {
    await markDelivered(db, event.id, event.claimToken, now);
    return "delivered";
  }

  await verifications.setStatus(db, verification.id, "RUNNING", { checkedAt: now });
  try {
    const records = await resolver(verificationRecordName(verification.project.hostname));
    if (matchesChallengeRecord(records, verification.challengeValue)) {
      await db.$transaction(async (tx) => {
        await verifications.setStatus(tx, verification.id, "SUCCEEDED", {
          checkedAt: now,
          verifiedAt: now,
          expiresAt: verificationExpiry(now),
          lastError: null,
        });
        await verifications.markProjectActive(tx, verification.projectId, now);
      });
      await markDelivered(db, event.id, event.claimToken, now);
      return "delivered";
    }
    return await failOrRetry(db, event, verification.id, "challenge TXT record not found or mismatch", now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "DNS lookup failed";
    return await failOrRetry(db, event, verification.id, message, now);
  }
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
