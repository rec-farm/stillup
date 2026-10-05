"""Measure cold browser navigations using the bounded browser fixture and a prebuilt Next baseline."""
import argparse
import datetime
import hashlib
import hmac
import json
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--session-file', type=Path, default=Path('artifacts/browser-fixture/session.json'))
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
config = json.loads(args.session_file.read_text())
expires = str(int(time.time() * 1000) + 3600000)
cookie = expires + '.' + hmac.new(config['admin_token'].encode(), expires.encode(), hashlib.sha256).hexdigest()
result = {'recorded_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'baseline_revision': config['baseline_revision'], 'native_revision': subprocess.check_output(['git','rev-parse','HEAD'], text=True).strip(), 'method': 'One cold isolated Chromium context per route, same native API and empty disposable database for both frontends, built production servers, network-idle capture before periodic polling. Resource Timing transferSize includes browser-estimated headers; encoded/decoded body bytes reflect actual negotiated HTTP responses. Server processes/filesystem may be warm. Not a timing/capacity benchmark.', 'variants': {}}
binary = Path(__file__).resolve().parents[1] / 'backend/target/release/stillup-api'
result['native_executable_sha256'] = hashlib.sha256(binary.read_bytes()).hexdigest()
result['source_worktree_modified'] = subprocess.run(['git','diff','--quiet']).returncode != 0
expression = '({title:document.title,path:location.pathname,viewport:{width:innerWidth,height:innerHeight},userAgent:navigator.userAgent,entries:performance.getEntriesByType("navigation").concat(performance.getEntriesByType("resource")).map(x=>({name:x.name,initiatorType:x.initiatorType,transferSize:x.transferSize,encodedBodySize:x.encodedBodySize,decodedBodySize:x.decodedBodySize}))})'
for variant, origin in [('next',config['baseline_origin']),('vite',config['origin'])]:
    result['variants'][variant] = {}
    for index, route in enumerate(['/login','/','/status','/docs/monitoring-as-code']):
        session = f'stillup-nav-{variant}-{index}-{int(time.time())}'
        base = ['npx','--yes','agent-browser','--session',session]
        def run(*command):
            return subprocess.check_output([*base,*command], text=True)
        try:
            run('set','viewport','1280','900')
            run('cookies','set','stillup_session',cookie,'--url',origin,'--httpOnly')
            run('open',origin+route)
            run('wait','--load','networkidle')
            data = json.loads(run('--json','eval',expression))['data']['result']
            if data['path'] != route: raise RuntimeError(f'Unexpected route: {data["path"]}')
            data['totals'] = {key:sum(entry[key] for entry in data['entries']) for key in ['transferSize','encodedBodySize','decodedBodySize']}
            result['variants'][variant][route] = data
            print(variant,route,data['totals'],flush=True)
        finally:
            run('close')
args.output.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text(json.dumps(result,indent=2)+'\n')
