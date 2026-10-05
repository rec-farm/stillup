# Vite and Rust replacement

Branch: `feat/vite-rust-migration`. Deliver one PR replacing the runtime, retaining existing data and features. This branch is in progress and is not deployable yet.

## Current evidence

- Next dependency, configuration, server layouts, route handlers and development launcher removed from `apps/web`.
- Vite builds React with separate dashboard, login, documentation and public-status chunks. Native links preserve normal browser navigation. Existing monitoring UI and documentation remain.
- Documentation highlighting runs at build time through a Vite plugin; syntax parsers and WASM do not ship to browsers.
- Rust library implements compatibility with existing HMAC session cookies, constant-time administrator-token checks, Vite static serving and public-host isolation. Router tests cover public root selection, denied administration routes, credential stripping, API/asset 404s and caching.
- Rust migrations embed every existing SQL migration, preserving filenames, `stillup_migrations`, advisory lock 782314 and one transaction. Both distinct `007` migrations remain. Fresh, upgrade, rerun and rollback database integration tests pass.
- Rust executable now loads configuration, connects to PostgreSQL, applies migrations, serves Vite assets and shuts down gracefully on SIGINT/SIGTERM. Native routes handle token sessions, workspace settings, dashboard reads, check/history/revision reads and pause/archive/restore transitions, under both `/v1` and `/api/v1`.
- Native request guards enforce CSRF origin checks, signed session/bearer authorization, bounded per-peer rate limits and a 100,000-byte JSON body limit with JSON error responses.
- PostgreSQL integration tests use disposable schemas on the existing DB: fresh migrations, migration reruns, upgrade from the initial legacy schema with retained monitor IDs/history, transactional migration rollback, concurrent workspace revision conflicts, signed sessions/CSRF/rate limits, check execution epochs/archive/restore, malformed/oversized JSON errors, and a real TCP HTTP listener with graceful shutdown.
- Native OIDC routes implement configuration, cached discovery/JWKS, PKCE, signed flow cookies, state/nonce/issuer/audience/signature/expiration/access-token-hash validation, safe redirects, key rotation retry and provider logout. Cookie serialization matches an independently generated Node fixture. A local mock provider verifies the full signed-token callback and logout flow, plus rejection cases and rotated signing keys. Live Handstamp/browser sign-in remains part of final end-to-end verification.
- Native check creation/editing validates the existing configuration contract and routing IDs, writes immutable revisions atomically, rejects stale edits and CLI-owned edits, and preserves no-op behavior and execution-epoch fencing.
- Native executor pins validated DNS addresses, rejects the existing non-unicast IP ranges, disables redirects and environment proxies, preserves TLS hostname verification, bounds total execution time and response bytes, and evaluates HTTP/header/JSON/schema assertions. Real HTTP tests verify assertions, secret substitution, no-follow redirects, response limits and timeouts.
- Native encrypted-secret APIs retain Node AES-256-GCM storage/AAD format, optimistic revisions, master-key checks, metadata-only overviews, usage tracking and authoritative disabled managed names. The test-request endpoint uses resolved secrets, a two-request concurrency cap and the existing request rate limit, without saving checks or opening incidents.
- Cross-language fixtures cover 69 configuration cases, 37 assertion cases and 27 network-policy addresses. CI regenerates fixtures from the retained TypeScript contract and fails on drift. A Node-generated crypto fixture verifies stored-secret compatibility. The installed Zod version measures Unicode code points for string bounds; native workspace and token bounds were corrected to match.
- Native notifications now implement channel creation/editing with revision guards and serialized limits, test delivery, history, attempt diagnostics and manual retry. The existing delivery ledger remains authoritative: immutable unresolved destinations, idempotency keys, per-incident ordering, expiring claims, fenced acknowledgements, six-attempt exponential retry cycles and reminder eligibility. Webhooks pin DNS, disable proxies/redirects, time out after ten seconds and discard acknowledgement bodies. Environment destinations are captured and validated once; API responses expose only origins or secret-reference names.
- Fifteen PostgreSQL integration tests pass, including concurrent channel edits, lease interruption, stale acknowledgements, retries, deduplication, routing, managed-secret HTTP delivery and stale reminder cancellation. Two real HTTP integration tests cover check execution and webhook delivery. Notification worker loops and legacy pg-boss notification draining are still pending.
- Rust API is incomplete. TypeScript API, worker and probe remain until all replacements are complete. Scheduler/queued execution, incident processing, notification worker integration, probes/code management/status management still need ports. Docker and deployment instructions still describe the old runtime.

## Completion gates

- [ ] Native Rust API implements every existing route in `apps/api/src/server.ts`, including validation and response/error contracts.
- [ ] Authentication: token sign-in/out, cookies, expiration, CSRF, rate limits, OIDC discovery/PKCE/state/callback/logout and safe redirects. Existing sessions continue to work.
- [ ] Checks: create/edit/revision history, revision guards, pause/archive/restore, ad hoc execution and run history.
- [ ] Monitoring executor: HTTP methods/bodies, timeout/body limits, private-network/SSRF protection across redirects and DNS, header/JSON/schema assertions, secrets and correct outage semantics.
- [ ] Scheduler: due checks, retry/concurrency/idempotency, revision/execution-epoch fencing, worker heartbeat and retention. Define transition from pg-boss queues without losing or double-running work.
- [ ] Notifications: channels, routing, incident lifecycle, delivery attempts/retries, diagnostics and secret-safe payloads.
- [ ] Regional probes: enrollment, credential rotation/revocation, polling, reports, epochs, deduplication and coverage/staleness. Replace TypeScript probe runtime if included in the deployed backend image.
- [ ] Monitoring as code: canonicalization, ownership, signed previews, drift protection, advisory locks and atomic apply; CLI/SDK keep their API contracts.
- [ ] Appearance: schema validation, revision guards and existing settings; accessible themes, custom logos and fallback behavior.
- [ ] Public status: published monitors only, current observations, manual incidents, maintenance, branding, server-generated metadata, favicon and theme-color tags; public host root and credentials isolated.
- [ ] Docs: all routes, search, copy, anchors, keyboard controls, mobile layout and meaningful unknown-route HTTP status. Preserve static/prerendered docs as needed.
- [ ] Deployment: Rust executable(s), static Vite output, Docker/Compose, environment variables, reverse proxy, CI and README; remove obsolete Node server packages/configuration.
- [ ] Real PostgreSQL migration tests on a fresh database and an existing schema, including rollback/idempotency and retained historical data.
- [ ] Contract/integration parity against existing tests, real HTTP smoke tests and authenticated desktop/mobile browser flows.
- [ ] Measure comparable build, payload, startup, memory and request latency against the original baseline; report results without assuming Vite/Rust alone proves improvement.
- [ ] Review diff, commit/push one branch, open/update one PR and verify its remote state and CI.

## Reuse across REC products

Paramtune provides the concrete reference for Vite React builds with manifests and backend-owned runtime configuration/static serving. StillUp needs PostgreSQL scheduling and public-host isolation beyond that reference.

Candidates for a reusable REC system:

1. Vite build convention: manifest, route chunks, build-time docs highlighting, fonts and static assets.
2. Rust web infrastructure: static document serving, cache/security headers, public origin, graceful shutdown and observability.
3. Browser UI primitives: REC theme persistence before paint, accessible identity/logo fallback, documentation shell/search/code blocks and settings dialogs.
4. Shared contract fixtures: compare TypeScript SDK and Rust schemas/canonicalization without adding Node to the production server.

Keep REC brand tokens and guidance authoritative in `reciam-brand`; keep product data/auth/scheduling outside a generic component library. Extract a package only after checking a concrete second consumer in Paramtune or Handstamp, and document its API and ownership. No changes to those repositories have been made by this migration.

## Native verification commands

- `pnpm test:rust`: native unit/router tests; PostgreSQL integration tests are explicitly ignored in this command.
- `TEST_DATABASE_URL=<test database> pnpm test:rust:integration`: execute PostgreSQL tests in uniquely named temporary schemas, removing each schema after a successful test. Failed tests may leave `rust_test_*` schemas for diagnosis. Do not infer database coverage from the unit command alone.
- `cargo clippy --manifest-path backend/Cargo.toml --all-targets -- -D warnings`.
- `cargo run --manifest-path backend/Cargo.toml -- migrate`: apply the existing migration ledger and exit. The executable reads `.env` plus process environment; never use this on a database you did not intend to migrate.

Until the completion gates pass, the Rust executable is a migration development target, not the production deployment entrypoint.

Contract fixture regeneration: `pnpm exec tsx scripts/generate-contract-fixtures.ts`. Fixtures are build/test evidence; the deployed Rust server runs without Node. Legacy URL refinement can throw on malformed URLs; the Rust API rejects malformed configurations with a JSON 400 response instead.
