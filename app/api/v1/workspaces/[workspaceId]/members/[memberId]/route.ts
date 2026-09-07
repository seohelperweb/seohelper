import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { readJson } from "@/server/api/read-json.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { WORKSPACE_ROLES } from "@/server/auth/permissions.ts";
import { changeMemberRole, removeMember } from "@/server/services/member-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchBody = z.object({ role: z.enum(WORKSPACE_ROLES) });

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; memberId: string }> },
) {
  const { workspaceId, memberId } = await params;
  return handleApi(request, async (requestId) => {
    const actor = await requireActor(request, workspaceId);
    const input = patchBody.parse(await readJson(request));
    return changeMemberRole(getDb(), actor, memberId, input.role, requestId);
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; memberId: string }> },
) {
  const { workspaceId, memberId } = await params;
  return handleApi(request, async (requestId) => {
    const actor = await requireActor(request, workspaceId);
    await removeMember(getDb(), actor, memberId, requestId);
    return { ok: true };
  });
}
