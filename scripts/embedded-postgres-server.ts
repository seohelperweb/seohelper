/**
 * Disposable local PostgreSQL for development and integration tests on
 * machines without a Docker daemon. Starts an embedded Postgres 17 binary on
 * a fixed local port with fixed credentials, stays up until interrupted, and
 * wipes its data directory on shutdown.
 *
 * Usage: npm run db:up
 *
 * Connection string (put it in .env as DATABASE_URL):
 *   postgresql://indexly:indexly@127.0.0.1:5433/indexly
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const PORT = 5433;
const URL_STYLE = "postgresql://indexly:indexly@127.0.0.1:5433/indexly";

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), "indexly-pg-"));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "indexly",
    password: "indexly",
    port: PORT,
    persistent: false,
  });

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    console.log("\n[embedded-postgres] stopping…");
    try {
      await pg.stop();
    } catch {
      /* already stopped */
    }
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase("indexly");
  } catch (error) {
    // "already exists" is fine on restarts against a persistent directory.
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already exists")) throw error;
  }

  console.log(`[embedded-postgres] ready: ${URL_STYLE}`);
  console.log("[embedded-postgres] press Ctrl+C to stop (data is wiped)");
  await new Promise(() => {});
}

main().catch((error) => {
  console.error("[embedded-postgres] failed:", error);
  process.exit(1);
});
