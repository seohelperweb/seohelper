import test from "node:test";
import assert from "node:assert/strict";
import { assertSameOrigin, isSafeMethod } from "../../server/api/csrf.ts";
import { ApiError } from "../../server/api/errors.ts";
import { checkAuthRateLimit, cleanupBuckets, clientKey } from "../../server/auth/rate-limit.ts";

const requestWith = (init: {
  method?: string;
  url?: string;
  origin?: string | null;
  headers?: Record<string, string>;
}): Request => {
  const headers = new Headers(init.headers);
  if (init.origin !== undefined && init.origin !== null) headers.set("origin", init.origin);
  return new Request(init.url ?? "http://localhost:3000/api/v1/workspaces", {
    method: init.method ?? "POST",
    headers,
  });
};

test("cross-origin state-changing requests are rejected", () => {
  const evil = requestWith({ method: "POST", origin: "https://evil.example" });
  assert.throws(
    () => assertSameOrigin(evil),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 403);
      return true;
    },
  );
  const valid = requestWith({ method: "POST", origin: "http://localhost:3000" });
  assert.doesNotThrow(() => assertSameOrigin(valid));
});

test("missing Origin is allowed for non-browser clients; safe methods skip checks", () => {
  assert.doesNotThrow(() => assertSameOrigin(requestWith({ method: "POST", origin: null })));
  const evilGet = requestWith({ method: "GET", origin: "https://evil.example" });
  assert.doesNotThrow(() => assertSameOrigin(evilGet));
  assert.equal(isSafeMethod("get"), true);
  assert.equal(isSafeMethod("DELETE"), false);
});

test("an explicit opaque or malformed Origin cannot bypass CSRF validation", () => {
  for (const origin of ["null", "", "not-an-origin"]) {
    assert.throws(() => assertSameOrigin(requestWith({ origin })), ApiError);
  }
});

test("auth rate limiter enforces sliding windows per subject and resets after expiry", () => {
  cleanupBuckets(0);
  const path = "/api/auth/sign-in/email";
  const t0 = 1_000_000;
  // 20 attempts within the 15-minute window pass…
  for (let i = 0; i < 20; i += 1) {
    assert.equal(checkAuthRateLimit(path, "1.2.3.4", t0 + i), true);
  }
  // …the 21st is denied…
  assert.equal(checkAuthRateLimit(path, "1.2.3.4", t0 + 100), false);
  // …a different subject is unaffected…
  assert.equal(checkAuthRateLimit(path, "5.6.7.8", t0 + 100), true);
  // …and after the window elapses the bucket frees up.
  cleanupBuckets(t0 + 15 * 60_000 + 1);
  assert.equal(checkAuthRateLimit(path, "1.2.3.4", t0 + 15 * 60_000 + 1), true);
});

test("sign-up and verification endpoints have their own limits; unknown routes pass", () => {
  cleanupBuckets(0);
  assert.equal(checkAuthRateLimit("/api/auth/unknown-route", "1.2.3.4"), true);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(checkAuthRateLimit("/api/auth/sign-up/email", "9.9.9.9", 2_000_000 + i), true);
  }
  assert.equal(checkAuthRateLimit("/api/auth/sign-up/email", "9.9.9.9", 2_000_000 + 100), false);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(checkAuthRateLimit("/api/auth/send-verification-email", "9.9.9.9", 2_000_000 + i), true);
  }
  assert.equal(checkAuthRateLimit("/api/auth/send-verification-email", "9.9.9.9", 2_000_000 + 100), false);
});

test("client key prefers the forwarded IP header", () => {
  const request = requestWith({ headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } });
  assert.equal(clientKey(request), "203.0.113.7");
});
