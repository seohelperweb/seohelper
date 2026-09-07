import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createInvitationToken, hashToken, invitationExpiry, isExpired } from "../../server/invitations/tokens.ts";
import {
  buildRecordValue,
  createChallengeValue,
  hashChallengeValue,
  isVerificationValid,
  matchesChallengeRecord,
  verificationExpiry,
  verificationRecordName,
} from "../../server/verification/challenge.ts";
import { CrawlBlockedError, assertProjectCrawlable, crawlBlockReason } from "../../server/crawl/crawl-guard.ts";
import { redactAuditDetails } from "../../server/audit/redact.ts";

test("invitation tokens are random and stored only as sha-256 hashes", () => {
  const token = createInvitationToken();
  assert.notEqual(token, createInvitationToken());
  assert.equal(hashToken(token), createHash("sha256").update(token).digest("hex"));
  const expiry = invitationExpiry(new Date("2026-09-06T00:00:00Z"));
  assert.equal(isExpired(expiry, new Date("2026-09-08T00:00:00Z")), false);
  assert.equal(isExpired(expiry, new Date("2026-09-09T00:01:00Z")), true);
});

test("dns challenge records match only the exact expected value", () => {
  const value = createChallengeValue();
  const name = verificationRecordName("Example.COM");
  assert.equal(name, "_indexly-challenge.example.com");
  const good = [[buildRecordValue(value)]];
  assert.equal(matchesChallengeRecord(good, value), true);
  assert.equal(matchesChallengeRecord([[["indexly-verification=", value].join("")]], value), true);
  assert.equal(matchesChallengeRecord([["  " + buildRecordValue(value) + "  "]], value), true);
  assert.equal(matchesChallengeRecord([[buildRecordValue("other-value")]], value), false);
  assert.equal(matchesChallengeRecord([[buildRecordValue(value.toUpperCase())]], value), false);
  assert.equal(matchesChallengeRecord([], value), false);
  assert.equal(hashChallengeValue(value), createHash("sha256").update(value).digest("hex"));
});

test("verification validity window is 30 days from verifiedAt", () => {
  const verifiedAt = new Date("2026-08-01T00:00:00Z");
  assert.equal(isVerificationValid(verifiedAt, new Date("2026-08-30T23:59:00Z")), true);
  assert.equal(isVerificationValid(verifiedAt, new Date("2026-08-31T00:00:01Z")), false);
  assert.equal(isVerificationValid(null), false);
  assert.deepEqual(verificationExpiry(verifiedAt), new Date("2026-08-31T00:00:00Z"));
});

test("crawl guard blocks unverified, inactive, and expired projects", () => {
  const validityMs = 30 * 24 * 60 * 60 * 1000;
  const now = new Date("2026-09-06T00:00:00Z");
  const base = { id: "p1", hostname: "example.com" };

  assert.throws(
    () => assertProjectCrawlable({ ...base, verificationStatus: "ACTIVE", latestVerification: null }, validityMs, now),
    CrawlBlockedError,
  );
  assert.throws(
    () =>
      assertProjectCrawlable(
        {
          ...base,
          verificationStatus: "PENDING_VERIFICATION",
          latestVerification: { verifiedAt: new Date("2026-09-01T00:00:00Z") },
        },
        validityMs,
        now,
      ),
    CrawlBlockedError,
  );
  assert.equal(
    crawlBlockReason(
      { ...base, verificationStatus: "ACTIVE", latestVerification: { verifiedAt: new Date("2026-08-01T00:00:00Z") } },
      validityMs,
      now,
    ),
    "domain verification expired",
  );
  assertProjectCrawlable(
    { ...base, verificationStatus: "ACTIVE", latestVerification: { verifiedAt: new Date("2026-09-05T00:00:00Z") } },
    validityMs,
    now,
  );
});

test("audit redaction drops sensitive keys, long values, and non-primitives", () => {
  const details = redactAuditDetails({
    action: "member.invited",
    email: "user@example.com",
    invitationToken: "super-secret",
    password: "hunter2",
    count: 3,
    enabled: false,
    nested: { deep: true },
    long: "x".repeat(500),
  });
  assert.equal(details.action, "member.invited");
  assert.equal(details.count, 3);
  assert.equal(details.enabled, false);
  assert.equal("invitationToken" in details, false);
  assert.equal("password" in details, false);
  assert.equal("nested" in details, false);
  assert.equal((details.long as string).length <= 201, true);
});
