FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@11.9.0
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/probe/package.json apps/probe/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN pnpm install --frozen-lockfile
COPY . .

FROM base AS probe-dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/probe/package.json apps/probe/package.json
COPY packages/core/package.json packages/core/package.json
RUN pnpm install --filter @stillup/probe... --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/probe apps/probe
RUN mkdir /data && chown node:node /data

FROM probe-dependencies AS probe
ENV NODE_ENV=production
COPY deploy/probe/entrypoint.sh /usr/local/bin/stillup-probe
RUN chmod 755 /usr/local/bin/stillup-probe
WORKDIR /app/apps/probe
ENTRYPOINT ["/usr/local/bin/stillup-probe"]

FROM dependencies AS api
ENV NODE_ENV=production
# Run tsx directly: pnpm writes to /app on startup, which the node user can't.
WORKDIR /app/apps/api
USER node
CMD ["./node_modules/.bin/tsx", "src/main.ts"]

FROM dependencies AS web-build
RUN pnpm --filter @stillup/web build

FROM node:24-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
