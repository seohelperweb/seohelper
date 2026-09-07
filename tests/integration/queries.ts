import type { PrismaClient } from "@seo/db";

/** Small direct-query helpers for arranging and asserting test state. */
export const memberships = {
  findId(client: PrismaClient, workspaceId: string, userId: string): Promise<string> {
    return client.membership
      .findFirstOrThrow({ where: { workspaceId, userId }, select: { id: true } })
      .then((row) => row.id);
  },
};

export const outbox = {
  async resetAvailability(client: PrismaClient, eventId: string): Promise<void> {
    await client.outboxEvent.update({ where: { id: eventId }, data: { availableAt: new Date(Date.now() - 1000) } });
  },
};
