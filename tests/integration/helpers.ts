import { createDb } from "@seo/db";
import type { PrismaClient, WorkspaceRole } from "@seo/db";
import type { ActorContext } from "../../server/auth/actor.ts";

let counter = 0;
export function uniqueId(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface TestUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export function db(): PrismaClient {
  return createDb();
}

export async function createUser(
  client: PrismaClient,
  options?: { email?: string; verified?: boolean; name?: string },
): Promise<TestUser> {
  const email = options?.email ?? `u${uniqueId()}@example.test`;
  const user = await client.user.create({
    data: {
      id: `usr_${uniqueId()}`,
      name: options?.name ?? "Test User",
      email,
      emailVerified: options?.verified ?? true,
    },
  });
  return { id: user.id, email: user.email, emailVerified: user.emailVerified };
}

export async function createWorkspaceWithOwner(
  client: PrismaClient,
  owner: TestUser,
  name = "Test Workspace",
): Promise<string> {
  const { createWorkspace } = await import("../../server/services/workspace-service.ts");
  const workspace = await createWorkspace(client, { userId: owner.id }, { name });
  return workspace.id;
}

export function actor(userId: string, workspaceId: string, role: WorkspaceRole): ActorContext {
  return { userId, workspaceId, role };
}

/** Wipe all business + identity tables between suites (FK-safe TRUNCATE). */
export async function cleanDatabase(client: PrismaClient): Promise<void> {
  await client.$queryRaw`TRUNCATE TABLE
    "AuditLog", "IdempotencyRecord", "OutboxEvent", "PageObservation", "CrawlFrontier",
    "CrawlRun", "Page", "DomainVerification",
    "ProjectPolicy", "Project", "Invitation", "Membership", "Workspace",
    "Verification", "Account", "Session", "User"
    RESTART IDENTITY CASCADE`;
}
