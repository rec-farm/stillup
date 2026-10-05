"""Bounded API comparison on disposable databases in the local test PostgreSQL container."""
import argparse
import datetime
import http.client
import hashlib
import json
import os
import platform
import signal
import socket
import statistics
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
token = 'benchmark-only-admin-token-thirty-two-characters'
def psql(sql):
    subprocess.run(['docker', 'exec', 'stillup-db-1', 'psql', '-U', 'stillup', '-d', 'stillup', '-v', 'ON_ERROR_STOP=1', '-c', sql], check=True, stdout=subprocess.DEVNULL)
def rss_tree(pid):
    rows = [list(map(int, line.split())) for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss='], text=True).splitlines()]
    included = {pid}
    while True:
        expanded = included | {child for child, parent, _ in rows if parent in included}
        if expanded == included:
            return sum(rss for child, _, rss in rows if child in included)
        included = expanded
result = {'platform': platform.platform(), 'node': subprocess.check_output(['node', '--version'], text=True).strip(), 'recorded_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'method': 'Native release API vs original Node/tsx API, sequential localhost requests with keep-alive, 100 checks (10 public), 10 warm-ups and 45 measured requests per endpoint, no workers. Startup includes fresh migrations; RSS includes descendants. Each process has a 40-second termination timer. Fixed test database credentials only; no .env is read.', 'variants': {}}
for name, command, cwd in [('node', ['node', '--import', 'tsx', str(args.baseline / 'apps/api/src/main.ts')], args.baseline), ('rust', [str(root / 'backend/target/release/stillup-api')], None)]:
    database = 'rust_bench_' + uuid.uuid4().hex
    psql('CREATE DATABASE ' + database)
    with tempfile.TemporaryDirectory() as temporary:
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        env = {'PATH': os.environ['PATH'], 'NODE_ENV': 'production', 'DATABASE_URL': f'postgres://stillup:stillup@127.0.0.1:5437/{database}', 'ADMIN_TOKEN': token, 'HOST': '127.0.0.1', 'PORT': str(port), 'APP_ORIGIN': f'http://127.0.0.1:{port}', 'CLIENT_DIR': str(root / 'apps/web/dist')}
        started = time.perf_counter()
        log = open(Path(temporary) / 'process.log', 'w+')
        process = subprocess.Popen(command, cwd=cwd or temporary, env=env, stdout=log, stderr=log, start_new_session=True)
        import threading
        def terminate():
            try: os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError: pass
        timer = threading.Timer(40, terminate)
        timer.start()
        try:
            for attempt in range(300):
                try:
                    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
                    connection.request('GET', '/health')
                    response = connection.getresponse()
                    response.read()
                    connection.close()
                    if response.status == 200: break
                except OSError: pass
                if process.poll() is not None:
                    log.seek(0)
                    raise RuntimeError(log.read())
                time.sleep(.01)
            else: raise RuntimeError('API did not become healthy')
            startup = time.perf_counter() - started
            subprocess.run(['docker', 'exec', 'stillup-db-1', 'psql', '-U', 'stillup', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', "INSERT INTO monitors(config) SELECT jsonb_build_object('name','Fixture '||n,'url','https://example.com','intervalSeconds',60,'timeoutMs',10000,'failureThreshold',2,'recoveryThreshold',1,'public',n<=10,'method','GET','expectedStatus',200,'headers','{}'::jsonb,'jsonAssertions','[]'::jsonb,'headerAssertions','[]'::jsonb) FROM generate_series(1,100) n"], check=True, stdout=subprocess.DEVNULL)
            measurements = {}
            for index, path in enumerate(['/v1/dashboard', '/v1/public/status']):
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                timings = []
                size = 0
                for sample in range(55):
                    before = time.perf_counter()
                    connection.request('GET', path, headers={'Authorization': 'Bearer ' + token})
                    response = connection.getresponse()
                    body = response.read()
                    elapsed = (time.perf_counter() - before) * 1000
                    if response.status != 200: raise RuntimeError(f'{name} {path}: HTTP {response.status}')
                    json.loads(body)
                    size = len(body)
                    if sample >= 10: timings.append(elapsed)
                connection.close()
                measurements[path] = {'median_ms': statistics.median(timings), 'p95_ms': sorted(timings)[42], 'response_bytes': size, 'samples_ms': timings}
            memory = [rss_tree(process.pid) for _ in range(5)]
            result['variants'][name] = {'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=cwd or root, text=True).strip(), 'executable_sha256': hashlib.sha256(Path(command[0]).read_bytes()).hexdigest() if name == 'rust' else None, 'startup_fresh_migrations_seconds': startup, 'rss_tree_kib': statistics.median(memory), 'endpoints': measurements}
            print(name, 'startup', round(startup, 3), 's; RSS', statistics.median(memory), 'KiB', flush=True)
        finally:
            timer.cancel()
            terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            log.close()
            psql('DROP DATABASE ' + database + ' WITH (FORCE)')
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, indent=2) + '\n')
