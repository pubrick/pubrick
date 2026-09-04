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
ARG API_INTERNAL_URL=http://api:3001
ENV API_INTERNAL_URL=$API_INTERNAL_URL
RUN pnpm --filter @pubrick/web... build

FROM node:22-slim
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
# Next's standalone output traces only what the server needs to run; `public/`
# (manifest, icons, favicon.svg's non-route assets) is served as static files
# and is never traced in, so it has to be copied by hand — same reason
# .next/static above needs its own line. Missing this 404s the manifest and
# every icon on every page load (favicon.ico and other app-router-convention
# files under src/app/ are routes, not public/, and are already in .next/standalone).
COPY --from=build /repo/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
