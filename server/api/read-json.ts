import { ApiError } from "./errors.ts";

/** Malformed request bodies are client errors, separate from service failures. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw ApiError.badRequest("Request body must contain valid JSON");
    throw error;
  }
}
