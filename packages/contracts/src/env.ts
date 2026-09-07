import { z } from "zod";

/**
 * Runtime environment schema (docs/ARCHITECTURE.md §12).
 *
 * Validated once at process startup by `parseEnv`. Keys marked
 * production-required are optional in development so a fresh checkout can run
 * the web app and tests without external services.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const APP_ENVS = ["development", "test", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const PRODUCTION_REQUIRED = ["APP_ORIGIN", "AUTH_SECRET", "DATABASE_URL", "CRAWLER_USER_AGENT"] as const;

export const envSchema = z.object({
  NODE_ENV: z.enum(APP_ENVS).optional(),
  APP_ENV: z.enum(APP_ENVS).optional(),
  APP_ORIGIN: z.url({ error: "APP_ORIGIN must be an absolute URL" }).optional(),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters").optional(),
  DATABASE_URL: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  CRAWLER_USER_AGENT: z.string().min(1).optional(),
});

export type EnvInput = z.input<typeof envSchema>;

export interface AppConfig {
  appEnv: AppEnv;
  origin: string | null;
  authSecret: string | null;
  databaseUrl: string | null;
  logLevel: LogLevel;
  crawlerUserAgent: string | null;
}

export class EnvConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[], message?: string) {
    super(message ?? `Invalid environment configuration:\n- ${issues.join("\n- ")}`);
    this.issues = issues;
    this.name = "EnvConfigError";
  }
}

export function parseEnv(source: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`));
  }

  const env = parsed.data;
  const appEnv = env.APP_ENV ?? env.NODE_ENV ?? "development";
  const missing = PRODUCTION_REQUIRED.filter((key) => !env[key]);
  if (appEnv === "production" && missing.length > 0) {
    throw new EnvConfigError([`Missing required environment variables in production: ${missing.join(", ")}`]);
  }

  return {
    appEnv,
    origin: env.APP_ORIGIN ?? null,
    authSecret: env.AUTH_SECRET ?? null,
    databaseUrl: env.DATABASE_URL ?? null,
    logLevel: env.LOG_LEVEL,
    crawlerUserAgent: env.CRAWLER_USER_AGENT ?? null,
  };
}
