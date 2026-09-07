import { createHash, randomBytes } from "node:crypto";

/**
 * DNS TXT domain-verification challenges (docs/ARCHITECTURE.md §4).
 *
 * The challenge value is public by nature (it lives in DNS); we additionally
 * store its SHA-256 hash for integrity. Record layout:
 *   name:  _indexly-challenge.<hostname>
 *   value: indexly-verification=<challengeValue>
 */

export const VERIFICATION_RECORD_PREFIX = "_indexly-challenge";
export const VERIFICATION_VALUE_PREFIX = "indexly-verification";
export const VERIFICATION_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

export function createChallengeValue(): string {
  return randomBytes(24).toString("base64url");
}

export function hashChallengeValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function verificationRecordName(hostname: string): string {
  return `${VERIFICATION_RECORD_PREFIX}.${hostname.toLowerCase()}`;
}

export function buildRecordValue(challengeValue: string): string {
  return `${VERIFICATION_VALUE_PREFIX}=${challengeValue}`;
}

/**
 * Match TXT lookup results against the expected challenge. `records` is the
 * shape returned by node:dns resolveTxt: one array of string chunks per
 * record; chunks are joined before comparison.
 */
export function matchesChallengeRecord(records: string[][], expectedValue: string): boolean {
  const expected = buildRecordValue(expectedValue);
  return records.some((chunks) => chunks.join("").trim() === expected);
}

export function verificationExpiry(verifiedAt: Date): Date {
  return new Date(verifiedAt.getTime() + VERIFICATION_VALIDITY_MS);
}

export function isVerificationValid(verifiedAt: Date | null, now: Date = new Date()): boolean {
  return verifiedAt !== null && now.getTime() < verifiedAt.getTime() + VERIFICATION_VALIDITY_MS;
}
