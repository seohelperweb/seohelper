import type { NextRequest } from "next/server";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { pageParams } from "@/server/api/page-params.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { listIssues } from "@/server/services/report-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; projectId: string }> },
) {
  const { workspaceId, projectId } = await params;
  return handleApi(request, async () => {
    const actor = await requireActor(request, workspaceId);
    const url = new URL(request.url);
    return listIssues(
      getDb(),
      actor,
      projectId,
      { state: url.searchParams.get("state") ?? undefined },
      pageParams(url),
    );
  });
}
