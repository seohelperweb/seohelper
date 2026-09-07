import type { NextRequest } from "next/server";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { crawlDto, getCrawl } from "@/server/services/crawl-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; projectId: string; crawlId: string }> },
) {
  const { workspaceId, projectId, crawlId } = await params;
  return handleApi(request, async () => {
    const actor = await requireActor(request, workspaceId);
    const run = await getCrawl(getDb(), actor, projectId, crawlId);
    return crawlDto(run);
  });
}
