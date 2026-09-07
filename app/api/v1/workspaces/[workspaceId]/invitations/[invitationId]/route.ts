import type { NextRequest } from "next/server";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { revokeInvitation } from "@/server/services/member-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; invitationId: string }> },
) {
  const { workspaceId, invitationId } = await params;
  return handleApi(request, async (requestId) => {
    const actor = await requireActor(request, workspaceId);
    await revokeInvitation(getDb(), actor, invitationId, requestId);
    return { ok: true };
  });
}
