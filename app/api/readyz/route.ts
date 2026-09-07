import { getDb } from "@seo/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Readiness probe: the process is up AND the database answers. */
export async function GET() {
  try {
    await getDb().$queryRaw`SELECT 1`;
    return Response.json({ ok: true, database: "up" });
  } catch {
    return Response.json({ ok: false, database: "down" }, { status: 503 });
  }
}
