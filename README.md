# StillUp

**Open-source API monitoring.**

Know before your users do.

Self-hosted HTTP checks, configurable assertions, incident detection, webhook alerts, and a public status page. Built with React, Vite, Rust, Axum, and PostgreSQL. No browsers are required to execute checks.

## What it does

StillUp is intended for a trusted administrator managing one installation:

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
- Publish selected checks, their incidents and 90-day uptime history at `/status`, optionally on dedicated status domains.
- Store encrypted named secrets, run checks from remote probe locations, and manage checks as code.
- Protect management with an installation administrator token, or OpenID Connect sign-in, and a 24-hour HTTP-only session.
- Invite people by email as administrators or read-only viewers.

Permanent deletion, email notifications, and TypeScript workflow execution are not implemented yet. See [the roadmap](docs/ROADMAP.md).

## Documentation and monitoring as code

Open **Documentation** in the dashboard, or visit `/docs` without signing in, for the first-check walkthrough and guides to assertions, secrets, notifications, locations, status pages, hosting, and the API.

Define version-controlled HTTP checks in TypeScript or JSON using the workspace SDK and CLI. Run `pnpm stillup --help` for `validate`, `test`, `diff`, and `apply`. Start with [the monitoring-as-code guide](docs/MONITORING_AS_CODE.md) and [example configuration](examples/monitoring/stillup.config.ts). The CLI and SDK currently run from this checkout and are not published to npm.

Code-owned checks have stable project/check IDs, transactional apply with stale-preview protection, and read-only dashboard configuration. You can still pause or archive them in the dashboard. Omitted checks are retained and flagged in previews; no automatic deletion occurs.

## Run locally

Requirements: Rust 1.92 or later, Node.js 24 LTS, pnpm 12.6.0, and Docker Compose. Node is used for frontend/client tooling.

```sh
pnpm install
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `ADMIN_TOKEN` in `.env`. Keep this file private.

```sh
docker compose up -d db
pnpm dev:api
# In a second terminal:
pnpm dev:worker
# In a third terminal:
pnpm dev
```

Open **http://stillup.localhost:1355** and sign in with your administrator token. The three commands start the native API, native worker, and Vite frontend. In Herdr, run each persistent command through `herdr-run`. The web app runs behind [portless](https://github.com/vercel-labs/portless) (`npm install -g portless`); run `PORTLESS=0 pnpm dev` and set `APP_ORIGIN=http://localhost:3000` to use the plain port instead. Migrations apply automatically under a database lock. The default database port is 5437 to avoid the common local PostgreSQL port.

Public status: **http://stillup.localhost:1355/status**. No checks are published until you explicitly select that option when creating one.

### First check

Use an endpoint you own, set the expected status (usually 200), and select **Create check**. The first observation starts shortly after creation. Two consecutive failures open an incident by default; one successful observation resolves it.

For a local endpoint, explicitly set `ALLOW_PRIVATE_NETWORKS=true` in `.env` and restart the worker. The default blocks private, loopback, link-local, and reserved target addresses, including addresses returned by DNS. Redirects are never followed. When enabled, private-network access applies to all checks on this installation; only trusted administrators should have access.

## Deploy with Docker

Create `.env` as above, set a strong `POSTGRES_PASSWORD` and `ADMIN_TOKEN`, and set `APP_ORIGIN` to your actual browser-facing origin.

```sh
docker compose --profile app up --build -d
```

The Rust API serves the Vite frontend and both `/api/v1` and `/v1` endpoints from one process. The worker uses the same native image with the `worker` command; production images contain no Node runtime. The web port is bound to loopback (`STILLUP_WEB_PORT`, default 3000, sets the host port). Put a TLS reverse proxy in front of it for remote access, and keep the API and database private. `APP_ORIGIN=https://...` enables secure session cookies and controls allowed browser write origins. The API requires a token independently of the frontend.

Compose marks the API healthy once `/readyz` answers, using the image's own `stillup-api healthcheck` command (the image has no curl). For other orchestrators, point liveness probes at `/healthz`, which never touches the database, and readiness probes at `/readyz`, which answers 503 while PostgreSQL is unreachable. `/health` remains as an alias of readiness for existing monitors.

### Upgrade from the TypeScript runtime

Back up PostgreSQL before upgrading. Stop every old API and worker writer, including any development processes outside Compose, before starting the native worker. Preserve the `postgres-data` volume and remote probe identity volumes.

For an existing Compose deployment, stop the old services before replacing their configuration:

```sh
docker compose --profile app stop api worker web
```

After checking out the native deployment, build and apply the embedded migrations and queue handoff:

```sh
docker compose build api worker
docker compose run --rm api migrate
docker compose run --rm api handoff
docker compose --profile app up -d --remove-orphans
```

The handoff transaction retains pg-boss job IDs, scheduled times and retry counts, and marks transferred legacy rows complete for audit. It refuses unexpired active claims: wait for those leases to expire and rerun `handoff`. Repeating a successful handoff is safe. Worker startup also performs the handoff before scheduling. Do not restart old writers after transfer.

The old `web` service is replaced by static assets inside the API image. The existing loopback web port remains the entry point; update custom reverse proxies to target the API on port 3001 inside the Compose network. Remote probes can be upgraded separately with the `probe` image target; their existing `identity.json` and `/data` volume remain compatible. API, worker and probe receive sixty seconds to drain on shutdown.

### Sign in with Handstamp (optional)

StillUp can also sign the administrator in through an OpenID Connect provider such as Handstamp. Register a client with:

- Redirect URI: `$APP_ORIGIN/api/v1/auth/oidc/callback`
- Post-logout redirect URI: `$APP_ORIGIN/login`
- Back-channel logout URI: `$APP_ORIGIN/api/v1/auth/oidc/backchannel-logout`
- Client authentication: `client_secret_basic`, PKCE required, scopes `openid profile email groups`

Then set the API's environment:

| Variable             | Example                       | Meaning                                                            |
| -------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `OIDC_ISSUER`        | `https://id.rec.farm`         | Issuer; discovery is read from `/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID`     | `stillup`                     | Client ID                                                          |
| `OIDC_CLIENT_SECRET` | `hs_sec_…`                    | Client secret                                                      |
| `OIDC_SCOPES`        | `openid profile email groups` | Requested scopes (default shown)                                   |
| `OIDC_DISPLAY_NAME`  | `Handstamp`                   | Button label: “Sign in with Handstamp” (default shown)             |

The login page shows the button only when `OIDC_ISSUER` and `OIDC_CLIENT_ID` are set; the token form keeps working either way. Signing out of a single sign-on session also ends it at the provider and returns to `/login`.

With the back-channel logout URI registered, signing out at the provider, or in another app that shares the provider session, also ends the matching StillUp sessions. The provider sends a signed logout token from its server; StillUp verifies it against the provider's keys (issuer, audience, age, the logout event, no nonce, a single use of its ID) and ends the sessions that came from its `sid`, or every session of its `sub`. The URI must be reachable from the provider's server. Sessions from the administrator token are not single sign-on sessions and are not affected.

### Users and roles

Until you add a user, **everyone the provider lets through gets the same administrator session the token gives**, so restrict who may sign in at the provider (in Handstamp, “Who may sign in”, e.g. the `stillup-admins` group). StillUp does not check groups itself.

To give people their own access, open **Manage users** on the dashboard, add yourself as an administrator, then add others by email. From then on:

- Only listed people can sign in with single sign-on. Sessions from before the first user end.
- The first sign-in needs an email address the provider marks as verified (`email_verified`), and links the account to that identity.
- **Administrators** manage everything. **Viewers** see the dashboard, checks, results and incidents, but not notifications, secrets, locations, status page settings or users. Request headers, bodies and URL query values are hidden from viewers.
- Role changes apply immediately, removing a user ends their sessions, and StillUp keeps at least one administrator. `ADMIN_TOKEN` keeps working as a break-glass administrator.

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

Optional `responseSchema` uses a bounded JSON Schema draft-07 subset validated by the native worker: `type`, `properties`, `required`, boolean `additionalProperties`, `items`, scalar `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `title`, and `description`. Boolean schemas are supported. Schemas are limited to 16 KiB and eight nested levels; references, patterns, formats, and composition keywords are rejected. The schema editor uses JSON; field and header rules use visual controls. Omit `responseSchema` to disable it.

New runs store per-assertion pass/fail results and redacted explanations under `assertions`. Responses and actual values are never stored; schema diagnostics identify the failed keyword without saving response paths or property names. Invalid JSON fails all JSON-dependent rules. Historical runs retain their original summary and have an empty assertion list. Migration `003_assertion_results.sql` adds this field automatically at startup; restart all API and worker processes together when upgrading.

POST/PUT/PATCH/DELETE checks execute repeatedly. Use dedicated test resources and idempotent requests. Multi-step cleanup workflows are not available in this milestone.

## Edit, archive, and inspect history

Open a check’s details and choose **Edit check**. The editor loads the complete saved configuration, including custom intervals and request headers/body. Saving a change creates a new numbered revision. Saving an unchanged configuration keeps the existing revision.

An editor uses the revision it opened with. If another tab saves first, your save receives a conflict instead of overwriting their changes. Your draft stays open; close and reopen the editor to load the latest configuration before applying your changes again.

The **Configuration history** tab contains read-only snapshots, with older revisions available through pagination. Each recorded response also links to its configuration revision. Environment-secret references are preserved, but the resolved secret values are not snapshotted. Literal credentials stored in check configuration are also present in its historical revisions; use secret references for credentials.

**Archive check** stops execution and removes the check and its incidents from the public status page. Archived checks remain accessible in the **Archived** filter. **Restore check** returns a check in a paused state, with its saved public visibility; explicitly resume it to restart monitoring. Archiving does not delete history or claim that an open incident recovered.

Configuration edits and lifecycle changes serialize with in-flight requests: a running request may finish before the change is saved. Its result remains attached to the configuration it actually used. Jobs queued before an edit, pause/resume, archive, or restore cannot execute after that change. A saved edit starts a fresh evaluation and resets consecutive failure/recovery counts, while preserving any open incident until new observations confirm recovery. Paused checks stay paused after editing.

## Alerts

Open **Manage notifications** on the dashboard to add, edit, enable, or disable webhook channels and send a labeled test notification. Channels have an optional default flag. A check uses default channels unless its configuration selects channel IDs; an empty `notificationChannelIds` array mutes the check. The check editor exposes these controls. API channel creation defaults `isDefault` to false; the UI explicitly offers it enabled for a new channel.

Existing `ALERT_WEBHOOK_URL` installations automatically get an environment-backed default channel. Its name/default/enabled settings are editable; change its URL through the environment and restart all API/worker processes together. Legacy queued notifications are imported into delivery history with their original idempotency key. Stop older writers before upgrading; migration `004_notifications.sql` runs at startup.

```json
{
  "eventId": "delivery-uuid",
  "id": "incident-uuid",
  "type": "incident.opened",
  "name": "Production API",
  "at": "2026-09-12T12:00:00.000Z",
  "monitorId": "check-uuid",
  "runId": "run-uuid",
  "configRevision": 1
}
```

Recovery uses `incident.resolved`, opt-in reminders use `incident.reminder`, and tests use `notification.test`. Test events do not create incidents. Payloads omit monitored URLs and response details; reminders and legacy events may omit run attribution.

Delivery history shows pending, delivering, retrying, delivered, failed, and cancelled records with attempt timestamps and safe error messages. There are six attempts per cycle, a 10-second request timeout, and retry delays of 30, 60, 120, 240, and 480 seconds. A 2xx response acknowledges delivery; redirects are never followed and response bodies are discarded. Network policies (including DNS pinning and `ALLOW_PRIVATE_NETWORKS`) apply to webhooks as well as checks. Private webhook receivers need the private-network setting explicitly enabled.

Attempts use a persistent 30-second lease. An interrupted worker leaves a visible attempt and another worker can retry after expiry. Delivery is **at least once**: a receiver can accept a message just before the worker crashes. Receivers should deduplicate the stable `eventId` / `Idempotency-Key`, including across manual retries. Events for one incident/channel are attempted in creation order; a recovery waits until earlier deliveries complete, fail, or are cancelled. Other channels and incidents can progress independently.

**Retry delivery** starts a fresh six-attempt cycle for a failed/cancelled record, preserving its history, original destination template, payload, and idempotency key. Secret references resolve to their current values on each attempt. Changing a channel URL affects future events and tests. Disabling a channel cancels queued deliveries when processed; a request already in flight may finish. Events created without any enabled destination are not delivered retroactively. Literal webhook URLs are stored in the database but never returned by management/history APIs; the UI shows their origin only. Use a managed secret reference to encrypt a sensitive destination. Protect database access and backups.

Set `reminderIntervalSeconds` on a check (300–86400 seconds) to enable outage reminders. The default is off. Reminders require a still-open incident, an enabled/unarchived check, and recent failed observations. They stop when paused, archived, stale, or showing recovery observations. Queued reminders are rechecked before sending. Missed reminder intervals are not replayed.

Click an incident name for its timeline: opening/recovery snapshots, retained observations, configuration revision links, and associated deliveries. Transition snapshots survive run retention. Older incidents cannot reconstruct transition snapshots that were never recorded. History pages contain 25 deliveries or 50 observations and provide `nextBefore`; attempt details show the latest 100 attempts. Delivery and incident history currently persist without automatic pruning.

## API

Management endpoints accept `Authorization: Bearer <ADMIN_TOKEN>` or the dashboard session cookie. Viewer sessions get 403 for anything beyond reading the dashboard, checks and incidents.

| Method        | Endpoint              | Purpose                                    |
| ------------- | --------------------- | ------------------------------------------ |
| GET           | `/healthz`            | Liveness; does not touch the database      |
| GET           | `/readyz`             | Readiness; 503 while the database is down  |
| GET           | `/health`             | Readiness (kept for existing monitors)     |
| POST / DELETE | `/v1/session`         | Sign in / sign out                         |
| GET           | `/v1/auth/config`     | Whether single sign-on is configured       |
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
pnpm test:rust
# Supply TEST_DATABASE_URL pointing at the test PostgreSQL instance:
pnpm test:rust:integration
pnpm build
pnpm format:check
```

Legacy parity integration tests require the local PostgreSQL service and `.env`. Native integration tests require explicit `TEST_DATABASE_URL` and create disposable uniquely named schemas that are dropped after success. They create and remove their own uniquely named database; the configured development database is not reseeded. Tests exercise real queued execution, incident thresholds, webhook delivery, recovery, authentication, privacy, and pause behavior. They also verify migration backfill, conflicting edits, queued-job invalidation, in-flight edit/archive serialization, historical run attribution, and restoration.

```text
apps/web       Vite dashboard, sign-in, public status and documentation
backend        Rust API/static server, scheduler, workers and remote probe
packages/core  TypeScript client validation and shared contract fixtures
packages/db    Embedded SQL migration sources
tests/legacy-* Test-only previous implementation for parity comparisons
```

Detailed runs are retained for `RUN_RETENTION_DAYS` (default 30); the worker cleans them hourly. Incidents and configuration revisions are retained. Archiving does not change the run-retention policy. Daily uptime totals are kept separately and are not affected by run retention; see the status page guide at `/docs` for how they are calculated.

## Backup and upgrades

Back up `.env` securely and PostgreSQL before upgrades. The following example applies to the default local database:

```sh
docker compose exec -T db pg_dump -U stillup -Fc stillup > stillup.dump
```

For the configuration-history upgrade, stop all old API and worker processes before starting the new version. Migration 002 backfills existing checks and results as revision 1. Do not run old workers alongside the upgraded application.

Restore into a new database first and verify it before changing `DATABASE_URL`. Apply upgrades with the matching source and lockfile; services apply versioned SQL migrations automatically. Rolling back source does not undo migrations. Do not use `docker compose down -v` unless you intend to delete the database volume.

## License

Apache-2.0. See [LICENSE](LICENSE).

Notification and investigation endpoints (all require administrator authentication):

| Method     | Endpoint                                            | Purpose                                                                       |
| ---------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| GET / POST | `/v1/notification-channels`                         | List channels / create a channel                                              |
| PUT        | `/v1/notification-channels/:id`                     | Save name, enabled, isDefault, optional replacement URL, and expectedRevision |
| POST       | `/v1/notification-channels/:id/test`                | Queue a labeled test notification                                             |
| GET        | `/v1/notification-deliveries?incidentId=…&before=…` | Delivery history; both filters optional                                       |
| GET        | `/v1/notification-deliveries/:id`                   | Delivery and latest 100 attempts                                              |
| POST       | `/v1/notification-deliveries/:id/retry`             | Retry a failed/cancelled delivery                                             |
| GET        | `/v1/incidents/:id?before=…`                        | Incident transitions and paginated observations                               |

Test and retry endpoints each allow 10 requests per minute within the existing installation-wide rate limits. Channel edits reject stale revisions with HTTP 409. Channel URLs cannot contain embedded HTTP credentials or fragments. Up to 100 channels per installation and 20 selected channels per check are supported.

## Managed secrets

Open **Manage secrets** to create, replace, enable, or disable named secrets and inspect their current check/channel references. Names use uppercase letters, digits, and underscores and start with a letter (up to 80 characters). Values are write-only after saving. Editing requires the latest revision, so concurrent rotations cannot silently overwrite each other.

Configure `SECRETS_ENCRYPTION_KEY` with a randomly generated 32-byte key encoded as 64 hexadecimal characters (`openssl rand -hex 32`). Supply the same key to the API and workers through the environment or your deployment’s secret manager. Keep it outside PostgreSQL, do not commit it, and keep a secure backup. Losing or replacing this installation key makes existing stored secrets unreadable; changing it is not a credential-rotation procedure. The API refuses writes if its key cannot unlock existing encrypted data. With the key unset, environment-based references still work and stored-secret management is unavailable.

Stored values use AES-256-GCM with a fresh random 12-byte nonce, a 16-byte authentication tag, and the secret name authenticated as additional data using the existing Node-compatible ciphertext format. Ciphertext is the only value stored in `managed_secrets`; plaintext and encryption keys are not returned by management APIs. This protects database contents, not a compromised worker that must decrypt credentials to execute checks.

Use `{{API_TOKEN}}` in a request header/body and `{{WEBHOOK_URL}}` as a complete webhook destination. References in webhook paths and query strings also work. Substitution is literal: supply the appropriate JSON or URL escaping when embedding a value. References are resolved once, never recursively. Use a full-URL secret when its characters would otherwise need URL escaping.

Workers resolve the latest enabled value at execution time. Rotation does not create check revisions or place resolved values in run history, incident snapshots, or delivery records. A queued webhook stores the original destination **reference**, so retries use its current value. In-flight requests can finish using the prior value. Legacy literal credentials in check revisions or webhook destinations are not automatically encrypted or removed; replace active literals with references and manage historical exposure separately.

`CHECK_SECRET_NAME` environment values remain supported. Managed names take precedence, including when disabled; a disabled managed secret never falls back to an environment value. Creating a managed secret with an existing environment name is rejected to avoid accidental shadowing. Missing, disabled, or unreadable check credentials produce a configuration error rather than a fabricated target outage. Webhook resolution failures appear in delivery history and retry normally.

The usage view covers current checks (including archived checks), channels, and undelivered/retryable historical delivery references. It also identifies missing references. Historical check configurations retain reference names, not resolved values. Up to 500 managed secrets are supported. Database credentials, installation keys, and backup handling remain deployment responsibilities.

| Method | Endpoint            | Purpose                                                         |
| ------ | ------------------- | --------------------------------------------------------------- |
| GET    | `/v1/secrets`       | Availability, names, revisions, and current usage; never values |
| POST   | `/v1/secrets`       | Create `{ name, value, enabled? }`                              |
| PUT    | `/v1/secrets/:name` | Replace value and/or change enabled, with expectedRevision      |

## Public status page management

Open **Customize status page** for branding (name, title, introduction, accent color, public logo and website links), component groups, maintenance windows, and incident communication. These changes publish to `/status`. Branding also supplies the browser title and description. Only checks already marked public and not archived are included; assigning a private check to a group does not publish it. Empty groups remain private. Group order follows the editor’s group list.

Maintenance windows specify start/end times, public text, and either selected public components or all published components. The editor accepts your browser’s local time and displays scheduled timestamps in UTC after saving. Active windows mark affected public components as under maintenance; future windows appear as scheduled, and expired/cancelled windows stop affecting public labels. Checks and notifications continue running. Maintenance does not resolve monitoring incidents or change private check health.

Write progress updates on detected incidents using Investigating, Identified, or Monitoring. Monitoring must confirm recovery before a detected incident can be communicated as Resolved. For issues outside automated checks, publish a manual incident against selected public components; it marks their public status as disrupted until a manual Resolved update. A later non-resolved update reopens that manual incident. These communication changes do not manufacture check results or send webhook notifications. Public incident bodies are plain text; only explicitly written public copy is published.

An incident/update is visible only while at least one affected component is public and active. Hidden component IDs are removed from public responses. The management/history view displays up to 100 incidents (unresolved first), 100 maintenance windows (active first), and 50 recent written updates per incident. Public component impact is calculated independently of history limits. Written updates and schedules persist; the latest status data refreshes every 15 seconds, with a stale indicator on refresh failure.

| Method | Endpoint                                      | Purpose                                                        |
| ------ | --------------------------------------------- | -------------------------------------------------------------- |
| GET    | `/v1/status-management`                       | Current page settings, maintenance, and incident communication |
| PUT    | `/v1/status-management/settings`              | Save `{ config, expectedRevision }`; initial revision is 0     |
| POST   | `/v1/status-management/maintenance`           | Publish a maintenance window                                   |
| PUT    | `/v1/status-management/maintenance/:id`       | Edit/cancel a window with expectedRevision                     |
| POST   | `/v1/status-management/incidents`             | Publish `{ title, monitorIds, body }` as a manual incident     |
| POST   | `/v1/status-management/incidents/:id/updates` | Publish `{ source, stage, body, expectedRevision }`            |

All management endpoints require administrator authentication. Migration `005_secrets_and_status.sql` applies at startup. Restart the API and workers together when upgrading. Existing checks, environment credentials, incident records, and the public page continue to work with the default settings.

## Test a request before saving

The check editor's **Test request** button sends the current draft once and displays HTTP status, duration, and individual assertion results. It works for new checks and unsaved edits, including named secret references. Testing does not save a check or revision, add run history, change health, open incidents, or send notifications. Response bodies, response header values, and resolved credentials are not returned.

A test sends a real request and can change data at the target, especially with POST, PUT, PATCH, or DELETE. It runs from the API server with that server's secrets and network policy; installations with separately configured workers should keep those settings consistent. Notification routing and scheduling are not exercised by a request test. Test again after changing the draft or rotating a secret.

Authenticated clients can use `POST /v1/checks/test` with the same configuration body as check creation. Valid requests return a `CheckResult`, including failed assertions or execution errors; malformed configuration returns 400. Tests have the configured request timeout (at most 30 seconds), a 1 MiB response limit, ten requests per minute per rate-limit bucket, and at most two concurrent tests per API process. Excess tests return 429 without entering a queue.

## Regional probes

StillUp includes a local probe automatically. **Manage locations** creates short-lived enrollment commands for regional servers; checks can select locations and configure how many must fail. Location details distinguish regional failures from missing probe coverage. Remote probes need only outbound HTTPS and a persistent identity volume.

See [the probe setup guide](docs/PROBES.md) for Docker Compose installation, the Fly.io template, health rules, credentials, and protocol details. Geographic servers are supplied by the operator; this version builds the probe image from your checkout.

### Company branding

Use **Appearance** in the dashboard to set a shared company name, logo, accent color, welcome message, and dashboard spacing with a live preview. Changes persist in PostgreSQL and also brand the sign-in screen. Public status-page branding stays separate. See [workspace appearance](docs/APPEARANCE.md).
