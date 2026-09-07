import type { DbClient, PrismaClient } from "@seo/db";
import { ApiError } from "../api/errors.ts";

export interface IdempotencyOutcome {
  resourceId: string;
  replay: boolean;
}

/**
 * Idempotent write helper (docs/ARCHITECTURE.md §10): same actor + route +
 * key + request hash returns the original resource; same key with a
 * different request hash is a 409. Records expire after `ttlMs`.
 */
export async function withIdempotency(
  db: PrismaClient,
  input: { actorId: string; workspaceId: string; route: string; key: string; requestHash: string; ttlMs: number },
  run: (tx: DbClient) => Promise<string>,
): Promise<IdempotencyOutcome> {
  return db.$transaction(async (tx) => {
    // There may be no record to row-lock yet. Serialize the logical key before
    // reading it, and commit the business write and replay record together.
    const lockKey = JSON.stringify([input.actorId, input.workspaceId, input.route, input.key]);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const existing = await tx.idempotencyRecord.findUnique({
      where: {
        actorId_workspaceId_route_key: {
          actorId: input.actorId,
          workspaceId: input.workspaceId,
          route: input.route,
          key: input.key,
        },
      },
    });
    if (existing && existing.expiresAt.getTime() > Date.now()) {
      if (existing.requestHash !== input.requestHash) {
        throw ApiError.conflict("Idempotency key was already used with a different request");
      }
      return { resourceId: existing.resourceId, replay: true };
    }
    if (existing) await tx.idempotencyRecord.delete({ where: { id: existing.id } });

    const resourceId = await run(tx);
    await tx.idempotencyRecord.create({
      data: {
        actorId: input.actorId,
        workspaceId: input.workspaceId,
        route: input.route,
        key: input.key,
        requestHash: input.requestHash,
        resourceId,
        expiresAt: new Date(Date.now() + input.ttlMs),
      },
    });
    return { resourceId, replay: false };
  });
}
