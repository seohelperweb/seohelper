import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getDb } from "@seo/db";
import { getConfigSafe } from "../config.ts";
import { sendEmail } from "../emails.ts";

/**
 * Better Auth instance (docs/ARCHITECTURE.md §2): database sessions, email
 * verification required before sign-in, invitation-only membership handled by
 * the business layer (this instance owns identity only).
 */
export const auth = betterAuth({
  // Wire the app env contract (AUTH_SECRET, required in production by
  // packages/contracts/src/env.ts) into Better Auth; in dev without AUTH_SECRET
  // it falls back to Better Auth's own default with its warning.
  secret: getConfigSafe()?.authSecret ?? undefined,
  database: prismaAdapter(getDb(), { provider: "postgresql" }),
  baseURL: getConfigSafe()?.origin ?? undefined,
  trustedOrigins: getConfigSafe()?.origin ? [getConfigSafe()!.origin as string] : [],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
  },
  emailVerification: {
    sendOnSignUp: true,
    async sendVerificationEmail({ user, url }) {
      await sendEmail({
        to: user.email,
        subject: "Verify your Indexly email",
        text: `Open this link to verify your email:\n${url}`,
      });
    },
  },
  user: {
    changeEmail: {
      enabled: true,
      async sendChangeEmailVerification({ user, url }: { user: { email: string }; url: string }) {
        await sendEmail({ to: user.email, subject: "Confirm your new Indexly email", text: url });
      },
    },
  },
});
