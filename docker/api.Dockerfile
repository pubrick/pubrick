FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @pubrick/api deploy --prod --legacy /out

FROM node:22-slim
WORKDIR /app
COPY --from=build /out .
COPY --from=build /repo/apps/api/dist ./dist
EXPOSE 3001
CMD ["node", "dist/main.js"]
