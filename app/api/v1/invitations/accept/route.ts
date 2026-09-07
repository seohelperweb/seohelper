import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@seo/db";
import { handleApi } from "@/server/api/handle.ts";
import { getSessionUser } from "@/server/auth/actor.ts";
import { acceptInvitation } from "@/server/services/member-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const acceptBody = z.object({ token: z.string().min(10) });

export async function POST(request: NextRequest) {
  return handleApi(request, async (requestId) => {
    const session = await getSessionUser(request);
    const input = acceptBody.parse(await request.json());
    return acceptInvitation(getDb(), session, input.token, requestId);
  });
}
