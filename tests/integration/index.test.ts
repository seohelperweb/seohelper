/**
 * Integration test entry. Requires a running PostgreSQL (npm run db:up) with
 * migrations applied — `npm run test:integration` handles both.
 */
import { createDb } from "@seo/db";

const db = createDb();
try {
  await db.$queryRaw`SELECT 1`;
  await db.$disconnect();
} catch (error) {
  console.error("Database unreachable — start it with `npm run db:up` and retry (npm run test:integration).");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

import "./isolation.suite.ts";
import "./members.suite.ts";
import "./invitations.suite.ts";
import "./verification.suite.ts";
import "./crawls.suite.ts";
import "./reports.suite.ts";
import "./ops.suite.ts";
import "./protocol-fallback.suite.ts";
