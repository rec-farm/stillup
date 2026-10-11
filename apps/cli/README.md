# @rec/stillup

Manage StillUp HTTP monitoring checks as code from any repository. Requires Node.js 24 or later and a running StillUp installation for remote commands.

```sh
pnpm add -D @rec/stillup
pnpm stillup validate --config monitoring/stillup.config.json
pnpm stillup diff --config monitoring/stillup.config.json
pnpm stillup test --config monitoring/stillup.config.json --yes
pnpm stillup apply --config monitoring/stillup.config.json --yes
```

Set `STILLUP_URL` to your installation's browser origin plus `/api`, and supply `STILLUP_ADMIN_TOKEN` through your shell or CI secret manager. Local validation needs neither. Never expose administrator credentials to untrusted pull requests.

## Configuration

JSON, TypeScript, and JavaScript configurations are supported. For example, `stillup.config.ts`:

```ts
import { defineConfig } from '@rec/stillup';

export default defineConfig({
  version: 1,
  project: 'my-api-production',
  checks: [
    {
      id: 'ready',
      config: {
        name: 'API readiness',
        url: 'https://api.example.com/readyz',
        intervalSeconds: 60,
        expectedStatus: 200,
        jsonAssertions: [{ path: '$.ok', equals: true }],
        headers: { Authorization: 'Bearer {{API_TOKEN}}' },
      },
    },
  ],
});
```

Configuration files execute locally; only load trusted files. Secret values belong in StillUp's managed secrets or worker environment, referenced with `{{NAME}}`. Create referenced secrets, notification channels, and locations in StillUp before applying.

`validate` checks the local schema. `diff` previews configuration changes; `diff --check` exits 2 for changes or retained checks. `test --yes` sends real requests from the API server without saving checks or results; `--id` selects one check. `apply --yes` obtains a fresh preview and applies it atomically. `--json` provides structured output. Errors and failed tests exit 1.

Keep project and check IDs stable. Code-owned configurations are read-only in the dashboard, where pause and archive remain available. Omitted checks are retained, not deleted. Applying configuration does not prove endpoint health. Tests run from the API server, not selected regional probes, and may mutate targets.

The package also exports `defineConfig`, `codeConfigSchema`, `createClient`, `ConfigurationError`, and their configuration/plan types for programmatic use.

## Maintainer release

From the StillUp repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @rec/stillup test:package
cd apps/cli
npm publish --access public
```

`prepack` builds the CLI, SDK, and declarations and copies the repository license. The standalone package check installs an actual tarball in a temporary project; it needs npm registry access. Publish each release with a new package version.
