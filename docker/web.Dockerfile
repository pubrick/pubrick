FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
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
