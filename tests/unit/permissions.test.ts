import test from "node:test";
import assert from "node:assert/strict";
import { can, canModifyMember, isWorkspaceRole } from "../../server/auth/permissions.ts";

test("view is granted to every role, crawl actions to member and above", () => {
  assert.equal(can("VIEWER", "view"), true);
  assert.equal(can("MEMBER", "view"), true);
  assert.equal(can("VIEWER", "run-crawl"), false);
  assert.equal(can("MEMBER", "run-crawl"), true);
  assert.equal(can("OWNER", "run-crawl"), true);
});

test("project and member management requires admin, owner management only owners", () => {
  assert.equal(can("MEMBER", "manage-project"), false);
  assert.equal(can("ADMIN", "manage-project"), true);
  assert.equal(can("ADMIN", "manage-members"), true);
  assert.equal(can("ADMIN", "manage-owners"), false);
  assert.equal(can("OWNER", "manage-owners"), true);
});

test("owner rows and owner grants are reserved to owner actors", () => {
  assert.equal(canModifyMember("ADMIN", "OWNER"), false);
  assert.equal(canModifyMember("ADMIN", "ADMIN", "OWNER"), false);
  assert.equal(canModifyMember("OWNER", "OWNER", "ADMIN"), true);
  assert.equal(canModifyMember("OWNER", "MEMBER", "ADMIN"), true);
  assert.equal(canModifyMember("ADMIN", "MEMBER", "VIEWER"), true);
  assert.equal(canModifyMember("MEMBER", "VIEWER", "VIEWER"), false);
});

test("role parsing rejects unknown values", () => {
  assert.equal(isWorkspaceRole("OWNER"), true);
  assert.equal(isWorkspaceRole("owner"), false);
  assert.equal(isWorkspaceRole("SUPERUSER"), false);
});
