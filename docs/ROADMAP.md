# StillUp roadmap

## Direction

API-first, self-hosted synthetic monitoring with public status pages. TypeScript is the implementation language. Browser monitoring is outside the current scope. Runners will eventually use a versioned HTTPS protocol so a future Rust network agent does not require rewriting the application.

## Milestone 1 — Working foundation

HTTP check creation; status/latency/JSON assertions; PostgreSQL persistence; durable scheduling; manual execution; pause/resume; incident transitions; webhook alerts; public status; trusted installation-owner authentication; Docker and CI.

## Milestone 2 — Everyday administration

Check editing with configuration revisions, safe archival, reusable secrets, project defaults, first-admin setup, user invitations and roles, delivery history/retry visibility, email notifications, and better incident investigation.

## Milestone 3 — Complete status communication

Components independent of checks, manual incident updates, maintenance windows, interval-aware uptime rollups, branding/custom domains, subscriptions, and independently hosted status snapshots with freshness indicators.

## Milestone 4 — Monitoring as code

TypeScript SDK and CLI with validate/test/diff/apply, explicit UI-versus-code ownership, multi-step API workflows and cleanup. Execute user code in a separate sandbox; never evaluate submitted TypeScript in the API process.

## Milestone 5 — Distributed operation

Scoped remote-runner credentials, job leases and versioned protocol, private locations, per-runner network policies, horizontal load testing, backup/restore drills, metrics and tracing, and benchmark-driven evaluation of a Rust HTTP/TCP/DNS agent.

## Current operational boundaries

- One trusted administrator per installation; no arbitrary uploaded code.
- Local worker accesses PostgreSQL directly. Remote-runner HTTP protocol is planned.
- Check rows are locked during bounded HTTP execution to serialize runs and configuration changes. This is simple but must be benchmarked before targeting large installations.
- A committed run is idempotent by job ID; a worker crash after a network request but before commit can repeat that request. Monitoring requests must tolerate repetition.
- The scheduler advances overdue checks to their next interval, rather than replaying missed intervals after downtime.
- Public incident history includes the latest 50 incidents belonging to published checks.
- Detailed observations expire; incidents persist. No retention-independent uptime aggregate yet.
- Browser session revocation is installation-token rotation or expiry; sign-out removes the current browser cookie.
- Rate limits are process-local. All browser API proxy traffic shares a rate-limit bucket in this initial single-admin deployment.
- No managed geographic locations, external SaaS dependencies, or billing.
