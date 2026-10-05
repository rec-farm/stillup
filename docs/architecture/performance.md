# Migration performance evidence

These measurements cover frontend production builds and the complete generated static asset set. Runtime startup, process memory, API latency and per-navigation browser transfers remain unmeasured. The final migration claim requires those measurements and functional browser verification.

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
