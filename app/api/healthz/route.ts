export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness probe: the process is up. */
export async function GET() {
  return Response.json({ ok: true });
}
