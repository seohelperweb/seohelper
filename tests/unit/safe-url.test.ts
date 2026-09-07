import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeCrawlUrl, classifyIpAddress, UnsafeCrawlUrlError } from "@seo/crawler";

const blocked = (url: string) => assert.throws(() => assertSafeCrawlUrl(url), UnsafeCrawlUrlError);

test("blocks localhost names including trailing-dot and subdomain variants", () => {
  for (const url of [
    "http://localhost",
    "http://localhost./",
    "http://LOCALHOST/",
    "http://app.localhost/",
    "http://app.localhost.:80/",
  ]) {
    blocked(url);
  }
});

test("blocks private, loopback, link-local, and special-use IPv4 literals", () => {
  for (const url of [
    "http://127.0.0.1",
    "http://10.2.3.4",
    "http://172.16.0.2",
    "http://172.31.9.9",
    "http://192.168.1.2",
    "http://169.254.169.254", // cloud metadata
    "http://0.0.0.0",
    "http://100.64.1.1", // carrier-grade NAT
    "http://192.0.2.4", // TEST-NET-1
    "http://198.51.100.7", // TEST-NET-2
    "http://203.0.113.5", // TEST-NET-3
    "http://198.18.0.5", // benchmark 198.18.0.0/15
    "http://198.19.0.5", // benchmark 198.18.0.0/15
    "http://224.0.0.1", // multicast
    "http://240.1.2.3", // reserved
  ]) {
    blocked(url);
  }
});

test("blocks non-decimal IPv4 spellings that the URL parser normalizes", () => {
  for (const url of ["http://0x7f000001", "http://2130706433", "http://0177.0.0.1", "http://127.1"]) {
    assert.equal(new URL(url).hostname, "127.0.0.1", `${url} must normalize to 127.0.0.1`);
    blocked(url);
  }
});

test("blocks non-public IPv6 literals including mapped, NAT64, and 6to4 forms", () => {
  for (const url of [
    "http://[::1]",
    "http://[::]",
    "http://[::ffff:127.0.0.1]", // IPv4-mapped loopback (regression: previously passed)
    "http://[::ffff:169.254.169.254]", // IPv4-mapped metadata (regression: previously passed)
    "http://[::ffff:10.2.3.4]",
    "http://[::10.2.3.4]", // IPv4-compatible
    "http://[fe80::1]", // link-local (regression: previously passed)
    "http://[FC00::1]", // unique local
    "http://[fd12:3456:789a::1]",
    "http://[ff02::1]", // multicast
    "http://[64:ff9b::7f00:1]", // NAT64 wrapping 127.0.0.1
    "http://[2002:7f00:1::]", // 6to4 wrapping 127.0.0.1
    "http://[2001::1]", // Teredo
    "http://[2001:db8::1]", // documentation
  ]) {
    blocked(url);
  }
});

test("allows public targets, including hostnames that merely start with fc or fd", () => {
  // Regression: the old string-prefix check rejected legitimate public domains.
  assert.equal(assertSafeCrawlUrl("https://fcbank.example.com").hostname, "fcbank.example.com");
  assert.equal(assertSafeCrawlUrl("https://fdns.example.com").hostname, "fdns.example.com");
  assert.equal(assertSafeCrawlUrl("https://example.com.").hostname, "example.com."); // legal FQDN form
  assert.equal(assertSafeCrawlUrl("http://8.8.8.8").hostname, "8.8.8.8");
  assert.equal(assertSafeCrawlUrl("https://[2606:4700::6810:85e5]/").hostname, "[2606:4700::6810:85e5]");
  assert.equal(assertSafeCrawlUrl("http://172.32.1.1").hostname, "172.32.1.1"); // outside 172.16/12
  assert.equal(assertSafeCrawlUrl("http://example.com:80/").hostname, "example.com"); // default port is fine
});

test("rejects unsupported protocols, credentials, and non-default ports with distinct codes", () => {
  assert.equal(codeOf("ftp://example.com"), "UNSUPPORTED_PROTOCOL");
  assert.equal(codeOf("http://user:pass@example.com/"), "CREDENTIALS_NOT_ALLOWED");
  assert.equal(codeOf("https://example.com:8443/"), "NON_DEFAULT_PORT");
});

test("classifyIpAddress reports literal classes and null for hostnames", () => {
  assert.equal(classifyIpAddress("8.8.8.8"), "PUBLIC");
  assert.equal(classifyIpAddress("10.0.0.1"), "PRIVATE");
  assert.equal(classifyIpAddress("::ffff:127.0.0.1"), "LOOPBACK");
  assert.equal(classifyIpAddress("64:ff9b::7f00:1"), "LOOPBACK");
  assert.equal(classifyIpAddress("2002:7f00:1::"), "LOOPBACK");
  assert.equal(classifyIpAddress("2606:4700::6810:85e5"), "PUBLIC");
  assert.equal(classifyIpAddress("fd12:3456:789a::1"), "PRIVATE");
  assert.equal(classifyIpAddress("fe80::1"), "LINK_LOCAL");
  assert.equal(classifyIpAddress("example.com"), null);
});

function codeOf(url: string) {
  try {
    assertSafeCrawlUrl(url);
  } catch (error) {
    assert.ok(error instanceof UnsafeCrawlUrlError);
    return error.code;
  }
  assert.fail(`expected ${url} to be rejected`);
}
