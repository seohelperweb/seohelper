/**
 * Cursor pagination helpers for list endpoints (docs/ARCHITECTURE.md §10).
 * Cursors are opaque `base64url(createdAt ISO + "|" + id)` values ordered by
 * (createdAt DESC, id DESC); lists fetch limit+1 rows to detect a next page.
 */

export interface Cursor {
  createdAt: string;
  id: string;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export function encodeCursor(point: { createdAt: Date; id: string }): string {
  return Buffer.from(`${point.createdAt.toISOString()}|${point.id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    if (separator <= 0) return null;
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!id || Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function clampPageSize(requested: number | null | undefined): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(requested), MAX_PAGE_SIZE);
}

/** Prisma `where` fragment for keyset pagination on (createdAt DESC, id DESC). */
export function cursorFilter<T extends string>(cursor: Cursor, idField: T) {
  const createdAt = new Date(cursor.createdAt);
  return {
    OR: [{ createdAt: { lt: createdAt } }, { createdAt, [idField]: { lt: cursor.id } }],
  };
}
