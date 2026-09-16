#!/bin/sh
set -eu
# Docker named volumes and cloud block volumes have different initial ownership.
if [ "$(id -u)" = 0 ]; then
  probe_data="${STILLUP_PROBE_DATA:-/data}"
  mkdir -p "$probe_data"
  chown node:node "$probe_data"
  chmod 700 "$probe_data"
  exec setpriv --reuid=node --regid=node --init-groups node --import tsx src/main.ts
fi
exec node --import tsx src/main.ts
