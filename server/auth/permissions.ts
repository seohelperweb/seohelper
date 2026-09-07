/**
 * Workspace permission matrix (docs/ARCHITECTURE.md §4).
 *
 * Pure logic — no database, no framework imports. Services enforce these
 * rules on top of an ActorContext; the table below is the single source.
 */

export const WORKSPACE_ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

const ROLE_RANK: Record<WorkspaceRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

export const WORKSPACE_ACTIONS = ["view", "run-crawl", "manage-project", "manage-members", "manage-owners"] as const;
export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];

export function can(role: WorkspaceRole, action: WorkspaceAction): boolean {
  switch (action) {
    case "view":
      return true;
    case "run-crawl":
      return ROLE_RANK[role] >= ROLE_RANK.MEMBER;
    case "manage-project":
    case "manage-members":
      return ROLE_RANK[role] >= ROLE_RANK.ADMIN;
    case "manage-owners":
      return role === "OWNER";
  }
}

/**
 * May `actorRole` modify (change role of / remove) a member whose current
 * role is `targetRole`, optionally assigning `newRole`?
 * OWNER rows and OWNER grants are restricted to OWNER actors; the last-owner
 * protection itself needs a database count and lives in the member service.
 */
export function canModifyMember(actorRole: WorkspaceRole, targetRole: WorkspaceRole, newRole?: WorkspaceRole): boolean {
  if (targetRole === "OWNER" || newRole === "OWNER") {
    return actorRole === "OWNER";
  }
  return ROLE_RANK[actorRole] >= ROLE_RANK.ADMIN;
}

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}
