import { ERROR_CODES } from "@seo/contracts";
import type { ErrorCode } from "@seo/contracts";

/** Thrown by services/routes; converted to the API error envelope by handleApi. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static unauthenticated(message = "Sign in required"): ApiError {
    return new ApiError(401, ERROR_CODES.UNAUTHENTICATED, message);
  }
  static forbidden(message = "You do not have permission to do this"): ApiError {
    return new ApiError(403, ERROR_CODES.FORBIDDEN, message);
  }
  static notFound(message = "Resource not found"): ApiError {
    return new ApiError(404, ERROR_CODES.NOT_FOUND, message);
  }
  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, ERROR_CODES.VALIDATION_FAILED, message, details);
  }
  static conflict(message: string, code: ErrorCode = ERROR_CODES.CONFLICT): ApiError {
    return new ApiError(409, code, message);
  }
  static tooManyRequests(message: string, details?: unknown): ApiError {
    return new ApiError(429, ERROR_CODES.RATE_LIMITED, message, details);
  }
}

interface PrismaLikeError {
  code?: string;
  message?: string;
}

function mapPrismaError(error: PrismaLikeError): ApiError | null {
  if (error.code === "P2002") return ApiError.conflict("A record with these values already exists");
  if (error.code === "P2025") return ApiError.notFound();
  return null;
}

function mapZodError(error: { issues?: Array<{ path: Array<string | number>; message: string }> }): ApiError | null {
  if (!Array.isArray(error.issues)) return null;
  const details = error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  return ApiError.badRequest("Request validation failed", details);
}

/**
 * Convert any thrown value into the API error envelope body. Unknown errors
 * become a generic 500 without leaking internals (docs/ARCHITECTURE.md §10).
 */
export function toErrorBody(error: unknown): {
  status: number;
  body: { error: { code: ErrorCode; message: string; details?: unknown } };
} {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
    };
  }
  const mapped = mapPrismaError((error ?? {}) as PrismaLikeError) ?? mapZodError((error ?? {}) as never);
  if (mapped) {
    return {
      status: mapped.status,
      body: {
        error: {
          code: mapped.code,
          message: mapped.message,
          ...(mapped.details !== undefined ? { details: mapped.details } : {}),
        },
      },
    };
  }
  return { status: 500, body: { error: { code: ERROR_CODES.INTERNAL_ERROR, message: "Unexpected server error" } } };
}
