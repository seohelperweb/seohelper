import type { DbClient, PrismaClient, Workspace } from "@seo/db";

export async function listForUser(db: DbClient, userId: string) {
  return db.membership.findMany({
    where: { userId },
    select: { role: true, workspace: { select: { id: true, name: true, createdAt: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function findById(db: DbClient, id: string): Promise<Workspace | null> {
  return db.workspace.findUnique({ where: { id } });
}

export async function createWithOwner(db: PrismaClient, input: { name: string; ownerId: string }): Promise<Workspace> {
  return db.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({ data: { name: input.name } });
    await tx.membership.create({ data: { workspaceId: workspace.id, userId: input.ownerId, role: "OWNER" } });
    return workspace;
  });
}
