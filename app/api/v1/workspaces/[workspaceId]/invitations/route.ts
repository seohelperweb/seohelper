import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { readJson } from "@/server/api/read-json.ts";
import { pageParams } from "@/server/api/page-params.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { WORKSPACE_ROLES } from "@/server/auth/permissions.ts";
import { inviteMember, listInvitations } from "@/server/services/member-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createBody = z.object({
  email: z.email(),
  role: z.enum(WORKSPACE_ROLES),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return handleApi(request, async () => {
    const actor = await requireActor(request, workspaceId);
    const page = await listInvitations(getDb(), actor, pageParams(request.url));
    return {
      items: page.items.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
        consumedAt: i.consumedAt,
        revokedAt: i.revokedAt,
        createdAt: i.createdAt,
      })),
      nextCursor: page.nextCursor,
    };
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return handleApi(request, async (requestId) => {
    const actor = await requireActor(request, workspaceId);
    const input = createBody.parse(await readJson(request));
    const result = await inviteMember(getDb(), actor, input, requestId);
    return {
      invitationId: result.invitationId,
      token: result.token,
      expiresAt: result.expiresAt,
      email: input.email,
      role: input.role,
    };
  });
}
