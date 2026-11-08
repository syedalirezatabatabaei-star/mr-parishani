# Production image for a Node service in this monorepo. Build from the repository root, the
# target naming the service:
#   docker build --build-arg APP=api --target api -t sepehr-api .
#   docker build --build-arg APP=worker --target worker -t sepehr-worker .
# The web and admin apps have their own file, Dockerfile.next.

# Both stages use the same base image, pinned by digest. Update them together.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
# Fail a RUN step when any command in a pipe fails, not only the last one.
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]
ARG APP
RUN test -n "$APP" || (echo 'Pass --build-arg APP=api or APP=worker' >&2 && exit 1)
RUN corepack enable
WORKDIR /repo

# Fetch dependencies from the lockfile alone so this layer is reused until it changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm turbo run build --filter="@sepehr/${APP}..."
# Production dependencies and build output only.
RUN pnpm --filter "@sepehr/${APP}" deploy --prod /out

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS service
ENV NODE_ENV=production
# Task 9-3 (R16): the services run `node dist/main.js` only. npm, npx, corepack and yarn ship in
# the base image with their own dependencies (trivy's high findings, task 9-2): removed. OS
# packages come with the base image's digest (no package mirror is reached at build time).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn*       /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build --chown=node:node /out ./
CMD ["node", "dist/main.js"]

FROM service AS api
# main.ts listens on 127.0.0.1 unless HOST is set; in the container that would be unreachable.
ENV HOST=0.0.0.0
USER node

# The worker prints contracts, statements and reports as PDF with headless Chromium (ADR-033),
# so only its image has the browser: one exact version from Alpine's repository (in production
# the internal apk mirror, task 10-1), and the text font inside the image (rules 18–19). It runs
# as the node user like the rest; Playwright starts it without the setuid sandbox.
FROM service AS worker
ARG CHROMIUM_VERSION=155.0.8059.84-r0
RUN apk add --no-cache "chromium=${CHROMIUM_VERSION}"
COPY --from=build --chown=node:node /repo/packages/ui/fonts/Vazirmatn-Variable.woff2 /app/fonts/
ENV PDF_BROWSER_PATH=/usr/bin/chromium-browser \
    PDF_FONT_FILE=/app/fonts/Vazirmatn-Variable.woff2
USER node
