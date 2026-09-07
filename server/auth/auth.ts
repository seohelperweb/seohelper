import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getDb } from "@seo/db";
import { getConfig } from "../config.ts";
import { sendEmail } from "../emails.ts";

/**
 * Better Auth instance (docs/ARCHITECTURE.md §2): database sessions, email
 * verification required before sign-in, invitation-only membership handled by
 * the business layer (this instance owns identity only).
 */
function createAuth() {
  const config = getConfig();
  return betterAuth({
    // Wire the app env contract (AUTH_SECRET, required in production by
    // packages/contracts/src/env.ts) into Better Auth; in dev without AUTH_SECRET
    // it falls back to Better Auth's own default with its warning.
    secret: config.authSecret ?? undefined,
    database: prismaAdapter(getDb(), { provider: "postgresql" }),
    baseURL: config.origin ?? undefined,
    trustedOrigins: config.origin ? [config.origin] : [],
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
}

// Next.js evaluates route modules during builds before deployment secrets are
// available. Validate runtime configuration when auth is first used instead.
let instance: ReturnType<typeof createAuth> | undefined;
export const auth = new Proxy({} as ReturnType<typeof createAuth>, {
  get(_target, property) {
    instance ??= createAuth();
    const value = Reflect.get(instance, property);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
