import test from "node:test";
import assert from "node:assert/strict";
import type { LookupAddress, LookupOptions } from "node:dns";
import { createDnsResolver, validatedLookup } from "../../packages/crawler/src/node-transport.ts";
import { SafeFetchError } from "@seo/crawler";

function lookup(addresses: string[], options: LookupOptions) {
  return new Promise<{ address: string | LookupAddress[]; family?: number }>((resolve, reject) => {
    validatedLookup(async () => addresses)("example.com", options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

test("validated lookup supports Node's automatic address-family selection", async () => {
  assert.deepEqual(await lookup(["93.184.216.34"], { all: true }), {
    address: [{ address: "93.184.216.34", family: 4 }],
    family: undefined,
  });
  assert.deepEqual(await lookup(["2606:4700:4700::1111"], {}), {
    address: "2606:4700:4700::1111",
    family: 6,
  });
});

test("connection lookup rejects mixed DNS answers instead of selecting the public one", async () => {
  await assert.rejects(lookup(["93.184.216.34", "127.0.0.1"], { all: true }), (error: unknown) => {
    assert.ok(error instanceof SafeFetchError);
    assert.equal(error.outcome, "SECURITY_BLOCKED");
    return true;
  });
});

test("literal IP targets do not require DNS records", async () => {
  const resolve = createDnsResolver();
  assert.deepEqual(await resolve("93.184.216.34"), ["93.184.216.34"]);
  assert.deepEqual(await resolve("2606:4700:4700::1111"), ["2606:4700:4700::1111"]);
});
