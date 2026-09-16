# Monitoring locations

StillUp includes a **local probe** in its worker. Existing checks continue running locally without enrollment or configuration changes. The API, PostgreSQL, scheduler, incident processing, and public page remain in the central installation. Remote probes connect to it over HTTPS, fetch assigned jobs, execute HTTP checks, and submit bounded results. They never connect to PostgreSQL.

A probe runs wherever you install it. Adding a location does not provision a server or establish its physical geography. Use a separate server or cloud region for each geographic location. Names and region labels are administrator supplied.

## Add a remote server with Docker Compose

1. Make your central StillUp web endpoint accessible over HTTPS. The web service forwards `/v1/probe/*` to the API automatically; no additional reverse-proxy route is needed. Set `APP_ORIGIN` to the public web origin.
2. In **Manage locations**, create a name and region. Enrollment expires in 15 minutes. Enter the public HTTPS origin and copy the installation command.
3. On the regional server, install Docker Engine with Compose and open a checkout of the same StillUp version. Run the generated command. It builds the `probe` Docker target and starts `deploy/probe/compose.yaml` with an identity volume. This development release does not yet publish a prebuilt registry image.
4. Wait for **online**, then select the location in a check's editor. Existing checks stay local until edited. The check detail panel shows each selected location's latest observation and connectivity.

No inbound ports are needed on a probe. The Docker image does not contain the API, database package, installation administrator token, or encryption master key. Startup initializes volume permissions and drops to the `node` user before running checks.

Keep the identity volume across restarts. Run only one probe process per identity; register another location for another server. Compose project names in generated commands include a unique enrollment suffix, so a replacement gets a new volume. Stop the replaced container explicitly. **Revoke** immediately blocks new polling and result submissions from its credential; already-sent requests cannot be recalled. Revoked locations remain attached to checks until you remove or replace them. **Replace enrollment** invalidates the previous credential and outstanding leases, and issues another short-lived token for that location.

A lost enrollment response can be retried using the credential the probe already wrote to its volume. A different credential cannot reuse the token. Enrollment and probe credentials are stored as hashes centrally; credentials are never returned by location-list APIs.

## Regional health rules

Each check chooses 1–10 locations and a failing-location threshold. Default: local only, one failing location. A distributed round has a 60-second deadline and at most one active round per check. If the configured interval is shorter than an unfinished round, the scheduler skips that interval instead of overlapping rounds or replaying a backlog. Manual **Run now** also respects this limit.

A round finishes when every selected location reports or its deadline expires:

- At least the configured number of failing locations makes the round fail.
- Enough passing locations to make that failure threshold impossible makes the round pass.
- Otherwise the round has insufficient coverage. Missing, offline, and configuration-error observations supply neither failure nor recovery votes.

For example, with three locations and a threshold of two, two failures open a failure vote even if the third is offline. Two passes provide a recovery vote. One pass, one failure, and an offline probe are inconclusive. The existing consecutive failure/recovery settings count **rounds**, not individual regional responses. One round records one aggregate run and can cause at most one incident transition. Aggregate duration is the slowest reported location; there is no single aggregate HTTP status.

Inconclusive rounds do not create or recover incidents. Existing health becomes unknown after the normal stale-observation window. Location details expose missing coverage immediately for the latest round. Probe connectivity goes offline after 45 seconds without polling or reporting. This is distinct from the monitored API failing.

**Test request** continues to execute only from the central API server. To exercise selected locations, save the check and use **Run now**.

## Credentials, network policy, and delivery

Only assign checks to servers you trust with their request credentials. When claiming work, the probe receives that check's configuration and only its referenced secret values, resolved at claim time. Rotations affect the next claim; an in-flight request may use the previous value. Remote probes use centrally managed or API-environment secrets. Keep API and local-worker secret settings consistent.

Remote private-network access is blocked by default. Opt in explicitly with `STILLUP_PROBE_ALLOW_PRIVATE_NETWORKS=true` for private probes. The API server's private-network setting does not override a remote probe's policy. Probes use the same executor, DNS pinning, request timeouts, redirect behavior, and 1 MiB response limit as local checks. Response bodies, header values, and arbitrary diagnostic strings are not sent back by the probe protocol. Only outcome, HTTP status, duration, and assertion pass/fail flags are accepted.

Every assignment has a location, configuration revision, execution epoch, deadline, and renewable-by-reassignment lease. A lease lasts at most 45 seconds and never outlives its round. After a crash, an expired lease can be claimed again. Result retries with the same completed lease are idempotent. Replaced leases, stale edits, paused/archived checks, expired rounds, and foreign locations are rejected. Poll/result requests are authenticated with the location's scoped credential; it cannot access administrator APIs.

A crash after contacting a target but before recording its result can repeat the HTTP request. Use endpoints safe for repeated monitoring. Run retention also removes finished regional rounds and observations; unfinished expired rounds are finalized by the scheduler. One remote probe executes one request at a time; assign more locations or longer intervals when requests are slow. This first version does not provide multiple replicas behind one logical location.

## Fly.io template

The optional [Fly template](../deploy/probe/fly.toml) deploys the same Docker target without exposing an HTTP service. Each Fly app represents one location and gets its own identity volume. From the repository root:

```sh
cp deploy/probe/fly.toml fly.probe.toml
# Edit app, primary_region, and STILLUP_URL in fly.probe.toml.
fly apps create YOUR_UNIQUE_PROBE_APP
fly volumes create probe_identity --app YOUR_UNIQUE_PROBE_APP --region fra --size 1
fly secrets set --app YOUR_UNIQUE_PROBE_APP --stage STILLUP_ENROLLMENT_TOKEN=YOUR_ONE_TIME_TOKEN
fly deploy --config fly.probe.toml --ha=false
```

Use the same region in the template and volume command. Create the enrollment shortly before deploying; regenerate it if a first build exceeds 15 minutes. Keep a single Machine for each enrolled identity. Repeat with a separate app, volume, and enrollment for another region. Fly infrastructure incurs hosting costs; this template does not provision anything automatically.

Template references: [Fly app configuration](https://fly.io/docs/reference/configuration/), [volume management](https://fly.io/docs/volumes/volume-manage/), [secrets](https://fly.io/docs/apps/secrets/), and [single-Machine deployment](https://fly.io/docs/apps/app-availability/). Cloud deployment requires your account and has not been performed by the local test suite.

## Protocol v1

Management: `GET/POST /v1/locations`, `POST /v1/locations/:id/enrollment`, `DELETE /v1/locations/:id`, and `GET /v1/checks/:id/locations`.

Probe endpoints all require `protocolVersion: 1`:

- `POST /v1/probe/enroll`: `{ enrollmentToken, credential }`; credential is a client-generated 32-byte hex token persisted before enrollment. Returns location ID and protocol version.
- `POST /v1/probe/poll`: bearer probe credential. Returns `{ protocolVersion, job: null | { id, leaseToken, leaseUntil, config, secrets } }`. Polling doubles as a heartbeat.
- `POST /v1/probe/results`: bearer probe credential, `{ jobId, leaseToken, result: { outcome, statusCode, durationMs, assertions?: [{ passed }] } }`. Times are recorded by the server.

Enrollment is limited to 10 requests per minute per API rate-limit bucket; polling and results each allow 600 per probe credential, so a shared web proxy does not merge their allowances. Rate limits remain per API process. Protocol requests are not browser CORS APIs; proxies must preserve Authorization and disable caching. HTTP is rejected by the executable unless `STILLUP_PROBE_ALLOW_HTTP=true` is explicitly set for local development; never use that exception for credentials crossing untrusted networks.
