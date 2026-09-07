import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { ApiError } from "@/server/api/errors.ts";
import { requireActor } from "@/server/auth/actor.ts";
import { updateIssueSuppression } from "@/server/services/issue-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchBody = z.object({
  suppressedUntil: z.iso.datetime().nullable().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; projectId: string; issueId: string }> },
) {
  const { workspaceId, projectId, issueId } = await params;
  return handleApi(request, async (requestId) => {
    const actor = await requireActor(request, workspaceId);
    const raw = patchBody.parse(await request.json().catch(() => ({})));
    if (raw.suppressedUntil === undefined) {
      throw ApiError.badRequest("Nothing to update: pass suppressedUntil (ISO datetime or null)");
    }
    return updateIssueSuppression(
      getDb(),
      actor,
      projectId,
      issueId,
      { suppressedUntil: raw.suppressedUntil === null ? null : new Date(raw.suppressedUntil) },
      requestId,
    );
  });
}
