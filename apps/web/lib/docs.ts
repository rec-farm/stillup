export type DocSection = {
  id: string;
  title: string;
  paragraphs?: string[];
  steps?: string[];
  code?: string;
  language?: string;
  fields?: { name: string; default: string; description: string }[];
};
export type Doc = {
  slug: string;
  title: string;
  description: string;
  category: 'Start here' | 'Guides' | 'Reference';
  sections: DocSection[];
};
export const docs: Doc[] = [
  {
    slug: 'getting-started',
    title: 'Your first check',
    category: 'Start here',
    description: 'Go from a running installation to your first observation, incident, and alert.',
    sections: [
      {
        id: 'create',
        title: 'Monitor an endpoint you own',
        steps: [
          'Sign in with your installation administrator token. From Overview, select Create check.',
          'Give the check a recognizable name, such as Production API. Enter an HTTP or HTTPS URL you control.',
          'Start with GET, an expected status of 200, and a 60-second interval. Add assertions if a successful HTTP response alone is not enough.',
          'Select Test request to send the draft once. Inspect the HTTP status and assertion results, then select Create check to begin scheduled monitoring.',
        ],
        paragraphs: [
          'Request tests send real traffic. Use dedicated test resources and idempotent requests for POST, PUT, PATCH, or DELETE. Test request does not save your draft, open an incident, or send alerts.',
        ],
      },
      {
        id: 'health',
        title: 'Understand what the status means',
        paragraphs: [
          'Up means recent observations confirm success. Down means the configured consecutive failure threshold was reached. By default, two failures open an incident and one pass resolves it.',
          'Unknown means there is no fresh observation. Missing secrets and execution errors do not count as evidence that your service is down. Open the check details to inspect results and regional coverage.',
          'Pause stops scheduled checks. Archive also removes the check from public status while preserving its history. Restoring an archived check leaves it paused until you resume it.',
        ],
      },
      {
        id: 'next',
        title: 'Connect the rest',
        steps: [
          'Open Manage notifications to add a webhook channel. Send a test notification and inspect delivery history.',
          'Use Manage secrets for credentials, then reference them by name in request headers or bodies.',
          'Opt a check into the public status page only when you want its name and health visible publicly.',
          'For version-controlled checks, follow Monitoring as code. Existing dashboard checks stay owned by the dashboard.',
        ],
      },
    ],
  },
  {
    slug: 'checks-and-assertions',
    title: 'Checks & assertions',
    category: 'Guides',
    description: 'Check status, latency, response headers, JSON values, and response structure.',
    sections: [
      {
        id: 'requests',
        title: 'Configure a request',
        paragraphs: [
          'Checks support GET, HEAD, POST, PUT, PATCH, and DELETE. Intervals range from 30 seconds to 24 hours; request timeouts range from 100 ms to 30 seconds. GET and HEAD cannot have a request body.',
          'Redirects are not followed. Responses are limited to 1 MiB. Response bodies and actual assertion values are not stored. Configuration values you enter literally are stored, including in revision history; use secret references for credentials.',
        ],
      },
      {
        id: 'json',
        title: 'Assert JSON values',
        paragraphs: [
          'Paths use a small dot-path syntax: $.status selects a top-level field; $.items.0.active selects the first item’s active field. This is not full JSONPath. Values are typed: the number 1 and the string "1" are different.',
          'The visual editor supports equals, notEquals, exists, notExists, contains, startsWith, endsWith, gt, gte, lt, lte, and array length. A missing field fails a value comparison, including comparison with null. Use notExists to assert absence. Each check supports up to 20 JSON rules.',
        ],
        language: 'json',
        code: '[\n  { "path": "$.status", "equals": "ok" },\n  { "path": "$.count", "operator": "gte", "value": 1 }\n]',
      },
      {
        id: 'headers',
        title: 'Check headers and response time',
        paragraphs: [
          'Header rules support exists, notExists, equals, and contains. Header names are case insensitive; value comparisons are case sensitive. Repeated values are joined with a comma and space. Up to 20 header rules are supported.',
          'Set a response limit to fail an otherwise successful request when it exceeds your latency budget. The timeout is separate: it bounds how long the request may run.',
        ],
        language: 'json',
        code: '{\n  "maxResponseMs": 1500,\n  "headerAssertions": [\n    { "name": "content-type", "operator": "contains", "value": "json" }\n  ]\n}',
      },
      {
        id: 'schema',
        title: 'Validate a JSON response schema',
        paragraphs: [
          'The schema editor accepts a bounded JSON Schema draft-07 subset: type, properties, required, boolean additionalProperties, items, scalar enum, minimum, maximum, minLength, maxLength, minItems, maxItems, title, and description. Boolean schemas are supported.',
          'Schemas are limited to 16 KiB and eight nested levels. References, patterns, formats, and composition keywords are not supported. Invalid JSON fails all JSON-dependent assertions.',
        ],
        language: 'json',
        code: '{\n  "type": "object",\n  "required": ["status"],\n  "properties": { "status": { "type": "string", "enum": ["ok"] } }\n}',
      },
      {
        id: 'history',
        title: 'Edit without losing history',
        paragraphs: [
          'Every changed configuration creates a numbered revision. An unchanged save keeps the current revision. Each run links to the configuration it actually used.',
          'If another editor saves first, StillUp rejects your stale save and keeps your draft open. Reopen the editor to load the latest configuration. Code-managed configurations must be changed through their project file and CLI.',
        ],
      },
    ],
  },
  {
    slug: 'secrets',
    title: 'Secrets & credentials',
    category: 'Guides',
    description:
      'Use named references so credentials stay out of your repository and check history.',
    sections: [
      {
        id: 'create',
        title: 'Create a managed secret',
        steps: [
          'Configure SECRETS_ENCRYPTION_KEY on the API and workers with the same randomly generated 32-byte key (64 hexadecimal characters). Keep a secure backup outside the database.',
          'Open Manage secrets and create a name such as API_TOKEN. Names start with a letter and use uppercase letters, digits, and underscores, up to 80 characters.',
          'Enter the value. It is write-only after saving. Reference the name in your check rather than copying the value.',
        ],
        paragraphs: [
          'Managed values are encrypted in PostgreSQL. Losing or replacing the installation encryption key makes stored values unreadable; replacing that key is not a secret-rotation procedure.',
        ],
      },
      {
        id: 'references',
        title: 'Reference a secret',
        language: 'json',
        code: '{\n  "headers": { "Authorization": "Bearer {{API_TOKEN}}" }\n}',
        paragraphs: [
          'References work in request headers and bodies. For a webhook destination, a complete {{WEBHOOK_URL}} reference is usually easiest. Substitution is literal and happens once; supply any required JSON or URL escaping yourself.',
          'Do not put credentials in monitored URLs. Do not resolve secrets through process.env in a code configuration: the resulting literal would be stored in check configuration and history.',
        ],
      },
      {
        id: 'rotation',
        title: 'Rotate without redeploying checks',
        paragraphs: [
          'Replace the named secret’s value in Manage secrets. Workers use the latest enabled value at execution time, including queued webhook retries. In-flight requests may finish with the old value. Rotation does not create a check revision.',
          'Missing, disabled, or unreadable credentials produce execution errors, not fabricated target outages. Manage secrets shows current references, including checks and notification channels.',
        ],
      },
      {
        id: 'environment',
        title: 'Use environment secrets',
        paragraphs: [
          'CHECK_SECRET_API_TOKEN supplies {{API_TOKEN}} from the execution server environment. Restart the API and workers after environment changes. Environment references work without the managed-secret encryption key.',
          'Managed names take precedence, even when disabled. A disabled managed secret never falls back to an environment value. Creating a managed name that already exists in the environment is rejected.',
        ],
      },
    ],
  },
  {
    slug: 'notifications',
    title: 'Alerts & incidents',
    category: 'Guides',
    description: 'Route webhook alerts, test delivery, and understand failure and recovery.',
    sections: [
      {
        id: 'setup',
        title: 'Connect a webhook',
        steps: [
          'Open Manage notifications, add a channel, and enter its HTTPS destination or a {{WEBHOOK_URL}} secret reference.',
          'Enable the channel and choose whether it is a default. Checks use enabled default channels unless they explicitly select channels.',
          'Send a test notification. Inspect delivery history before relying on the channel for an outage.',
        ],
        paragraphs: [
          'An empty notificationChannelIds array mutes a check. Omit that field to use defaults. Selecting channel IDs overrides defaults.',
        ],
      },
      {
        id: 'delivery',
        title: 'Handle deliveries reliably',
        paragraphs: [
          'Opening an incident sends incident.opened; recovery sends incident.resolved. Tests use notification.test and do not create incidents. A 2xx response acknowledges receipt; redirects are not followed.',
          'Delivery is at least once. Deduplicate using eventId or the Idempotency-Key header. There are six attempts per cycle, with a 10-second request timeout and backoff delays of 30, 60, 120, 240, and 480 seconds.',
          'History distinguishes pending, delivering, retrying, delivered, failed, and cancelled. Retry starts a new cycle for failed or cancelled deliveries while preserving the event’s identity and destination reference. Changing a channel URL affects future events.',
        ],
        language: 'json',
        code: '{\n  "eventId": "delivery-uuid",\n  "id": "incident-uuid",\n  "type": "incident.opened",\n  "name": "Production API",\n  "at": "2026-09-16T12:00:00.000Z",\n  "monitorId": "check-uuid",\n  "runId": "run-uuid",\n  "configRevision": 1\n}',
      },
      {
        id: 'reminders',
        title: 'Follow an ongoing incident',
        paragraphs: [
          'Open an incident to inspect transition snapshots, observations, configuration revisions, and deliveries. Pausing or archiving a check does not claim that its incident recovered.',
          'Optional reminderIntervalSeconds ranges from 300 to 86400. Reminders require a still-open incident and fresh failures from an enabled, unarchived check. They stop when paused, archived, stale, or showing recovery observations.',
        ],
      },
    ],
  },
  {
    slug: 'locations',
    title: 'Regional locations',
    category: 'Guides',
    description:
      'Run checks from your own regional servers and distinguish outages from missing coverage.',
    sections: [
      {
        id: 'enroll',
        title: 'Add a probe',
        steps: [
          'Open Manage locations and create a location for a server you operate.',
          'On that server, install Docker Engine with Compose and check out the same StillUp version.',
          'Run the short-lived enrollment command shown by StillUp. Keep its token private and preserve the probe identity volume across restarts.',
          'Wait for the location to report healthy, then select it in your check configuration.',
        ],
        paragraphs: [
          'The local probe is included automatically. Remote probes need outbound HTTPS to StillUp; the server does not need to accept inbound probe connections. This release builds probe images from the checkout. Geographic hosting is supplied by you.',
        ],
      },
      {
        id: 'quorum',
        title: 'Choose locations and a failure threshold',
        paragraphs: [
          'A check can select up to ten locations, including local. Set how many locations must fail. That threshold cannot exceed the number of selected locations.',
          'Missing probe coverage is different from an observed regional failure. Check details show regional results and freshness. A server with a lost heartbeat is not proof that the monitored endpoint is down.',
          'Use the probe setup guide in docs/PROBES.md for the full Docker Compose and Fly.io templates, protocol rules, and credential lifecycle.',
        ],
      },
    ],
  },
  {
    slug: 'status-page',
    title: 'Public status page',
    category: 'Guides',
    description:
      'Publish selected checks, organize components, and communicate maintenance and incidents.',
    sections: [
      {
        id: 'publish',
        title: 'Choose what becomes public',
        paragraphs: [
          'Enable Show on public status page on individual checks. Then open Customize status page to set the name, title, introduction, accent color, logo, website, and component groups.',
          'Assigning a private check to a group does not publish it. Empty groups stay private. Archived checks are removed from public status. The page is available without sign-in at /status.',
        ],
      },
      {
        id: 'design',
        title: 'Design your public page',
        paragraphs: [
          'Open Design & content to change typography, page width, spacing, corner radius, colors, logo, favicon, header caption, and footer. Choose light, dark, or the visitor’s system theme. Custom background, surface, and text colors apply to the light palette; dark mode uses a readable preset.',
          'Add up to eight navigation links and twelve text sections before or after services. Move sections up to reorder them. Preview changes shows an unsaved sample using your published components; it does not represent live health. Save public page publishes the design to all configured domains.',
          'You can remove StillUp attribution and hide resolved history. Active incidents, service health, maintenance, and stale-data warnings remain visible. Use colors with sufficient contrast for your visitors.',
        ],
      },
      {
        id: 'custom-domain',
        title: 'Connect your domain or CDN',
        paragraphs: [
          'For a self-hosted installation, set STATUS_PAGE_DOMAINS on the web service to a comma-separated list such as status.example.com,status.example.net, then restart the web service. Keep your dashboard on a separate hostname. The configured public hostnames serve the status page at / and /status and allow only the read-only public status API and required static assets.',
          'Create a CNAME to your ingress hostname (or A/AAAA records to its IP), register the hostname with your hosting provider, and provision a TLS certificate. A CNAME alone does not configure HTTPS. StillUp does not provision DNS records, verify ownership, or issue certificates: those are managed by your ingress or hosting provider.',
          'A CDN can proxy the domain if it preserves the visitor’s original Host header to StillUp. Use HTTPS from the CDN to the origin with a valid certificate, strip untrusted forwarded headers at the ingress, and do not rewrite Host to the dashboard hostname. Only expose configured hostnames at your ingress; keep the API port private.',
          'Bypass CDN caching for /, /status, and /api/v1/public/status so incident updates stay current. Do not cache error responses or use a stale-on-error page that claims everything is operational. Hashed /_next/static assets can be cached. Check that the public root loads, the status API updates, and /login and /api/v1/status-management return 404 on the public hostname.',
          'This remains one status page per installation, shared across its configured domains. A custom domain or CDN does not make the monitoring installation independent: if its origin fails, live status observations can become unavailable.',
        ],
        code: 'STATUS_PAGE_DOMAINS=status.example.com,status.example.net',
        language: 'env',
      },
      {
        id: 'headless',
        title: 'Build a completely custom frontend',
        paragraphs: [
          'For full HTML, CSS, JavaScript, or framework control, use GET /api/v1/public/status on the web origin (GET /v1/public/status on the internal API). It exposes published component names and health, groups, branding, public maintenance, and incident communications without an admin token. Keep the backend and dashboard credentials on your server.',
          'Host your frontend anywhere and fetch the public JSON from its server or through a same-origin proxy. Cross-origin browser access is not enabled by default. Poll no faster than every 15 seconds, use no-store caching, and show an unavailable or stale state when refresh fails rather than reporting all systems operational.',
          'The built-in editor provides structured content and appearance controls. Arbitrary HTML, CSS, and scripts belong in your separately hosted frontend. The built-in renderer never executes user-provided markup.',
        ],
        code: 'const response = await fetch("https://status.example.com/api/v1/public/status", { cache: "no-store" });\nif (!response.ok) throw new Error("Status unavailable");\nconst status = await response.json();',
        language: 'javascript',
      },
      {
        id: 'maintenance',
        title: 'Schedule maintenance',
        paragraphs: [
          'Add start and end times, public text, and selected public components or all published components. The editor accepts your browser’s local time and displays scheduled timestamps in UTC after saving.',
          'Maintenance changes public labels. Checks and notifications continue running, and monitoring incidents are not automatically resolved.',
        ],
      },
      {
        id: 'communicate',
        title: 'Write incident updates',
        paragraphs: [
          'For detected incidents, publish Investigating, Identified, or Monitoring updates. Real monitoring recovery is required before communicating a detected incident as Resolved.',
          'For an issue outside automated checks, create a manual incident. Its selected public components remain disrupted until you publish a Resolved update. Written updates do not manufacture check results or send webhook alerts.',
          'Public copy is plain text and should be safe to share. The status page currently runs on the same installation: if that host is unavailable, its public page is unavailable too.',
        ],
      },
    ],
  },
  {
    slug: 'monitoring-as-code',
    title: 'Monitoring as code',
    category: 'Start here',
    description:
      'Define HTTP checks in TypeScript or JSON, review changes, and apply them from your repository.',
    sections: [
      {
        id: 'setup',
        title: 'Start from the checkout',
        paragraphs: [
          'This release includes a workspace SDK and CLI; they are not published to npm yet. Use Node.js 24 and pnpm 11.9.0, run pnpm install in your StillUp checkout, and copy examples/monitoring/stillup.config.ts for your project.',
          'TypeScript and JavaScript configuration files execute locally in the CLI process. Only validated JSON is sent to the server. Use trusted config files; no user code is evaluated in the API or probes. JSON files are also supported.',
        ],
        language: 'typescript',
        code: "import { defineConfig } from './packages/sdk/src/index';\n\nexport default defineConfig({\n  version: 1,\n  project: 'production',\n  checks: [{\n    id: 'api-health',\n    config: {\n      name: 'Production API',\n      url: 'https://api.example.com/health',\n      headers: { Authorization: 'Bearer {{API_TOKEN}}' },\n      intervalSeconds: 60,\n      expectedStatus: 200,\n      jsonAssertions: [{ path: '$.status', equals: 'ok' }],\n    },\n  }],\n});",
      },
      {
        id: 'validate',
        title: 'Validate and connect',
        paragraphs: [
          'Save the example as stillup.config.ts in the checkout root and replace the endpoint with your own. validate checks the schema locally without credentials. diff and apply also validate referenced notification channels and locations against the installation.',
          'Set STILLUP_URL to the browser-facing origin plus /api. When connecting directly to the private API, use its origin without /api. Use HTTPS for remote installations. Supply STILLUP_ADMIN_TOKEN through your shell or CI secret manager, never in the config file.',
        ],
        language: 'shell',
        code: 'pnpm stillup validate\nexport STILLUP_URL="https://status.example.com/api"\n# Set STILLUP_ADMIN_TOKEN using your secret manager.\npnpm stillup diff\npnpm stillup test --id api-health --yes\npnpm stillup apply --yes',
      },
      {
        id: 'commands',
        title: 'Review what each command does',
        paragraphs: [
          'validate fills defaults and rejects unknown configuration fields, duplicate IDs, and invalid assertions. Each project file allows up to 100 checks; API requests are limited to 100,000 bytes. Split larger configurations into separate projects.',
          'test sends real requests from the API server, using its secrets and network policy. It does not save checks, add run history, send alerts, or test regional quorum. --yes acknowledges those requests; POST, PUT, PATCH, and DELETE can change target data. Tests are spaced to respect the ten-per-minute limit, shared with dashboard request tests.',
          'diff previews create, update, unchanged, and retained actions. It shows changed field names, never header or body values. Review actual values in your source diff. --json returns structured output; diff --check exits 2 for changes or retained checks, useful in CI.',
          'apply --yes gets a fresh preview and submits its token with the configuration. The server locks the project and applies all configuration changes in one transaction. A competing apply or lifecycle change invalidates the preview and returns a conflict. Rerun diff and apply after reviewing. Repeating an unchanged apply creates no new revisions.',
          'Exit code 0 means success, 1 means an error or failed test, and 2 means diff --check found changes. A successful apply acknowledges saved configuration, not endpoint health.',
        ],
      },
      {
        id: 'configuration',
        title: 'Check configuration reference',
        paragraphs: [
          'Each checks entry contains an id and a config object. Only name and url are required inside config. Omitted fields use the defaults below. Applying a file replaces the full configuration, so removing an optional setting resets it to its default.',
        ],
        fields: [
          {
            name: 'name',
            default: 'Required',
            description:
              'Display name, 1–80 characters. Changing it preserves identity and history.',
          },
          {
            name: 'url',
            default: 'Required',
            description: 'HTTP(S) URL, up to 2048 characters. No embedded credentials or fragment.',
          },
          {
            name: 'method',
            default: 'GET',
            description: 'GET, HEAD, POST, PUT, PATCH, or DELETE.',
          },
          {
            name: 'headers',
            default: '{}',
            description:
              'Up to 30 header names and string values. Values may use {{SECRET_NAME}} references.',
          },
          {
            name: 'body',
            default: 'Empty string',
            description: 'Request body, up to 65,536 characters. Empty for GET and HEAD.',
          },
          {
            name: 'intervalSeconds',
            default: '60',
            description: 'Scheduling interval, 30–86,400 seconds.',
          },
          {
            name: 'timeoutMs',
            default: '10000',
            description: 'Request timeout, 100–30,000 milliseconds.',
          },
          {
            name: 'expectedStatus',
            default: '200',
            description: 'Exact expected HTTP status, 100–599.',
          },
          {
            name: 'maxResponseMs',
            default: 'null',
            description: 'Optional latency assertion, 1–30,000 milliseconds; null disables it.',
          },
          {
            name: 'jsonAssertions',
            default: '[]',
            description: 'Up to 20 typed dot-path assertions. See Checks & assertions.',
          },
          {
            name: 'headerAssertions',
            default: 'None',
            description: 'Up to 20 response-header assertions.',
          },
          {
            name: 'responseSchema',
            default: 'None',
            description: 'Optional bounded JSON Schema draft-07 subset; omit to disable.',
          },
          {
            name: 'failureThreshold',
            default: '2',
            description: 'Consecutive failed observations to open an incident, 1–10.',
          },
          {
            name: 'recoveryThreshold',
            default: '1',
            description: 'Consecutive successful observations to recover, 1–10.',
          },
          {
            name: 'notificationChannelIds',
            default: 'Default channels',
            description: 'Up to 20 existing channel UUIDs. An empty array mutes the check.',
          },
          {
            name: 'reminderIntervalSeconds',
            default: 'Off',
            description: 'Outage reminder interval, 300–86,400 seconds. Omit to disable.',
          },
          {
            name: 'locationIds',
            default: '["local"]',
            description: 'One to ten unique existing location IDs. Remote IDs are UUIDs.',
          },
          {
            name: 'locationFailureThreshold',
            default: '1',
            description: 'Locations that must fail; cannot exceed the selected location count.',
          },
          {
            name: 'public',
            default: 'false',
            description: 'Publish the active check’s name and health on /status.',
          },
        ],
      },
      {
        id: 'ownership',
        title: 'Keep ownership predictable',
        paragraphs: [
          'The project name and check id form a stable identity. Names use lowercase letters, digits, and hyphens, start with a letter, and are at most 64 characters. Keep IDs stable when changing a check’s display name or URL. Use different project names for different environments.',
          'Code-managed checks show their project and ID in the dashboard. Their configuration is read-only there and protected by the API. You can still run, pause, resume, archive, or restore them in the dashboard. apply preserves a pause; restore stays paused. Updating an archived check requires restoring it first.',
          'Omitting a check from the file retains it unchanged, including its running state. diff flags it as retained. Archive it explicitly in the dashboard when no longer needed. Renaming an ID or project creates new checks and retains the old ones; it is not a migration.',
          'There is no automatic adoption of UI checks, ownership transfer, or deletion. Notification channels, secret values, and location infrastructure are managed separately. Reference their existing IDs or secret names in code. Multi-step executable workflows are not included.',
        ],
      },
      {
        id: 'ci',
        title: 'Run it in CI',
        paragraphs: [
          'Validate on pull requests without credentials. Deploy only trusted revisions from a protected branch with an environment approval policy. TypeScript configuration is executable, so do not expose the administrator token to untrusted pull-request code.',
          'Use the sample in examples/monitoring/github-actions.yml. It installs the locked workspace, validates on pull requests, and applies on pushes to main using a protected monitoring-production environment. Configure STILLUP_URL as an environment variable and STILLUP_ADMIN_TOKEN as its secret.',
          'The CLI currently uses the installation administrator token; scoped project credentials are not available. If a request times out after sending an apply, run diff to inspect the saved state before retrying. Repeat apply is safe for unchanged configuration.',
        ],
      },
    ],
  },
  {
    slug: 'api',
    title: 'API reference',
    category: 'Reference',
    description:
      'Authenticate, create checks, test requests, and integrate project previews and apply.',
    sections: [
      {
        id: 'authentication',
        title: 'Connect to the management API',
        paragraphs: [
          'Use Authorization: Bearer <ADMIN_TOKEN>. Browser sessions also work for dashboard requests. Through the web application, endpoints start with /api/v1; the private API exposes /v1 directly. Never embed tokens in URLs.',
          'Most endpoints share an installation rate limit of 120 requests per minute per bucket. Request tests and notification test/retry actions have additional limits. A 400 response means invalid input, 401 means authentication is required, 409 means a state or revision conflict, and 429 means the limit was reached.',
        ],
        language: 'shell',
        code: 'curl "$STILLUP_URL/v1/dashboard" \\\n  -H "Authorization: Bearer $STILLUP_ADMIN_TOKEN"',
      },
      {
        id: 'checks',
        title: 'Create, test, and edit checks',
        paragraphs: [
          'POST /v1/checks creates a UI-owned check using the check configuration object. POST /v1/checks/test tests that same object without saving it. GET /v1/checks/:id returns configuration, revision, health, and codeOwnership.',
          'PUT /v1/checks/:id accepts { config, expectedRevision } for UI-owned checks. PATCH accepts { enabled, expectedRevision } to pause or resume. POST /v1/checks/:id/run queues a run. POST /v1/checks/:id/archive and /restore require { expectedRevision }.',
          'GET /v1/checks/:id/runs lists recent observations. GET /v1/checks/:id/revisions supports a before revision cursor; /revisions/:revision retrieves one snapshot. GET /v1/dashboard lists checks and recent incidents.',
        ],
        language: 'json',
        code: '{\n  "name": "Production API",\n  "url": "https://api.example.com/health",\n  "method": "GET",\n  "expectedStatus": 200,\n  "intervalSeconds": 60\n}',
      },
      {
        id: 'projects',
        title: 'Preview and apply a code project',
        paragraphs: [
          'POST /v1/code/plan accepts { version: 1, project, checks: [{ id, config }] }. It returns { project, token, changes }. Each change contains its stable ID, action, and changed field names, plus the monitor ID, revision, and pause/archive state when it exists.',
          'POST /v1/code/apply accepts { config: <the same project configuration>, token: <preview token> }. It checks the preview against current project state and applies atomically. A conflict leaves all checks unchanged. The returned plan describes actions performed; request a new plan to observe the resulting revisions.',
        ],
      },
      {
        id: 'other',
        title: 'Other resources',
        paragraphs: [
          'GET/POST /v1/notification-channels and PUT /v1/notification-channels/:id manage webhooks. /:id/test sends a test. GET /v1/notification-deliveries lists history and /:id lists attempts; POST /:id/retry retries a failed or cancelled delivery.',
          'GET/POST /v1/secrets and PUT /v1/secrets/:name manage write-only secret values. GET/POST /v1/locations manage locations; POST /:id/enrollment renews enrollment and DELETE /:id revokes a remote location.',
          'GET /v1/status-management returns page management data; PUT /settings saves { config, expectedRevision }. POST /maintenance creates a window; PUT /maintenance/:id edits it. POST /incidents creates a manual incident; POST /incidents/:id/updates publishes an update.',
          'GET /v1/incidents/:id provides the incident timeline. GET /v1/public/status is unauthenticated. The repository README includes resource-specific fields and operational limits.',
        ],
      },
    ],
  },
  {
    slug: 'self-hosting',
    title: 'Install & operate',
    category: 'Reference',
    description:
      'Run StillUp locally or with Docker, configure network access, and upgrade safely.',
    sections: [
      {
        id: 'local',
        title: 'Run locally',
        paragraphs: [
          'Use Node.js 24 LTS, pnpm 11.9.0, and Docker Compose. From your checkout, install dependencies and create a private environment file. Generate a strong ADMIN_TOKEN and put it in .env before starting.',
        ],
        language: 'shell',
        code: 'pnpm install\ncp .env.example .env\nopenssl rand -hex 32\n# Set ADMIN_TOKEN in .env, then:\ndocker compose up -d db\npnpm dev',
        steps: [
          'Open http://localhost:3000 and sign in with your administrator token.',
          'The development command starts the web application, API, and worker. Database migrations run automatically under a lock.',
          'Public status is at http://localhost:3000/status. No checks are public until explicitly selected.',
        ],
      },
      {
        id: 'docker',
        title: 'Deploy with Docker',
        paragraphs: [
          'Set strong POSTGRES_PASSWORD and ADMIN_TOKEN values and set APP_ORIGIN to your actual browser-facing HTTPS origin. Put a TLS reverse proxy in front of the loopback-bound web port 3000. Keep the API and database private.',
          'Keep a backup of PostgreSQL, environment configuration, and the separate secrets encryption key. Stop older API and worker processes when upgrading, then restart all services on the same version so migrations and queue behavior agree.',
        ],
        language: 'shell',
        code: 'docker compose --profile app up --build -d',
      },
      {
        id: 'networks',
        title: 'Monitor a private network',
        paragraphs: [
          'Private, loopback, link-local, and reserved target addresses are blocked by default, including DNS results. To monitor your local services, set ALLOW_PRIVATE_NETWORKS=true on the executing API/worker or probe and restart it.',
          'This setting applies to all requests executed by that process, including webhooks where applicable. Limit management access to trusted administrators and configure separately hosted probes deliberately.',
        ],
      },
      {
        id: 'troubleshooting',
        title: 'When something looks wrong',
        steps: [
          'Cannot sign in: confirm the current ADMIN_TOKEN, APP_ORIGIN, HTTPS setup, and that the API is running.',
          'Checks stay unknown: inspect worker health, probe coverage, secret references, and network policy; inspect the latest execution result.',
          'Alerts do not arrive: confirm routing and enabled channels, then inspect delivery attempts and send a test.',
          'A code apply conflicts: another apply, pause, resume, or archive changed the project. Rerun diff and review before applying again.',
        ],
      },
    ],
  },
];
