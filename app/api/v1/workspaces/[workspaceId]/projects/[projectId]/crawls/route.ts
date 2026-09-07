import type { NextRequest } from "next/server";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { pageParams } from "@/server/api/page-params.ts";
import { ApiError } from "@/server/api/errors.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { crawlDto, createCrawl, listCrawls } from "@/server/services/crawl-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; projectId: string }> },
) {
  const { workspaceId, projectId } = await params;
  return handleApi(request, async () => {
    const actor = await requireActor(request, workspaceId);
    const page = await listCrawls(getDb(), actor, projectId, pageParams(request.url));
    return { items: page.items, nextCursor: page.nextCursor };
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; projectId: string }> },
) {
  const { workspaceId, projectId } = await params;
  return handleApi(request, async (requestId) => {
    const actor = await requireActor(request, workspaceId);
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) throw ApiError.badRequest("Idempotency-Key header is required");
    const result = await createCrawl(getDb(), actor, projectId, idempotencyKey, requestId);
    const run = await getDb().crawlRun.findUniqueOrThrow({ where: { id: result.crawlId } });
    return Response.json(
      {
        data: {
          crawl: crawlDto(run),
          replay: result.replay,
          statusUrl: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/crawls/${result.crawlId}`,
        },
        requestId,
      },
      { status: result.replay ? 200 : 202 },
    );
  });
}
