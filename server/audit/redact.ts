/**
 * Audit detail redaction (docs/ARCHITECTURE.md §5): append-only records must
 * never contain credentials, invitation tokens, cookies, or mail tokens.
 * Only small primitive values on an allowlist of shapes survive.
 */

const SENSITIVE_KEY_PATTERN = /token|secret|password|cookie|authorization|credential/i;
const MAX_VALUE_LENGTH = 200;
const MAX_ENTRIES = 20;

export type AuditDetails = Record<string, string | number | boolean | null>;

export function redactAuditDetails(input: Record<string, unknown>): AuditDetails {
  const output: AuditDetails = {};
  for (const [key, value] of Object.entries(input).slice(0, MAX_ENTRIES)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
      continue;
    }
    if (typeof value === "string") {
      output[key] = value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
    }
    // Objects and arrays are dropped — write explicit keys instead.
  }
  return output;
}
