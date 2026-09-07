import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { pageParams } from "@/server/api/page-params.ts";
import { projectDto } from "@/server/api/project-dto.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { createProject, listProjects } from "@/server/services/project-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createBody = z.object({
  hostname: z.string().trim().min(3).max(253),
  displayName: z.string().trim().max(100).optional().nullable(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return handleApi(request, async () => {
    const actor = await requireActor(request, workspaceId);
    const page = await listProjects(getDb(), actor, pageParams(request.url));
    return {
      items: page.items.map((p) => projectDto(p, p.verifications[0] ?? null)),
      nextCursor: page.nextCursor,
    };
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return handleApi(request, async (requestId) => {
    const actor = await requireActor(request, workspaceId);
    const input = createBody.parse(await request.json());
    const project = await createProject(getDb(), actor, input, requestId);
    return projectDto(
      {
        id: project.id,
        hostname: project.hostname,
        displayName: project.displayName,
        verificationStatus: project.verificationStatus,
        archivedAt: project.archivedAt,
        createdAt: project.createdAt,
      },
      null,
    );
  });
}
