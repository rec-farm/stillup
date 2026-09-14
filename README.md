# StillUp

**Open-source API monitoring.**

Know before your users do.

Self-hosted HTTP checks, configurable assertions, incident detection, webhook alerts, and a public status page. Built with TypeScript, Next.js, Fastify, PostgreSQL, Drizzle, and pg-boss. No browsers are required to execute checks.

## Current milestone

This is the first working foundation, intended for a trusted administrator managing one installation:

- Create HTTP checks with GET, HEAD, POST, PUT, PATCH, or DELETE.
- Configure intervals (30 seconds–24 hours), timeouts, expected HTTP status, latency limits, header rules, typed JSON assertions, and JSON Schema validation.
- Supply headers and bodies with optional environment-secret references.
- Run checks on a durable schedule or on demand; pause and resume them.
- Edit checks with versioned configurations and protection against conflicting edits.
- Archive and restore checks while retaining their configuration and run history.
- Inspect the exact configuration revision used by each recorded run.
- Inspect recent results without storing response bodies.
- Open and resolve incidents using consecutive failure/recovery thresholds.
- Send incident and recovery webhooks through a durable retry queue.
- Publish selected checks and their incidents at `/status`.
- Protect management with an installation administrator token and a 24-hour HTTP-only session.

Multi-user accounts, permanent deletion, email notifications, custom domains, maintenance windows, uptime aggregates, TypeScript workflow execution, and remote runners are not implemented yet. See [the roadmap](docs/ROADMAP.md).

## Run locally

Requirements: Node.js 24 LTS, pnpm 11.9.0, and Docker Compose.

```sh
pnpm install
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `ADMIN_TOKEN` in `.env`. Keep this file private.

```sh
docker compose up -d db
pnpm dev
```

Open **http://localhost:3000** and sign in with your administrator token. The development command starts the web application, API, and worker. Migrations apply automatically under a database lock. The default database port is 5437 to avoid the common local PostgreSQL port.

Public status: **http://localhost:3000/status**. No checks are published until you explicitly select that option when creating one.

### First check

Use an endpoint you own, set the expected status (usually 200), and select **Create check**. The first observation starts shortly after creation. Two consecutive failures open an incident by default; one successful observation resolves it.

For a local endpoint, explicitly set `ALLOW_PRIVATE_NETWORKS=true` in `.env` and restart the worker. The default blocks private, loopback, link-local, and reserved target addresses, including addresses returned by DNS. Redirects are never followed. When enabled, private-network access applies to all checks on this installation; only trusted administrators should have access.

## Deploy with Docker

Create `.env` as above, set a strong `POSTGRES_PASSWORD` and `ADMIN_TOKEN`, and set `APP_ORIGIN` to your actual browser-facing origin.

```sh
docker compose --profile app up --build -d
```

The web port is bound to loopback. Put a TLS reverse proxy in front of port 3000 for remote access, and keep the API and database private. `APP_ORIGIN=https://...` enables secure session cookies and controls allowed browser write origins. The API requires a token independently of the frontend.

The default deployment hosts monitoring and public status together. If that host fails, the public page will also be unavailable. Independent status hosting is on the roadmap.

## Configure a check

Header values and request bodies can reference worker environment secrets:

```dotenv
CHECK_SECRET_API_TOKEN=your-service-token
```

```json
{
  "Authorization": "Bearer {{API_TOKEN}}"
}
```

Restart the worker after changing environment secrets. Literal header/body values are stored in PostgreSQL; use references for credentials. URLs should not contain secret query parameters. The dashboard is available only to the administrator, but it displays configured URLs.

JSON assertions use a deliberately small dot-path syntax, not full JSONPath:

```json
[
  { "path": "$.status", "equals": "ok" },
  { "path": "$.items.0.active", "equals": true }
]
```

Missing fields fail value comparisons, including assertions expecting `null`; use `notExists` to assert absence. Actual response values are not recorded in failure messages. Responses are limited to 1 MiB. An execution error (for example, a missing secret or blocked network) does not count as a service failure; absent fresh observations eventually show as unknown.

The visual editor supports JSON equality (string, number, boolean, or null), inequality, existence/absence, string contains/startsWith/endsWith, numeric gt/gte/lt/lte, and array length. Values are never coerced. Header rules support exists/notExists/equals/contains; names are case insensitive and value comparisons are case sensitive. Repeated headers are joined with `, ` for comparison.

The API accepts the original `{ "path": "$.status", "equals": "ok" }` format and operator rules such as `{ "path": "$.count", "operator": "gte", "value": 1 }`. Configure response headers with `headerAssertions`, for example `[{ "name": "content-type", "operator": "contains", "value": "json" }]`. Each list allows 20 rules.

Optional `responseSchema` uses a bounded JSON Schema draft-07 subset validated with Ajv on the worker: `type`, `properties`, `required`, boolean `additionalProperties`, `items`, scalar `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `title`, and `description`. Boolean schemas are supported. Schemas are limited to 16 KiB and eight nested levels; references, patterns, formats, and composition keywords are rejected. The schema editor uses JSON; field and header rules use visual controls. Omit `responseSchema` to disable it.

New runs store per-assertion pass/fail results and redacted explanations under `assertions`. Responses and actual values are never stored; schema diagnostics identify the failed keyword without saving response paths or property names. Invalid JSON fails all JSON-dependent rules. Historical runs retain their original summary and have an empty assertion list. Migration `003_assertion_results.sql` adds this field automatically at startup; restart all API and worker processes together when upgrading.

POST/PUT/PATCH/DELETE checks execute repeatedly. Use dedicated test resources and idempotent requests. Multi-step cleanup workflows are not available in this milestone.

## Edit, archive, and inspect history

Open a check’s details and choose **Edit check**. The editor loads the complete saved configuration, including custom intervals and request headers/body. Saving a change creates a new numbered revision. Saving an unchanged configuration keeps the existing revision.

An editor uses the revision it opened with. If another tab saves first, your save receives a conflict instead of overwriting their changes. Your draft stays open; close and reopen the editor to load the latest configuration before applying your changes again.

The **Configuration history** tab contains read-only snapshots, with older revisions available through pagination. Each recorded response also links to its configuration revision. Environment-secret references are preserved, but the resolved secret values are not snapshotted. Literal credentials stored in check configuration are also present in its historical revisions; use secret references for credentials.

**Archive check** stops execution and removes the check and its incidents from the public status page. Archived checks remain accessible in the **Archived** filter. **Restore check** returns a check in a paused state, with its saved public visibility; explicitly resume it to restart monitoring. Archiving does not delete history or claim that an open incident recovered.

Configuration edits and lifecycle changes serialize with in-flight requests: a running request may finish before the change is saved. Its result remains attached to the configuration it actually used. Jobs queued before an edit, pause/resume, archive, or restore cannot execute after that change. A saved edit starts a fresh evaluation and resets consecutive failure/recovery counts, while preserving any open incident until new observations confirm recovery. Paused checks stay paused after editing.

## Alerts

Set `ALERT_WEBHOOK_URL` to receive JSON events for incident opening and recovery. Restart the API and worker after changing it. The dashboard shows whether a webhook is configured.

```json
{
  "eventId": "delivery-job-uuid",
  "id": "incident-uuid",
  "type": "incident.opened",
  "name": "Production API",
  "at": "2026-09-12T12:00:00.000Z"
}
```

Recovery uses `incident.resolved`. Deliveries have a 10-second timeout and up to five retries with backoff. Delivery is at least once: receivers should deduplicate using `eventId` or the `Idempotency-Key` header. Webhook payloads omit endpoint URLs and response details. The destination is configured by the installation operator and must be trusted. Events created while alerts are disabled are not delivered retroactively.

## API

Management endpoints accept `Authorization: Bearer <ADMIN_TOKEN>` or the dashboard session cookie.

| Method        | Endpoint              | Purpose                                    |
| ------------- | --------------------- | ------------------------------------------ |
| GET           | `/health`             | Database readiness                         |
| POST / DELETE | `/v1/session`         | Sign in / sign out                         |
| GET           | `/v1/dashboard`       | Checks, recent incidents, worker heartbeat |
| POST          | `/v1/checks`          | Create a validated check                   |
| PATCH         | `/v1/checks/:id`      | Set `{ "enabled": false }` or `true`       |
| POST          | `/v1/checks/:id/run`  | Queue an on-demand run                     |
| GET           | `/v1/checks/:id/runs` | Latest 50 observations                     |
| GET           | `/v1/public/status`   | Public names, health, and incident history |

Additional management endpoints (including `GET /v1/checks/:id` to load the latest saved configuration):

| Method | Endpoint                             | Purpose                                                  |
| ------ | ------------------------------------ | -------------------------------------------------------- |
| PUT    | `/v1/checks/:id`                     | Save `{ "config": { ... }, "expectedRevision": 1 }`      |
| POST   | `/v1/checks/:id/archive`             | Archive with `{ "expectedRevision": 1 }`                 |
| POST   | `/v1/checks/:id/restore`             | Restore paused with `{ "expectedRevision": 1 }`          |
| GET    | `/v1/checks/:id/revisions?before=21` | Page through configuration history; `before` is optional |
| GET    | `/v1/checks/:id/revisions/:revision` | Read one configuration snapshot                          |

A stale `expectedRevision` returns HTTP 409. Pause/resume also accepts `expectedRevision`. Management history endpoints require authentication; public status never returns configuration snapshots. Revision pages contain `revisions` and `nextBefore` (null on the final page).

Check input contracts live in [`packages/core/src/index.ts`](packages/core/src/index.ts). The web application forwards the same API under `/api/v1/*`.

## Development and verification

```sh
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm format:check
```

Integration tests require the local PostgreSQL service and `.env`. They create and remove their own uniquely named database; the configured development database is not reseeded. Tests exercise real queued execution, incident thresholds, webhook delivery, recovery, authentication, privacy, and pause behavior. They also verify migration backfill, conflicting edits, queued-job invalidation, in-flight edit/archive serialization, historical run attribution, and restoration.

```text
apps/web       Dashboard, sign-in, public status, same-origin API gateway
apps/api       Fastify API, scheduler, HTTP worker, notification worker
packages/core  Validation, network execution, health rules, shared contracts
packages/db    PostgreSQL connection, Drizzle schema, SQL migrations
```

Detailed runs are retained for `RUN_RETENTION_DAYS` (default 30); the worker cleans them hourly. Incidents and configuration revisions are retained. Archiving does not change the run-retention policy. No uptime percentage is advertised until interval-aware aggregation is implemented.

## Backup and upgrades

Back up `.env` securely and PostgreSQL before upgrades. The following example applies to the default local database:

```sh
docker compose exec -T db pg_dump -U stillup -Fc stillup > stillup.dump
```

For the configuration-history upgrade, stop all old API and worker processes before starting the new version. Migration 002 backfills existing checks and results as revision 1. Do not run old workers alongside the upgraded application.

Restore into a new database first and verify it before changing `DATABASE_URL`. Apply upgrades with the matching source and lockfile; services apply versioned SQL migrations automatically. Rolling back source does not undo migrations. Do not use `docker compose down -v` unless you intend to delete the database volume.

## License

Apache-2.0. See [LICENSE](LICENSE).
