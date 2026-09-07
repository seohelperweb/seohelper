import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them.
  transpilePackages: [
    "@seo/contracts",
    "@seo/crawler",
    "@seo/change-detection",
    "@seo/db",
    "@seo/issue-rules",
    "@seo/health-score",
  ],
  // Prisma engines and better-auth must stay external server-side.
  serverExternalPackages: ["@prisma/client", "better-auth"],
};

export default nextConfig;
