#!/bin/sh
set -eu
# Docker named volumes and cloud block volumes have different initial ownership.
if [ "$(id -u)" = 0 ]; then
  probe_data="${STILLUP_PROBE_DATA:-/data}"
  mkdir -p "$probe_data"
  chown stillup:stillup "$probe_data"
  chmod 700 "$probe_data"
  exec setpriv --reuid=stillup --regid=stillup --init-groups /usr/local/bin/stillup-probe
fi
exec /usr/local/bin/stillup-probe
