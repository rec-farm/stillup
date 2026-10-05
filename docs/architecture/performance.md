# Migration performance evidence

These measurements cover frontend production builds and the complete generated static asset set. API startup, process memory and sequential request latency are measured below. Whole-stack startup/memory, concurrent capacity and per-navigation browser transfers remain unmeasured. Functional browser verification is still required.

Measured on macOS 26.5.2 / ARM64 using Node v26.10.0 and pnpm 12.6.0. The baseline is the unchanged pre-migration commit `30c1b36f5f97236dc79ceff9c8f2e3f3c688407f` in a detached worktree. The migration build is `e1a7ec00312c617431b81486a1b7683e48135600`. Both installations use their committed frozen lockfiles. Dependency installation is excluded. One warm-up precedes three timed build commands for each variant. Builds ran sequentially on the same machine; this small local sample is not a production capacity estimate. Next keeps its build cache between samples; Vite also benefits from warm filesystem caches.

| Measurement                    | Next baseline | Vite migration |
| ------------------------------ | ------------: | -------------: |
| Median frontend build command  |       3.420 s |        0.667 s |
| All generated JavaScript files |            18 |             12 |
| All generated JavaScript bytes |     1,190,478 |        541,277 |
| JavaScript gzip bytes          |       334,886 |        152,792 |
| CSS bytes                      |        89,530 |         89,367 |
| Font bytes                     |       311,692 |        311,692 |

The sampled median build command took 80.5% less time. Complete generated JavaScript occupies 54.4% fewer gzip bytes. These totals combine every route and shared chunk, and must not be presented as bytes downloaded for one page. They exclude HTML and source maps. Gzip is computed with Python `gzip.compress(..., mtime=0)`, rather than an HTTP compression negotiation. Fonts are unchanged; CSS size is essentially unchanged. Static guide prose now ships in generated HTML as well as the interactive guide bundle, so navigation comparisons must include HTML.

Raw timings and byte counts are in [frontend-build-measurements.json](frontend-build-measurements.json).

To reproduce without changing the primary checkout:

```sh
git worktree add --detach /tmp/stillup-performance-baseline-30c1b36 30c1b36
pnpm --dir /tmp/stillup-performance-baseline-30c1b36 install --frozen-lockfile
python3 scripts/benchmark-builds.py --baseline /tmp/stillup-performance-baseline-30c1b36 --runs 3 --output artifacts/performance/frontend-builds.json
```

The benchmark invokes only bounded builds. It does not start a server, worker or scheduler, and does not read or copy `.env` or database data.

## API runtime sample

The unchanged Node/tsx API and the Rust release API ran sequentially against separate disposable databases on the same local PostgreSQL Docker service. Each had 100 checks, including 10 public checks, with no run history, incidents, maintenance or workers. Both used production environment mode for the final sample. Processes had a forty-second termination timer and were stopped afterwards; databases were dropped. No live process or data was changed. Ten warm-up requests preceded 45 timed keep-alive requests per endpoint. Default runtime logging was retained. RSS sums the API process and its descendants (including the Node transpilation helper), sampled five times after requests. It excludes PostgreSQL, workers and the separate original Next server. The Rust API includes static frontend serving, but static/browser requests were not part of this sample.

| Measurement                                | Node/tsx API | Rust release API |
| ------------------------------------------ | -----------: | ---------------: |
| Startup with fresh migrations (one sample) |      0.594 s |          0.671 s |
| API process-tree RSS                       |  191,056 KiB |       14,688 KiB |
| `/v1/dashboard` median                     |     1.185 ms |         1.305 ms |
| `/v1/dashboard` p95                        |     1.538 ms |         4.561 ms |
| `/v1/public/status` median                 |     1.236 ms |         0.907 ms |
| `/v1/public/status` p95                    |     2.258 ms |         2.206 ms |

This sample shows substantially lower API memory and a lower public-status median. Dashboard median/p95 and fresh-start time remain higher in Rust; it does not prove every endpoint or startup is faster. Small localhost timings are sensitive to shared-machine scheduling and the Docker database, and a single process startup is insufficient for a general startup claim. An empty incident/history workload does not characterize large installations or concurrent traffic. Response bytes are recorded separately; these are uncompressed API responses, not full frontend navigation downloads.

The initial diagnostic sample found a 3.216 ms Rust public-status median, compared with 1.329 ms for Node. Source inspection identified sequential independent status queries and SQLx's default connection ping before every checkout. Native status reads now overlap independent queries and skip absent update lookups. Native pooling still validates connections idle for at least one second, while omitting an extra round trip during hot request bursts. A PostgreSQL test terminates a dedicated test connection and verifies that the idle pool replaces it; all 27 native PostgreSQL tests and Clippy pass with the production pool policy.

Raw final data, source revisions and Rust executable checksum are in [api-runtime-measurements.json](api-runtime-measurements.json). The initial diagnostic data is retained in [api-runtime-before-optimization.json](api-runtime-before-optimization.json). The initial diagnostic used the default environment rather than explicitly setting production mode, so it is evidence for investigation rather than a strict controlled before/after comparison.

```sh
cargo build --manifest-path backend/Cargo.toml --release --locked --bin stillup-api
python3 scripts/benchmark-api.py --baseline /tmp/stillup-performance-baseline-30c1b36 --output artifacts/performance/api-runtime.json
```

The API benchmark assumes the local test container `stillup-db-1` and its default local test credentials. It creates only `rust_bench_<random UUID>` databases and launches no worker. Run it with the same local test setup used for native integration tests.
