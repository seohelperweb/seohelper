import type { NextRequest } from "next/server";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { pageParams } from "@/server/api/page-params.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { can } from "@/server/auth/permissions.ts";
import { ApiError } from "@/server/api/errors.ts";
import { listForWorkspace } from "@/server/repositories/audit.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return handleApi(request, async () => {
    const actor = await requireActor(request, workspaceId);
    if (!can(actor.role, "manage-members")) throw ApiError.forbidden("Audit logs are visible to owners and admins");
    const page = await listForWorkspace(getDb(), actor.workspaceId, pageParams(request.url));
    return { items: page.items, nextCursor: page.nextCursor };
  });
}
