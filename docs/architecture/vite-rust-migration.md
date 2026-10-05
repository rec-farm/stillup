# Vite and Rust replacement

Branch: `feat/vite-rust-migration`. Deliver one PR replacing the runtime, retaining existing data and features. This branch is in progress and is not deployable yet.

## Current evidence

- Next dependency, configuration, server layouts, route handlers and development launcher removed from `apps/web`.
- Vite builds React with separate dashboard, login, documentation and public-status chunks. Native links preserve normal browser navigation. Existing monitoring UI and documentation remain.
- Documentation highlighting runs at build time through a Vite plugin; syntax parsers and WASM do not ship to browsers.
- Rust library implements compatibility with existing HMAC session cookies, constant-time administrator-token checks, Vite static serving and public-host isolation. Router tests cover public root selection, denied administration routes, credential stripping, API/asset 404s and caching.
- Rust migrations embed every existing SQL migration, preserving filenames, `stillup_migrations`, advisory lock 782314 and one transaction. Both distinct `007` migrations remain. Database execution still needs an integration test.
- Rust is not yet the running backend. TypeScript API, worker and probe remain until replacements are complete. Docker and deployment instructions still describe the old runtime.

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
