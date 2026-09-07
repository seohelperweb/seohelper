import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { projectDto } from "@/server/api/project-dto.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { getProject, updateProject } from "@/server/services/project-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; projectId: string }> },
) {
  const { workspaceId, projectId } = await params;
  return handleApi(request, async () => {
    const actor = await requireActor(request, workspaceId);
    const project = await getProject(getDb(), actor, projectId);
    const policy = project.currentPolicy;
    return {
      ...projectDto(project, project.verifications[0] ?? null),
      policy: policy
        ? {
            version: policy.version,
            scopeGeneration: policy.scopeGeneration,
            identityVersion: policy.identityVersion,
            extractorVersion: policy.extractorVersion,
            ruleVersion: policy.ruleVersion,
          }
        : null,
    };
  });
}

const patchBody = z.object({
  displayName: z.string().trim().max(100).optional().nullable(),
  archived: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; projectId: string }> },
) {
  const { workspaceId, projectId } = await params;
  return handleApi(request, async (requestId) => {
    const actor = await requireActor(request, workspaceId);
    const input = patchBody.parse(await request.json());
    const project = await updateProject(getDb(), actor, projectId, input, requestId);
    const policy = project.currentPolicy;
    return {
      ...projectDto(project, project.verifications[0] ?? null),
      policy: policy
        ? {
            version: policy.version,
            scopeGeneration: policy.scopeGeneration,
            identityVersion: policy.identityVersion,
            extractorVersion: policy.extractorVersion,
            ruleVersion: policy.ruleVersion,
          }
        : null,
    };
  });
}
