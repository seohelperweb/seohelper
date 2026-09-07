import test from "node:test";
import assert from "node:assert/strict";
import { clampPageSize, decodeCursor, encodeCursor } from "../../server/api/cursor.ts";

test("round-trips a cursor and rejects malformed values", () => {
  const cursor = encodeCursor({ createdAt: new Date("2026-09-06T10:00:00.000Z"), id: "abc123" });
  const decoded = decodeCursor(cursor);
  assert.ok(decoded);
  assert.equal(decoded.id, "abc123");
  assert.equal(decoded.createdAt, "2026-09-06T10:00:00.000Z");
  assert.equal(decodeCursor(null), null);
  assert.equal(decodeCursor(""), null);
  assert.equal(decodeCursor("!!!not-base64url"), null);
  assert.equal(decodeCursor(Buffer.from("no-pipe-here", "utf8").toString("base64url")), null);
});

test("clamps page sizes to the configured range", () => {
  assert.equal(clampPageSize(null), 50);
  assert.equal(clampPageSize(0), 50);
  assert.equal(clampPageSize(-5), 50);
  assert.equal(clampPageSize(10), 10);
  assert.equal(clampPageSize(500), 100);
  assert.equal(clampPageSize(100), 100);
});
