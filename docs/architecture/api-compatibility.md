# API compatibility audit

The native API serves both `/v1` for clients and `/api/v1` for the browser from the same router. Existing TypeScript schemas, crypto fixtures and the retained legacy implementation are reference contracts. Route coverage alone does not prove response or validation parity.

## Verified corrections

- Numeric revision paths and cursors follow the original `Number(string)` and positive safe-integer validation, including exponent/radix inputs and ECMAScript whitespace. Recognized repeated query keys reject arrays; repeated unknown keys remain ignored. Wide valid integers bind without PostgreSQL integer overflow.
- All parameterized API route families use `ApiPath`, keeping malformed UTF-8 errors in the JSON `{ "error": string }` envelope. Native router tests cover check/revision, notification, maintenance, secret, location and incident routes under both prefixes. Authentication still runs before parameter extraction. Valid percent-encoded UTF-8 and tuple parameters remain decoded.
- Unsupported methods on known API paths return JSON 404 after authentication, matching the legacy status instead of Axum's default empty 405. A direct legacy injection verified the reference response. Native PostgreSQL router tests cover both prefixes and unauthenticated rejection. Framework-specific extra fields and route-message wording are not retained.
- Database timestamp reads retain PostgreSQL microseconds. They serialize as UTC RFC 3339 strings, whereas legacy Drizzle string timestamps use PostgreSQL text notation and its session timezone. This is an intentional textual normalization, not a change to stored values or event instants. Generated JavaScript-style timestamps, such as dashboard worker heartbeat, continue using milliseconds. Clients should parse timestamps as instants rather than compare their textual spelling.

The malformed-path error wording is a stable native message; exact framework-specific Fastify error prose is not retained. SQL error details remain hidden.

## Remaining audit

The existing CLI and SDK were exercised over real HTTP against the gzip-enabled Rust release server in a disposable installation. `validate` and `test --yes` succeeded; `diff --check` returned 2 for a new check; `apply --yes` created it; the next diff returned 0 with revision 1. A subsequent name-only change produced an update containing only `name`, applied successfully, and returned an unchanged diff at revision 2. These checks used a local mock endpoint, a test-only administrator token and JSON configuration; they did not write to production or publish an SDK package. Local output is retained under ignored `artifacts/browser-fixture/cli-*-results.json`.

Inspect all response projections and malformed-input branches beyond the already verified schema fixtures, cursor validation and JSON/path rejection behavior. Verify that intentional representation changes do not affect the CLI, SDK or browser, and document any additional differences before the final PR.
