FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @pubrick/worker deploy --prod --legacy /out

FROM node:22-slim
# Runtime stage only — setting this in a build stage would make
# `pnpm install --frozen-lockfile` skip the devDependencies the build needs.
# Libraries branch on it: better-auth turns its rate limiter on, keeps the
# generic error page, and prefixes cookies `__Secure-`. The auth config no
# longer *depends* on it (see apps/api/src/auth.ts), but the shipped image
# must not be the odd one out that says "development".
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
COPY --from=build /repo/apps/worker/dist ./dist
CMD ["node", "dist/main.cjs"]
