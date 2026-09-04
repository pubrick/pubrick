FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

# Copy only the workspace manifests first, so `pnpm install` — the layer
# that actually costs time — is invalidated by a dependency change, not by
# every source edit. Adding a workspace package needs its own COPY line
# here or it silently installs against a stale manifest set.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
# node_modules from the deps stage above is not in the build context (see
# .dockerignore), so this COPY layers source on top without touching it.
COPY . .
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
