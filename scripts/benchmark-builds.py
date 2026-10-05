"""Compare frontend builds in an unchanged baseline worktree and the migration checkout."""
import argparse
import datetime
import gzip
import json
import platform
import statistics
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--baseline", type=Path, required=True)
parser.add_argument("--runs", type=int, default=3)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
if args.runs < 2:
    parser.error("Use at least two measured builds")
current = Path(__file__).resolve().parents[1]
result = {"recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "platform": platform.platform(), "architecture": platform.machine(), "node": subprocess.check_output(["node", "--version"], text=True).strip(), "pnpm": subprocess.check_output(["pnpm", "--version"], text=True).strip(), "method": "One unmeasured warm-up build, followed by repeated frontend production builds; dependencies installed before measurement. Gzip uses Python gzip.compress with mtime=0. Total output bytes include all routes, not a browser navigation payload.", "variants": {}}
for name, directory, output in [("next", args.baseline, ".next/static"), ("vite", current, "dist/assets")]:
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=directory, text=True).strip()
    samples = []
    for run in range(args.runs + 1):
        started = time.perf_counter()
        process = subprocess.run(["pnpm", "--filter", "@stillup/web", "build"], cwd=directory, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        seconds = time.perf_counter() - started
        if process.returncode:
            raise RuntimeError(f"{name} build failed:\n{process.stdout}")
        print(f"{name} {'warm-up' if run == 0 else f'run {run}'}: {seconds:.3f}s", flush=True)
        if run:
            samples.append(seconds)
    files = list((directory / "apps/web" / output).rglob("*"))
    groups = {}
    for extension in [".js", ".css", ".woff2"]:
        selected = [file for file in files if file.is_file() and file.suffix == extension]
        groups[extension] = {"files": len(selected), "bytes": sum(file.stat().st_size for file in selected), "gzip_bytes": sum(len(gzip.compress(file.read_bytes(), mtime=0)) for file in selected)}
    result["variants"][name] = {"revision": revision, "build_seconds": samples, "median_build_seconds": statistics.median(samples), "static_output": groups}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, indent=2) + "\n")
print(f"Saved {args.output}", flush=True)
