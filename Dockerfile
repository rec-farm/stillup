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
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
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
USER node
CMD ["pnpm", "--filter", "@stillup/api", "start"]

FROM dependencies AS web-build
RUN pnpm --filter @stillup/web build

FROM node:24-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
