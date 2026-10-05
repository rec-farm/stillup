"""Bounded native browser-QA installation using a disposable local PostgreSQL database."""
import argparse
import http.server
import json
import os
import secrets
import signal
import socket
import subprocess
import threading
import uuid
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--seconds', type=int, default=600)
args = parser.parse_args()
if not 30 <= args.seconds <= 900: parser.error('Duration must be 30–900 seconds')
root = Path(__file__).resolve().parents[1]
database = 'rust_browser_' + uuid.uuid4().hex
artifact = root / 'artifacts/browser-fixture'
artifact.mkdir(parents=True, exist_ok=True)
def psql(sql):
    subprocess.run(['docker', 'exec', 'stillup-db-1', 'psql', '-U', 'stillup', '-d', 'stillup', '-v', 'ON_ERROR_STOP=1', '-c', sql], check=True, stdout=subprocess.DEVNULL)
class Target(http.server.BaseHTTPRequestHandler):
    failure = False
    alerts = []
    def do_GET(self):
        body = json.dumps({'status': 'failed' if Target.failure else 'ok', 'count': 3}).encode()
        self.send_response(503 if Target.failure else 200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if self.path == '/control/fail': Target.failure = True
        elif self.path == '/control/recover': Target.failure = False
        else: Target.alerts.append(json.loads(body))
        self.send_response(204)
        self.end_headers()
    def log_message(self, *args): pass
stop = threading.Event()
for sig in [signal.SIGINT, signal.SIGTERM]: signal.signal(sig, lambda *_: stop.set())
target = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Target)
threading.Thread(target=target.serve_forever, daemon=True).start()
with socket.socket() as reservation:
    reservation.bind(('127.0.0.1', 0))
    port = reservation.getsockname()[1]
origin = f'http://127.0.0.1:{port}'
config = {'origin': origin, 'target': f'http://127.0.0.1:{target.server_port}/health', 'webhook': f'http://127.0.0.1:{target.server_port}/webhook', 'database': database, 'admin_token': 'browser-fixture-only-admin-token-32-characters'}
(artifact / 'session.json').write_text(json.dumps(config, indent=2))
env = {'PATH': os.environ['PATH'], 'DATABASE_URL': f'postgres://stillup:stillup@127.0.0.1:5437/{database}', 'ADMIN_TOKEN': config['admin_token'], 'APP_ORIGIN': origin, 'HOST': '127.0.0.1', 'PORT': str(port), 'CLIENT_DIR': str(root / 'apps/web/dist'), 'ALLOW_PRIVATE_NETWORKS': 'true', 'SECRETS_ENCRYPTION_KEY': secrets.token_hex(32)}
processes = []
logs = []
psql('CREATE DATABASE ' + database)
try:
    for name, command in [('api', []), ('worker', ['worker'])]:
        log = open(artifact / f'{name}.log', 'w')
        logs.append(log)
        processes.append(subprocess.Popen([str(root / 'backend/target/release/stillup-api'), *command], cwd=artifact, env=env, stdout=log, stderr=log, start_new_session=True))
    print(json.dumps(config), flush=True)
    stop.wait(args.seconds)
finally:
    for process in reversed(processes):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try: process.wait(timeout=35)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    target.shutdown()
    target.server_close()
    psql('DROP DATABASE ' + database + ' WITH (FORCE)')
    for log in logs: log.close()
    print('Browser fixture stopped; disposable database removed.', flush=True)
