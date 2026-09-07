import type { NextRequest } from "next/server";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { cancelCrawl } from "@/server/services/crawl-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; projectId: string; crawlId: string }> },
) {
  const { workspaceId, projectId, crawlId } = await params;
  return handleApi(request, async (requestId) => {
    const actor = await requireActor(request, workspaceId);
    const result = await cancelCrawl(getDb(), actor, projectId, crawlId, requestId);
    return Response.json(
      { data: { crawlId: result.crawlId, status: result.status, alreadyFinished: result.alreadyFinished }, requestId },
      { status: 202 },
    );
  });
}
