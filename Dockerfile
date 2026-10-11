FROM node:24-bookworm-slim AS web-build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@12.6.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
RUN pnpm install --filter @stillup/web... --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/web apps/web
RUN pnpm --filter @stillup/web build

FROM rust:1.92-bookworm AS rust-build
WORKDIR /app
COPY backend/Cargo.toml backend/Cargo.lock backend/
# Build dependencies first so source edits don't refetch and recompile them.
RUN mkdir -p backend/src/bin \
    && echo "fn main() {}" > backend/src/main.rs \
    && echo "fn main() {}" > backend/src/bin/stillup-probe.rs \
    && touch backend/src/lib.rs \
    && cargo build --manifest-path backend/Cargo.toml --release --locked --bins && rm -rf backend/src
COPY backend/src backend/src
COPY packages/db/migrations packages/db/migrations
RUN touch backend/src/main.rs backend/src/lib.rs backend/src/bin/stillup-probe.rs \
    && cargo build --manifest-path backend/Cargo.toml --release --locked --bins

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 stillup && useradd --uid 1000 --gid stillup --no-create-home stillup
WORKDIR /app

FROM runtime AS probe
COPY --from=rust-build /app/backend/target/release/stillup-probe /usr/local/bin/stillup-probe
COPY deploy/probe/entrypoint.sh /usr/local/bin/stillup-probe-entrypoint
RUN chmod 755 /usr/local/bin/stillup-probe-entrypoint && mkdir /data && chown stillup:stillup /data && chmod 700 /data
ENTRYPOINT ["/usr/local/bin/stillup-probe-entrypoint"]

FROM runtime AS api
COPY --from=rust-build /app/backend/target/release/stillup-api /usr/local/bin/stillup-api
COPY --from=web-build /app/apps/web/dist /app/client
ENV HOST=0.0.0.0 PORT=3001 CLIENT_DIR=/app/client
USER stillup
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/stillup-api"]
