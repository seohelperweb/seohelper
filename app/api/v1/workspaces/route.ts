import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { getSessionUser } from "@/server/auth/actor.ts";
import { createWorkspace, listWorkspacesForUser } from "@/server/services/workspace-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handleApi(request, async () => {
    const session = await getSessionUser(request);
    return { items: await listWorkspacesForUser(getDb(), session.id) };
  });
}

const createBody = z.object({ name: z.string().trim().min(1).max(100) });

export async function POST(request: NextRequest) {
  return handleApi(request, async (requestId) => {
    const session = await getSessionUser(request);
    const input = createBody.parse(await request.json());
    const workspace = await createWorkspace(getDb(), { userId: session.id }, input, requestId);
    return { id: workspace.id, name: workspace.name, role: "OWNER", createdAt: workspace.createdAt };
  });
}
