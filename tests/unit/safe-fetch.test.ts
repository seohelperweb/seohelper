import test from "node:test";
import assert from "node:assert/strict";
import { safeFetch } from "@seo/crawler";
import type { DnsResolver, Transport } from "@seo/crawler";

const HOST = "example.com";
const goodDns: DnsResolver = async () => ["93.184.216.34"];
const resolverWith =
  (extra: string[]): DnsResolver =>
  async () => ["93.184.216.34", ...extra];

function transportOf(
  hops: Record<string, { status: number; location?: string; body?: string; headers?: Record<string, string> }>,
): Transport {
  const bodies = new Map<string, string>();
  return async (request) => {
    const key = request.url.toString();
    const hop = hops[key];
    if (!hop) throw new Error(`no route for ${key}`);
    return {
      status: hop.status,
      headers: { ...(hop.location ? { location: hop.location } : {}), ...(hop.headers ?? {}) },
      body: (async function* () {
        const text = hop.body ?? "";
        yield new TextEncoder().encode(text);
        bodies.set(key, text);
      })(),
    };
  };
}

const base = { allowedHostname: HOST, userAgent: "IndexlyBot" } as const;

test("follows same-scope redirects and returns the final response", async () => {
  const transport = transportOf({
    "https://example.com/a": { status: 301, location: "https://example.com/b" },
    "https://example.com/b": { status: 200, body: "<html></html>", headers: { "content-type": "text/html" } },
  });
  const result = await safeFetch("https://example.com/a", { ...base, resolveDns: goodDns, transport });
  assert.equal(result.outcome, "HTTP_RESPONSE");
  assert.equal(result.initialStatus, 301);
  assert.equal(result.finalStatus, 200);
  assert.equal(result.finalUrl, "https://example.com/b");
  assert.deepEqual(result.redirectChain, [
    { url: "https://example.com/a", status: 301, location: "https://example.com/b" },
  ]);
  assert.equal(new TextDecoder().decode(result.body ?? new Uint8Array()), "<html></html>");
});

test("redirect target out of scope is recorded and not followed", async () => {
  const transport = transportOf({ "https://example.com/a": { status: 301, location: "https://other.example.net/b" } });
  const result = await safeFetch("https://example.com/a", { ...base, resolveDns: goodDns, transport });
  assert.equal(result.outcome, "REDIRECT_BLOCKED");
  assert.equal(result.redirectChain.length, 1);
  assert.equal(result.finalUrl, null);
});

test("per-hop DNS re-validation catches rebinding after a same-host redirect", async () => {
  let lookups = 0;
  const rebinding: DnsResolver = async () => {
    lookups += 1;
    return lookups === 1 ? ["93.184.216.34"] : ["10.0.0.5"];
  };
  const transport = transportOf({
    "https://example.com/a": { status: 302, location: "https://example.com/b" },
    "https://example.com/b": { status: 200 },
  });
  const result = await safeFetch("https://example.com/a", { ...base, resolveDns: rebinding, transport });
  assert.equal(result.outcome, "SECURITY_BLOCKED");
  assert.equal(lookups, 2);
});

test("mixed DNS answers containing any private address reject the request", async () => {
  for (const poisoned of ["127.0.0.1", "10.1.2.3", "fd12::1", "::ffff:169.254.169.254"]) {
    const transport = transportOf({ "https://example.com/": { status: 200 } });
    const result = await safeFetch("https://example.com/", {
      ...base,
      resolveDns: resolverWith([poisoned]),
      transport,
    });
    assert.equal(result.outcome, "SECURITY_BLOCKED", poisoned);
  }
});

test("empty DNS answer is a network error", async () => {
  const empty: DnsResolver = async () => [];
  const transport = transportOf({ "https://example.com/": { status: 200 } });
  const result = await safeFetch("https://example.com/", { ...base, resolveDns: empty, transport });
  assert.equal(result.outcome, "NETWORK_ERROR");
});

test("body beyond the cap aborts with BODY_TOO_LARGE", async () => {
  const transport: Transport = async () => ({
    status: 200,
    headers: {},
    body: (async function* () {
      yield new Uint8Array(64 * 1024);
      yield new Uint8Array(64 * 1024);
    })(),
  });
  const result = await safeFetch("https://example.com/", {
    ...base,
    resolveDns: goodDns,
    transport,
    limits: { maxBodyBytes: 1024 },
  });
  assert.equal(result.outcome, "BODY_TOO_LARGE");
  assert.equal(result.body, null);
});

test("redirect chains over the limit end as REDIRECT_LIMIT", async () => {
  const hops: Record<string, { status: number; location: string }> = {};
  for (let i = 1; i < 10; i += 1) {
    hops[`https://example.com/r${i}`] = { status: 301, location: `https://example.com/r${i + 1}` };
  }
  const result = await safeFetch("https://example.com/r1", {
    ...base,
    resolveDns: goodDns,
    transport: transportOf(hops),
  });
  assert.equal(result.outcome, "REDIRECT_LIMIT");
  assert.equal(result.redirectChain.length, 6); // 5 followed hops + the blocked 6th recorded
});

test("out-of-scope initial target is SCOPE_BLOCKED without any network use", async () => {
  let usedTransport = false;
  const transport: Transport = async () => {
    usedTransport = true;
    throw new Error("must not be called");
  };
  const result = await safeFetch("https://other.example.net/", { ...base, resolveDns: goodDns, transport });
  assert.equal(result.outcome, "SCOPE_BLOCKED");
  assert.equal(usedTransport, false);
});
