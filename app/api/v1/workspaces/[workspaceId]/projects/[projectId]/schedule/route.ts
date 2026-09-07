import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { getSchedule, updateSchedule } from "@/server/schedule/schedule-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; projectId: string }> },
) {
  const { workspaceId, projectId } = await params;
  return handleApi(request, async () => {
    const actor = await requireActor(request, workspaceId);
    return getSchedule(getDb(), actor, projectId);
  });
}

const putBody = z.object({
  enabled: z.boolean(),
  displayTimezone: z.string().trim().min(1).max(64).optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; projectId: string }> },
) {
  const { workspaceId, projectId } = await params;
  return handleApi(request, async (requestId) => {
    const actor = await requireActor(request, workspaceId);
    const input = putBody.parse(await request.json());
    return updateSchedule(getDb(), actor, projectId, input, requestId);
  });
}
