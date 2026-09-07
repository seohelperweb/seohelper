import { createHash, randomBytes } from "node:crypto";

/**
 * Invitation tokens (docs/ARCHITECTURE.md §4): 32 random bytes, shown once,
 * stored only as a SHA-256 hash. Default expiry 72 hours; tokens never appear
 * in logs.
 */

export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

export function createInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function invitationExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITATION_TTL_MS);
}

export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}
