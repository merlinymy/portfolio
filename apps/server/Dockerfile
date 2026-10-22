# The chat api (apps/server) as a container image. Build it from the repo root, which is what
# docker-compose.yml does:
#
#   docker compose --profile api up -d --build
#
# /app is laid out like the repo, because the api finds the repo root as three folders up from
# apps/server/src/env.ts, and looks for content/, knowledge/ and .env under it. docker-compose.yml
# mounts content/ and knowledge/ there; they're never baked into the image, and neither is .env
# (the settings arrive as environment variables) or node_modules (.dockerignore lists what's copied).
#
# Debian 13 ("trixie"), as the Postgres image is. Node 24 runs the TypeScript files as they are.
FROM node:24.21.0-trixie-slim

WORKDIR /app

# The dependencies come first so that changing the code doesn't reinstall them. Only the api's and
# the shared package's manifests are copied, and `--workspace` installs just what the api needs,
# not the site's (Astro, three.js) or the root's dev tools (Playwright, Wrangler). The lockfile
# fixes every version. Install scripts are off: none of these packages needs one.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace @portfolio/server --ignore-scripts

COPY apps/server/src apps/server/src
COPY packages/shared/src packages/shared/src

# Not root: the code only reads /app, and writes only to the mounted knowledge/cache and
# knowledge/outbox.
USER node
WORKDIR /app/apps/server
EXPOSE 8791
CMD ["node", "src/main.ts"]
