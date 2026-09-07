import type { NextRequest } from "next/server";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { requestVerification } from "@/server/services/project-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Queue a DNS TXT verification job. Returns 202 with the challenge record to publish. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; projectId: string }> },
) {
  const { workspaceId, projectId } = await params;
  return handleApi(request, async (requestId) => {
    const actor = await requireActor(request, workspaceId);
    const result = await requestVerification(getDb(), actor, projectId, requestId);
    return Response.json({ data: result, requestId }, { status: 202 });
  });
}
