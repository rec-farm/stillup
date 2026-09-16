# Monitoring as code

StillUp provides a workspace TypeScript SDK and CLI for declarative HTTP checks. Read the full user guide at `/docs/monitoring-as-code` on your installation. The SDK and CLI are not published to npm yet; run the commands from a StillUp checkout with Node.js 24 and pnpm 11.9.0.

## Quickstart

1. Run `pnpm install` in your checkout.
2. Copy [the example](../examples/monitoring/stillup.config.ts), change its endpoint, and keep the SDK import relative to the file (the supplied example already works in its original location).
3. Create any referenced secrets, notification channels, and locations in the dashboard. Keep secret values out of configuration files. Use `{{API_TOKEN}}` references.
4. Validate locally, then connect to the installation:

```sh
pnpm stillup validate --config examples/monitoring/stillup.config.ts
export STILLUP_URL="https://status.example.com/api"
# Supply STILLUP_ADMIN_TOKEN through your shell or CI secret manager.
pnpm stillup diff --config examples/monitoring/stillup.config.ts
pnpm stillup test --config examples/monitoring/stillup.config.ts --id api-health --yes
pnpm stillup apply --config examples/monitoring/stillup.config.ts --yes
```

`STILLUP_URL` is the web origin plus `/api`, or the private API origin without `/api`. Use HTTPS remotely. A TypeScript/JavaScript config executes on the CLI machine; the API receives only validated JSON. JSON configuration is supported too. Only load trusted files, and never expose installation credentials to untrusted pull-request code.

## Commands and behavior

| Command        | Behavior                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `validate`     | Local schema validation; rejects typos and duplicate IDs. No credentials required.                             |
| `test --yes`   | Sends real requests from the API server; does not save checks or monitoring results. `--id` selects one check. |
| `diff`         | Read-only create/update/unchanged/retained preview. Values are omitted; review them in your source diff.       |
| `diff --check` | Exits 2 if changes or retained checks exist.                                                                   |
| `apply --yes`  | Fetches a fresh preview and atomically applies it, rejecting concurrent changes.                               |
| `--json`       | Structured output for successful commands. Errors go to stderr.                                                |

All commands accept `--config <path>`, defaulting to `stillup.config.ts`. Exit codes: 0 success, 1 errors or failed tests, 2 detected changes for `diff --check`. Each project supports 100 checks within the 100,000-byte API request limit. The apply envelope also counts toward this limit; split large projects.

Request tests use the API server's secrets/network policy, not selected remote probes. They send real traffic and can mutate target data. The CLI spaces tests to respect the ten-per-minute limit, shared with dashboard tests. `apply` success means the configuration was saved; it does not mean the endpoint is healthy.

## Identity and ownership

The project name and check ID are stable identifiers (1–64 lowercase letters, digits, and hyphens; first character a letter). Keep them stable when renaming a display name or changing a URL. Use separate projects per environment.

- Code-owned configuration is read-only in the dashboard and protected by the API.
- Run, pause/resume, archive/restore remain available in the dashboard. Apply preserves pauses and archives. A changed archived configuration must be restored before apply; restore leaves it paused.
- Omitting a check **retains it unchanged**, including whether it is running. The preview marks it `retained`. Archive it explicitly in the dashboard to stop monitoring it.
- Renaming an ID or project creates new checks and retains the old ones. It does not migrate history.
- Existing UI-owned checks are never adopted implicitly. This release has no ownership transfer, pruning, channel deployment, secret-value deployment, or executable multi-step workflows.
- An unchanged apply creates no new revisions. Changed configurations keep immutable history and invalidate previously queued executions. Open incidents remain open until monitoring confirms recovery.

The preview token binds the desired configuration to the project's current configuration revisions and lifecycle state. Apply locks the project and its existing checks; a conflict or any failed change rolls back the whole transaction. A lost HTTP response may occur after commit: run `diff` to inspect state, then retry if needed.

## CI and API

Copy [the GitHub Actions example](../examples/monitoring/github-actions.yml) into `.github/workflows/monitoring.yml`. It expects the StillUp workspace in that repository. Set up a protected `monitoring-production` environment with a `STILLUP_URL` variable and a `STILLUP_ADMIN_TOKEN` secret, and replace the example endpoint. PR validation receives no token; only trusted main-branch deployments receive the installation administrator credential. Scoped project credentials are not implemented.

Authenticated endpoints:

- `POST /v1/code/plan`: project configuration; returns `{ project, token, changes }`.
- `POST /v1/code/apply`: `{ config: <project configuration>, token: <preview token> }`; returns the performed plan. A stale token returns HTTP 409 with no changes.

Migration `007_monitoring_as_code.sql` adds ownership columns and a unique project/check identity. It applies at startup. Restart the API and workers together when upgrading.
