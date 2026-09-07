import { randomUUID } from "node:crypto";
import type { DbClient } from "@seo/db";

export const VERIFICATION_REQUESTED = "verification.requested";
export const CRAWL_REQUESTED = "crawl.requested";

export interface CrawlRequestedPayload {
  workspaceId: string;
  projectId: string;
  crawlId: string;
}

export interface VerificationRequestedPayload {
  workspaceId: string;
  verificationId: string;
  challengeVersion: number;
}

export async function emit(
  db: DbClient,
  input: { type: string; aggregateId: string; payload: object; availableAt?: Date },
): Promise<string> {
  const event = await db.outboxEvent.create({
    data: {
      eventId: randomUUID(),
      type: input.type,
      aggregateId: input.aggregateId,
      payload: input.payload as object,
      availableAt: input.availableAt ?? new Date(),
    },
  });
  return event.id;
}

export interface ClaimedEvent {
  id: string;
  type: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
  claimToken: string;
}

/**
 * Atomically claim due events with `FOR UPDATE SKIP LOCKED` so multiple
 * workers never process the same event (docs/ARCHITECTURE.md §7). The claim
 * token guards finishing: a worker whose lease expired cannot mark results.
 */
export async function claimBatch(
  db: DbClient,
  input: { type: string; limit: number; leaseMs: number; now?: Date },
): Promise<ClaimedEvent[]> {
  const now = input.now ?? new Date();
  const claimToken = randomUUID();
  const claimUntil = new Date(now.getTime() + input.leaseMs);
  const rows = await db.$queryRaw<
    Array<{ id: string; type: string; aggregateId: string; payload: unknown; attempts: number }>
  >`
    UPDATE "OutboxEvent"
    SET "claimToken" = ${claimToken}, "claimUntil" = ${claimUntil}, "attempts" = "attempts" + 1
    WHERE "id" IN (
      SELECT "id" FROM "OutboxEvent"
      WHERE "type" = ${input.type}
        AND "deliveredAt" IS NULL
        AND "availableAt" <= ${now}
        AND ("claimUntil" IS NULL OR "claimUntil" < ${now})
      ORDER BY "availableAt" ASC
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "type", "aggregateId", "payload", "attempts"`;
  return rows.map((row) => ({ ...row, claimToken }));
}

export async function markDelivered(db: DbClient, eventId: string, claimToken: string, now?: Date): Promise<boolean> {
  const result = await db.outboxEvent.updateMany({
    where: { id: eventId, claimToken },
    data: { deliveredAt: now ?? new Date(), claimToken: null, claimUntil: null },
  });
  return result.count === 1;
}

/** Release the claim and push the event's availability forward for a retry. */
export async function reschedule(
  db: DbClient,
  eventId: string,
  claimToken: string,
  delayMs: number,
  now?: Date,
): Promise<boolean> {
  const at = (now ?? new Date()).getTime() + delayMs;
  const result = await db.outboxEvent.updateMany({
    where: { id: eventId, claimToken },
    data: { availableAt: new Date(at), claimToken: null, claimUntil: null },
  });
  return result.count === 1;
}
