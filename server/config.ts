import { parseEnv } from "@seo/contracts";
import type { AppConfig } from "@seo/contracts";

let cached: AppConfig | null = null;

/** Validate and cache the runtime environment (docs/ARCHITECTURE.md §12). Throws EnvConfigError. */
export function getConfig(): AppConfig {
  if (!cached) {
    cached = parseEnv(process.env);
  }
  return cached;
}

/** Non-throwing variant for build-time module evaluation where env is absent. */
export function getConfigSafe(): AppConfig | null {
  try {
    return getConfig();
  } catch {
    return null;
  }
}
