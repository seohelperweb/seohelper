# Web + Worker share one image; compose selects the command.
FROM node:24-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/crawler/package.json packages/crawler/
COPY packages/change-detection/package.json packages/change-detection/
COPY packages/issue-rules/package.json packages/issue-rules/
COPY packages/db/package.json packages/db/
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate --schema packages/db/prisma/schema.prisma && npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY packages ./packages
COPY app ./app
COPY server ./server
COPY scripts ./scripts
COPY package.json next.config.ts ./
EXPOSE 3000
CMD ["npm", "run", "start"]
