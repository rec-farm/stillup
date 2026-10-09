# StillUp roadmap

## Direction

API-first, self-hosted synthetic monitoring with public status pages. The API, worker and probe are native Rust (Axum, SQLx, PostgreSQL); the dashboard, documentation and status page are a React app built with Vite and served by the API. TypeScript remains the language for the SDK, CLI and monitoring-as-code configuration. Browser monitoring is outside the current scope.

## Runtime — Vite and Rust (complete)

[PR #2](https://github.com/RodrigoEspinosa/stillup/pull/2) replaced the Next frontend and Node API, worker and probe with Vite and native Rust while preserving data, migrations, API contracts and the probe protocol. The previous implementation remains under `tests/legacy-*` only as parity fixtures. See [the migration record](architecture/vite-rust-migration.md).

**Follow-up verification:** live sign-in with a real OIDC provider, the broader malformed-input API contract audit ([api-compatibility.md](architecture/api-compatibility.md)), full desktop/mobile browser QA, dashboard median/p95 and fresh-start latency where Rust measured slower, and whole-stack and concurrent measurements ([performance.md](architecture/performance.md)).

## Milestone 1 — Working foundation

HTTP check creation; status/latency/JSON assertions; PostgreSQL persistence; durable scheduling; manual execution; pause/resume; incident transitions; webhook alerts; public status; trusted installation-owner authentication; Docker and CI.

## Milestone 2 — Everyday administration

**Implemented:** check editing with configuration revisions, immutable run attribution, stale-edit protection, reversible archival, restoration to a paused state, and configuration history in the UI.

**Request testing implemented:** test unsaved checks and edits with the production executor, safe assertion diagnostics, named secrets, and bounded execution without affecting monitoring history or alerts.

**API contracts implemented:** visual JSON/header assertion editor, typed comparisons, bounded draft-07 schema validation, and per-assertion results without storing response values.

**Alerting implemented:** configurable webhook channels, per-check routing, durable delivery/attempt history, backoff and manual retry, interrupted-worker recovery, ordered transitions, optional outage reminders, and incident timelines with retained opening/recovery snapshots.

**Secrets implemented:** encrypted named secrets, write-only management, runtime credential rotation, check/channel/delivery usage visibility, and environment compatibility.

**Users implemented:** single sign-on users invited by email, administrator and viewer roles enforced by the API, revocable database-backed sessions, and a break-glass installation token. Installations without users keep the previous behavior.

**Remaining:** project defaults, personal API tokens, an audit log of changes, and email notifications.

## Milestone 3 — Complete status communication

**Implemented:** public component groups, branding, maintenance windows, written incident updates, and standalone manual public incidents.

**Implemented:** custom public domains (`STATUS_PAGE_DOMAINS`) restricted to read-only status, and interval-aware daily uptime rollups kept independently of run retention, shown as 90-day bars per published component, a 30-day figure per check in the dashboard, and 90-day history in check details (`GET /v1/checks/:id/uptime`).

**Remaining:** components independent of checks, subscriptions, and independently hosted status snapshots with freshness indicators.

## Milestone 4 — Monitoring as code

**Implemented:** workspace TypeScript SDK and CLI with validate/test/diff/apply for declarative HTTP checks; stable project/check IDs; strict validation; field-only previews; transactional apply with stale-preview protection; immutable configuration revisions; explicit code-versus-UI ownership; preserved pause/archive state; retained omitted checks; JSON support; configuration and CI examples. User-facing documentation is available at `/docs`.

The CLI loads trusted TypeScript locally and submits validated JSON. Request tests run through the existing API request tester. The SDK and CLI are not yet published to npm.

**Remaining:** published packages, scoped project credentials, explicit adoption/ownership transfer, resource deployment beyond checks, and multi-step API workflows with cleanup. Execute future user workflows in a separate sandbox; never evaluate submitted TypeScript in the API process.

## Milestone 5 — Distributed operation

**Implemented:** automatic local probe, scoped remote enrollment and revocation, protocol v1 over HTTPS, job leases and idempotent reports, per-check locations and failure quorum, heartbeat/coverage visibility, private-network opt-in, persistent probe identity, Docker Compose installation, and a Fly.io deployment template.

The probe is now the same native Rust binary as the API and worker (`probe` image target), compatible with existing identities.

**Remaining:** published probe images and upgrade automation, TCP and DNS checks, replicas within logical locations, geographic verification, horizontal load testing, backup/restore drills, and metrics and tracing.

## Current operational boundaries

- Administrators are fully trusted; viewers are read-only. No arbitrary uploaded code.
- The local worker accesses PostgreSQL directly. Remote probes use scoped HTTPS credentials and receive only assigned jobs.
- Local-only check rows are locked during bounded HTTP execution to serialize runs and configuration changes. Distributed checks use short transactions and reject obsolete reports. This is simple but must be benchmarked before targeting large installations.
- A committed run is idempotent by job ID; a worker crash after a network request but before commit can repeat that request. Monitoring requests must tolerate repetition.
- The scheduler advances overdue checks to their next interval, rather than replaying missed intervals after downtime.
- Public incident history includes the latest 50 incidents belonging to published checks.
- Detailed observations expire; incidents, transition snapshots, delivery history and daily uptime totals persist. Uptime history before the upgrade is backfilled only from runs still retained, using the configuration revision's interval.
- User sessions are revocable (sign-out, removal). Installation-token sessions end by token rotation or expiry; sign-out removes the current browser cookie.
- Rate limits are process-local and keyed by the connecting address, so all traffic through one reverse proxy shares a bucket.
- No managed geographic locations, external SaaS dependencies, or billing.
