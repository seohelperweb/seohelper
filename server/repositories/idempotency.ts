import type { DbClient } from "@seo/db";
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
  db: DbClient,
  input: { actorId: string; workspaceId: string; route: string; key: string; requestHash: string; ttlMs: number },
  run: () => Promise<string>,
): Promise<IdempotencyOutcome> {
  const existing = await db.idempotencyRecord.findUnique({
    where: {
      actorId_workspaceId_route_key: {
        actorId: input.actorId,
        workspaceId: input.workspaceId,
        route: input.route,
        key: input.key,
      },
    },
  });
  if (existing) {
    if (existing.requestHash !== input.requestHash) {
      throw ApiError.conflict("Idempotency key was already used with a different request");
    }
    return { resourceId: existing.resourceId, replay: true };
  }

  const resourceId = await run();
  try {
    await db.idempotencyRecord.create({
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
  } catch (error) {
    // Lost a race against a concurrent identical request — treat as replay.
    const code = (error as { code?: string }).code;
    if (code === "P2002") {
      const winner = await db.idempotencyRecord.findUnique({
        where: {
          actorId_workspaceId_route_key: {
            actorId: input.actorId,
            workspaceId: input.workspaceId,
            route: input.route,
            key: input.key,
          },
        },
      });
      if (winner && winner.requestHash === input.requestHash) {
        return { resourceId: winner.resourceId, replay: true };
      }
    }
    throw error;
  }
  return { resourceId, replay: false };
}
