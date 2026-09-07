import { getConfigSafe } from "./config.ts";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Outbound email adapter. P1 ships a console transport for development
 * (verification links appear in the server log); a real provider must be
 * configured before opening registration in production
 * (docs/ARCHITECTURE.md §4, §12).
 */
export async function sendEmail(email: OutgoingEmail): Promise<void> {
  const config = getConfigSafe();
  if (config?.appEnv === "production") {
    // No provider configured yet — surface loudly instead of silently dropping.
    console.error(`[email] PRODUCTION provider missing; dropping mail to ${email.to} (${email.subject})`);
    return;
  }
  console.log(`[email:dev] ┌──────────────────────────────────────────────`);
  console.log(`[email:dev] │ to: ${email.to}`);
  console.log(`[email:dev] │ subject: ${email.subject}`);
  for (const line of email.text.split("\n")) console.log(`[email:dev] │ ${line}`);
  console.log(`[email:dev] └──────────────────────────────────────────────`);
}
