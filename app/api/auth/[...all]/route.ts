import { auth } from "@/server/auth/auth";
import { ApiError } from "@/server/api/errors";
import { toErrorBody } from "@/server/api/errors";
import { authRateLimitExceeded, authRateLimitWindowMs } from "@/server/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Better Auth owns /api/auth/* with its own contract (docs/ARCHITECTURE.md §10);
 * we add a per-IP sliding-window limit on credential endpoints before
 * delegating to the auth handler.
 */
async function handle(request: Request) {
  const url = new URL(request.url);
  if (request.method === "POST" && authRateLimitExceeded(url.pathname, request)) {
    const { status, body } = toErrorBody(
      ApiError.tooManyRequests("Too many attempts — slow down", { retryAfterMs: authRateLimitWindowMs(url.pathname) }),
    );
    return Response.json(
      { ...body, requestId: "rate-limited" },
      { status, headers: { "retry-after": String(Math.ceil((authRateLimitWindowMs(url.pathname) ?? 60_000) / 1000)) } },
    );
  }
  return auth.handler(request);
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
