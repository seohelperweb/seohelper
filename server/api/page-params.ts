import { ApiError } from "./errors.ts";
import { clampPageSize, cursorFilter, decodeCursor } from "./cursor.ts";

/** Shared query parsing for cursor-paginated list routes. */
export function pageParams(input: string | URL): { where?: object; take: number } {
  const url = typeof input === "string" ? new URL(input) : input;
  const take = clampPageSize(Number(url.searchParams.get("limit")));
  const rawCursor = url.searchParams.get("cursor");
  if (!rawCursor) return { take };
  const cursor = decodeCursor(rawCursor);
  if (!cursor) throw ApiError.badRequest("Invalid cursor");
  return { where: cursorFilter(cursor, "id"), take };
}
