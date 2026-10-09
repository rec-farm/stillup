# Legacy parity fixtures

`legacy-api`, `legacy-db`, and `legacy-probe` preserve the previous implementation solely for contract and integration comparisons. They have no application start, development, migration or build scripts and are excluded from production Docker images. All dependencies are development dependencies. The probe entry point is launched only by the legacy integration suite to verify the existing remote protocol.

Production API, scheduling, workers, migration and remote probe executables live in `backend`. SQL migration files remain in `packages/db/migrations` to preserve the existing filename ledger. TypeScript client validation and SDK/CLI tooling remain in `packages/core`, `packages/sdk` and `apps/cli`.

Run `pnpm test:integration` for the legacy parity suite. It creates and removes a uniquely named test database. Run `pnpm test:rust:integration` with explicit `TEST_DATABASE_URL` for native integration tests, which use isolated temporary schemas. Never point production entry points at these fixture implementations.
