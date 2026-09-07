import type { NextRequest } from "next/server";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { pageParams } from "@/server/api/page-params.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { listMembers } from "@/server/services/member-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return handleApi(request, async () => {
    const actor = await requireActor(request, workspaceId);
    const page = await listMembers(getDb(), actor, pageParams(request.url));
    return {
      items: page.items.map((m) => ({
        id: m.id,
        role: m.role,
        createdAt: m.createdAt,
        user: m.user,
      })),
      nextCursor: page.nextCursor,
    };
  });
}
