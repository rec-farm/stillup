# API compatibility audit

The native API serves both `/v1` for clients and `/api/v1` for the browser from the same router. Existing TypeScript schemas, crypto fixtures and the retained legacy implementation are reference contracts. Route coverage alone does not prove response or validation parity.

## Verified corrections

- Numeric revision paths and cursors follow the original `Number(string)` and positive safe-integer validation, including exponent/radix inputs and ECMAScript whitespace. Recognized repeated query keys reject arrays; repeated unknown keys remain ignored. Wide valid integers bind without PostgreSQL integer overflow.
- All parameterized API route families use `ApiPath`, keeping malformed UTF-8 errors in the JSON `{ "error": string }` envelope. Native router tests cover check/revision, notification, maintenance, secret, location and incident routes under both prefixes. Authentication still runs before parameter extraction. Valid percent-encoded UTF-8 and tuple parameters remain decoded.
- Database timestamp reads retain PostgreSQL microseconds. They serialize as UTC RFC 3339 strings, whereas legacy Drizzle string timestamps use PostgreSQL text notation and its session timezone. This is an intentional textual normalization, not a change to stored values or event instants. Generated JavaScript-style timestamps, such as dashboard worker heartbeat, continue using milliseconds. Clients should parse timestamps as instants rather than compare their textual spelling.

The malformed-path error wording is a stable native message; exact framework-specific Fastify error prose is not retained. SQL error details remain hidden.

## Remaining audit

Inspect all response projections and malformed-input branches beyond the already verified schema fixtures, cursor validation and JSON/path rejection behavior. Verify that intentional representation changes do not affect the CLI, SDK or browser, and document any additional differences before the final PR.
