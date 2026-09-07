import test from "node:test";
import assert from "node:assert/strict";
import { EnvConfigError, parseEnv } from "@seo/contracts";

test("applies development defaults when only optional variables are set", () => {
  const config = parseEnv({});
  assert.equal(config.appEnv, "development");
  assert.equal(config.logLevel, "info");
  assert.equal(config.origin, null);
  assert.equal(config.databaseUrl, null);
});

test("accepts a full production configuration", () => {
  const config = parseEnv({
    APP_ENV: "production",
    APP_ORIGIN: "https://indexly.example.com",
    AUTH_SECRET: "a".repeat(32),
    DATABASE_URL: "postgresql://indexly:indexly@localhost:5432/indexly",
    CRAWLER_USER_AGENT: "IndexlyBot/0.1 (+https://indexly.example.com/bot)",
    LOG_LEVEL: "warn",
  });
  assert.equal(config.appEnv, "production");
  assert.equal(config.logLevel, "warn");
  assert.equal(config.crawlerUserAgent, "IndexlyBot/0.1 (+https://indexly.example.com/bot)");
});

test("fails with a clear message when production variables are missing", () => {
  assert.throws(
    () => parseEnv({ APP_ENV: "production" }),
    (error: unknown) => {
      assert.ok(error instanceof EnvConfigError);
      assert.match(error.message, /APP_ORIGIN, AUTH_SECRET, DATABASE_URL, CRAWLER_USER_AGENT/);
      return true;
    },
  );
});

test("rejects malformed values regardless of environment", () => {
  assert.throws(() => parseEnv({ APP_ORIGIN: "not-a-url" }), EnvConfigError);
  assert.throws(() => parseEnv({ AUTH_SECRET: "short" }), EnvConfigError);
  assert.throws(() => parseEnv({ LOG_LEVEL: "verbose" }), EnvConfigError);
});
