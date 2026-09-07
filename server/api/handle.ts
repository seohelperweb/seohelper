import { randomUUID } from "node:crypto";
import { toErrorBody } from "./errors.ts";
import { assertSameOrigin } from "./csrf.ts";

/**
 * Wrap a route handler with the shared success/error envelope
 * `{ data, requestId }` / `{ error: { code, message }, requestId }`
 * (docs/ARCHITECTURE.md §10). State-changing methods are additionally
 * Origin-checked for browser CSRF.
 */
export async function handleApi(request: Request, fn: (requestId: string) => Promise<unknown>): Promise<Response> {
  const requestId = randomUUID();
  try {
    assertSameOrigin(request);
    const data = await fn(requestId);
    if (data instanceof Response) return data;
    return Response.json({ data, requestId });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    if (status >= 500) {
      console.error(`[api] ${requestId}`, error);
    }
    return Response.json({ ...body, requestId }, { status });
  }
}
