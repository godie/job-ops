#!/usr/bin/env bash
#
# opencode-server.sh — expose a local OpenCode server to JobOps.
#
# Why sync instead of set: `opencode serve --service` owns a stable, generated
# password and IGNORES OPENCODE_PASSWORD, so JobOps cannot choose it. This
# script reads the running service's registration (service.json) and syncs .env
# so JobOps can authenticate:
#     OPENCODE_PASSWORD = the running service's password
#     OPENCODE_URL      = http://host.docker.internal:<port>   (for the Docker app)
# The host app discovers the service automatically (service.json) — nothing to set.
#
# Usage:
#   scripts/opencode-server.sh            # check + sync .env (asks before writing)
#   scripts/opencode-server.sh --yes      # no prompt
#   scripts/opencode-server.sh --status   # status only
#   scripts/opencode-server.sh --start    # also start the service if it is not running
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${OPENCODE_ENV_FILE:-$ROOT/.env}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}"
SERVICE_FILE="$STATE_DIR/opencode/service.json"
LOG_FILE="${OPENCODE_LOG:-/tmp/opencode-server.log}"

ASSUME_YES=0
STATUS_ONLY=0
START=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --status) STATUS_ONLY=1 ;;
    --start) START=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

json_field() { # <file> <field>
  node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j[process.argv[2]]??""))}catch{}' "$1" "$2" 2>/dev/null
}

probe() { # <url> <password> -> /api/info http status
  curl -s -m 4 -o /dev/null -w '%{http_code}' -u "opencode:$2" "$1/api/info" 2>/dev/null || echo 000
}

env_value() { # <key>
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true
}

set_env() { # <key> <value>
  node -e '
    const fs = require("fs");
    const [file, key, value] = process.argv.slice(1);
    let lines = fs.readFileSync(file, "utf8").split("\n");
    let found = false;
    lines = lines.map((l) => {
      if (l.startsWith(key + "=")) { found = true; return key + "=" + value; }
      return l;
    });
    if (!found) lines.push(key + "=" + value);
    fs.writeFileSync(file, lines.join("\n"));
  ' "$ENV_FILE" "$1" "$2"
}

read_service() {
  RUN_URL=""; RUN_PW=""; RUN_PID=""; ALIVE=0
  [ -f "$SERVICE_FILE" ] || return 0
  RUN_URL="$(json_field "$SERVICE_FILE" url)"
  RUN_PW="$(json_field "$SERVICE_FILE" password)"
  RUN_PID="$(json_field "$SERVICE_FILE" pid)"
  if [ -n "$RUN_PID" ] && kill -0 "$RUN_PID" 2>/dev/null; then ALIVE=1; fi
}

start_service() {
  echo "→ starting 'opencode serve --service' …"
  nohup opencode serve --service >"$LOG_FILE" 2>&1 &
  for _ in $(seq 1 30); do
    sleep 1
    read_service
    if [ "$ALIVE" = 1 ] && [ "$(probe "$RUN_URL" "$RUN_PW")" = "200" ]; then
      echo "✅ OpenCode service up at $RUN_URL"
      return 0
    fi
  done
  echo "⚠ could not confirm startup; see $LOG_FILE" >&2
  return 1
}

read_service

if [ "$STATUS_ONLY" = 1 ]; then
  echo "service.json           : $SERVICE_FILE"
  if [ "$ALIVE" = 1 ]; then
    echo "running                : yes ($RUN_URL, pid $RUN_PID)"
    echo "service password       : ${RUN_PW:0:4}… (len ${#RUN_PW})"
  else
    echo "running                : no"
  fi
  env_pw="$(env_value OPENCODE_PASSWORD || true)"
  echo ".env OPENCODE_PASSWORD : ${env_pw:+${env_pw:0:4}… (len ${#env_pw})}"
  echo ".env OPENCODE_URL      : $(env_value OPENCODE_URL || echo '(unset)')"
  if [ "$ALIVE" = 1 ]; then
    echo "probe with .env pw     : $(probe "$RUN_URL" "$env_pw")"
  fi
  exit 0
fi

if [ "$ALIVE" != 1 ]; then
  if [ "$START" = 1 ] || [ "$ASSUME_YES" = 1 ]; then
    start_service
    read_service
  else
    echo "OpenCode service is not running. Re-run with --start to launch it."
    exit 0
  fi
fi

PORT="${RUN_URL##*:}"
WANT_URL="http://host.docker.internal:${PORT}"
CUR_PW="$(env_value OPENCODE_PASSWORD || true)"
CUR_URL="$(env_value OPENCODE_URL || true)"

if [ "$CUR_PW" = "$RUN_PW" ] && [ "$CUR_URL" = "$WANT_URL" ]; then
  echo "✅ .env already matches the running OpenCode service ($RUN_URL)."
  exit 0
fi

echo "Sync .env with the running OpenCode service:"
echo "  OPENCODE_PASSWORD  ${CUR_PW:+${CUR_PW:0:4}…}  ->  ${RUN_PW:0:4}…   (service password)"
echo "  OPENCODE_URL       ${CUR_URL:-<unset>}  ->  $WANT_URL"
if [ "$ASSUME_YES" != 1 ]; then
  printf "Apply? [y/N] "
  read -r answer </dev/tty || answer=""
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Cancelled."; exit 0 ;;
  esac
fi

set_env OPENCODE_PASSWORD "$RUN_PW"
set_env OPENCODE_URL "$WANT_URL"
echo "✅ .env updated. Recreate the Docker container to pick it up:"
echo "   docker compose up -d --force-recreate"
