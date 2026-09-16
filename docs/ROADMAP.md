# StillUp roadmap

## Direction

API-first, self-hosted synthetic monitoring with public status pages. TypeScript is the implementation language. Browser monitoring is outside the current scope. Runners will eventually use a versioned HTTPS protocol so a future Rust network agent does not require rewriting the application.

## Milestone 1 — Working foundation

HTTP check creation; status/latency/JSON assertions; PostgreSQL persistence; durable scheduling; manual execution; pause/resume; incident transitions; webhook alerts; public status; trusted installation-owner authentication; Docker and CI.

## Milestone 2 — Everyday administration

**Implemented:** check editing with configuration revisions, immutable run attribution, stale-edit protection, reversible archival, restoration to a paused state, and configuration history in the UI.

**Request testing implemented:** test unsaved checks and edits with the production executor, safe assertion diagnostics, named secrets, and bounded execution without affecting monitoring history or alerts.

**API contracts implemented:** visual JSON/header assertion editor, typed comparisons, bounded draft-07 schema validation, and per-assertion results without storing response values.

**Alerting implemented:** configurable webhook channels, per-check routing, durable delivery/attempt history, backoff and manual retry, interrupted-worker recovery, ordered transitions, optional outage reminders, and incident timelines with retained opening/recovery snapshots.

**Secrets implemented:** encrypted named secrets, write-only management, runtime credential rotation, check/channel/delivery usage visibility, and environment compatibility.

**Remaining:** project defaults, first-admin setup, user invitations and roles, and email notifications.

## Milestone 3 — Complete status communication

**Implemented:** public component groups, branding, maintenance windows, written incident updates, and standalone manual public incidents.

**Remaining:** components independent of checks, interval-aware uptime rollups, custom domains, subscriptions, and independently hosted status snapshots with freshness indicators.

## Milestone 4 — Monitoring as code

TypeScript SDK and CLI with validate/test/diff/apply, explicit UI-versus-code ownership, multi-step API workflows and cleanup. Execute user code in a separate sandbox; never evaluate submitted TypeScript in the API process.

## Milestone 5 — Distributed operation

**Implemented:** automatic local probe, scoped remote enrollment and revocation, protocol v1 over HTTPS, job leases and idempotent reports, per-check locations and failure quorum, heartbeat/coverage visibility, private-network opt-in, persistent probe identity, Docker Compose installation, and a Fly.io deployment template.

**Remaining:** published probe images and upgrade automation, replicas within logical locations, geographic verification, horizontal load testing, backup/restore drills, metrics and tracing, and benchmark-driven evaluation of a Rust HTTP/TCP/DNS agent.

## Current operational boundaries

- One trusted administrator per installation; no arbitrary uploaded code.
- The local worker accesses PostgreSQL directly. Remote probes use scoped HTTPS credentials and receive only assigned jobs.
- Local-only check rows are locked during bounded HTTP execution to serialize runs and configuration changes. Distributed checks use short transactions and reject obsolete reports. This is simple but must be benchmarked before targeting large installations.
- A committed run is idempotent by job ID; a worker crash after a network request but before commit can repeat that request. Monitoring requests must tolerate repetition.
- The scheduler advances overdue checks to their next interval, rather than replaying missed intervals after downtime.
- Public incident history includes the latest 50 incidents belonging to published checks.
- Detailed observations expire; incidents, transition snapshots, and delivery history persist. No retention-independent uptime aggregate yet.
- Browser session revocation is installation-token rotation or expiry; sign-out removes the current browser cookie.
- Rate limits are process-local. All browser API proxy traffic shares a rate-limit bucket in this initial single-admin deployment.
- No managed geographic locations, external SaaS dependencies, or billing.
