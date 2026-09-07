import test from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../../server/api/handle.ts";
import { readJson } from "../../server/api/read-json.ts";

test("malformed JSON yields a 400 API envelope", async () => {
  for (const body of ["", "{invalid"]) {
    const request = new Request("http://localhost:3000/api/v1/workspaces", { method: "POST", body });
    const response = await handleApi(request, () => readJson(request));
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, "VALIDATION_FAILED");
    assert.ok(payload.requestId);
  }
});

test("valid JSON reaches request validation without altering its value", async () => {
  const request = new Request("http://localhost:3000/api/v1/workspaces", { method: "POST", body: '{"name":"Team"}' });
  assert.deepEqual(await readJson(request), { name: "Team" });
});
