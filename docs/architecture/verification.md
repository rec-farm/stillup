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

CI now has an explicit container smoke step after both images build. On its Linux runner it checks image contents, starts the native API against the CI PostgreSQL service, waits for health, reads login/prerendered docs and authenticates a dashboard request, then removes its named test container. The remote Linux runs below verified this step. Previous local ARM64 HTTP-container evidence is described in the migration document.

Remaining browser scope is listed in [browser-verification.md](browser-verification.md); API audit boundaries in [api-compatibility.md](api-compatibility.md); performance measurements and their limits in [performance.md](performance.md). This record is evidence for the final review, not a claim that every migration gate is complete.

## Current legacy database upgrade

Added a dedicated PostgreSQL upgrade test after `cd683fe`. It independently executes all eight pre-Rust migrations and creates records in every existing table: monitors/revisions/runs/incidents, worker heartbeat, channels/deliveries/attempts/events, opaque secret storage, status/maintenance/communications, regional rounds/jobs/credential hashes, workspace settings and the migration ledger. It compares full database JSON rows after the native migration and after a rerun, including microsecond timestamps and original ledger application times. Only the new migration ledger entry and empty `check_jobs` table are added. The test passes, and Clippy passes. This is a disposable-schema verification; no live database upgrade is claimed.

## Linux container evidence

[CI run 37273309752](https://github.com/RodrigoEspinosa/stillup/actions/runs/37273309752) passed at `d13e4f5`, including pinned Rust 1.92 checks, native/legacy tests, release build, both Linux Docker image builds and the native container runtime smoke step. This establishes Linux image/executable and API startup behavior for that revision; final-head CI is still required after subsequent changes.

After `81fd7b9`, the real HTTP executor test additionally verifies all six supported methods. POST/PUT/PATCH/DELETE preserve the query and Content-Type, send a body containing the resolved test secret, and validate response headers/JSON. HEAD validates headers without requiring a response body. The expanded test and Clippy pass. OPTIONS is intentionally outside the existing check configuration method enum.

## Latest source and CI audit

[CI run 37328589046](https://github.com/RodrigoEspinosa/stillup/actions/runs/37328589046) passed on exact commit `f8913478141b23a4ab5e46fd06bc1fe744cd882a`: frozen install, format/type checks, TypeScript and legacy PostgreSQL suites, fixture regeneration without differences, Rust 1.92 formatting/Clippy/native tests, release build, both Linux image builds and native container runtime smoke checks.

The subsequent source audit corrected effective dashboard notification availability after removing an environment webhook and JavaScript UTF-16 token length bounds. All 33 native PostgreSQL tests and Clippy passed locally after these corrections. Final-head CI remains required after this commit.
