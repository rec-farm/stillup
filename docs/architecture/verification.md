# Migration verification record

Local verification on 2026-10-05 at source commit `0790466`:

| Check                              | Result           | Scope                                                                                                                                                                                                                  |
| ---------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                       | Passed           | All workspace TypeScript checks, 76 TypeScript tests, 28 Rust unit tests, executor/webhook/probe HTTP tests, Vite production build and both Rust release binaries.                                                     |
| `pnpm format:check`                | Passed           | Repository Prettier coverage; Rust formatting is a separate Cargo check.                                                                                                                                               |
| `pnpm test:integration`            | Passed, 32 tests | Retained legacy API/PostgreSQL reference implementation, including bounded probe fixtures. This is not native API coverage.                                                                                            |
| Contract fixture regeneration      | Passed, no diff  | Canonical TypeScript-derived fixtures match committed native reference data.                                                                                                                                           |
| API/probe image-content assertions | Passed           | Previously built local ARM64 verification images: API UID 1000, executable/static assets, probe executable/entrypoint and `/data` mode 700, absent Node/npm/pnpm in both. This does not rebuild images at this commit. |

The preceding native contract correction at `63b0e92` passed all 28 native PostgreSQL tests and Clippy. Those integration tests use isolated schemas and cover native migrations, authentication, checks, queues, alerts, locations, status management, code apply and malformed input. The full `pnpm check` intentionally leaves PostgreSQL tests ignored; its passing result must not be used alone to claim database coverage.

After this run, database inventory showed no `stillup_test_*` databases or `rust_test_*` schemas left by these checks. No user service was restarted.

CI now has an explicit container smoke step after both images build. On its Linux runner it checks image contents, starts the native API against the CI PostgreSQL service, waits for health, reads login/prerendered docs and authenticates a dashboard request, then removes its named test container. This new CI step is not yet verified by a remote run. Previous local ARM64 HTTP-container evidence is described in the migration document.

Remaining browser scope is listed in [browser-verification.md](browser-verification.md); API audit boundaries in [api-compatibility.md](api-compatibility.md); performance measurements and their limits in [performance.md](performance.md). This record is evidence for the final review, not a claim that every migration gate is complete.
