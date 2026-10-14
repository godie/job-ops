#!/usr/bin/env bash
#
# opencode-server.sh — make a local OpenCode server reachable by JobOps.
#
# Ensures an OpenCode 2.x server is running with the password from .env
# (OPENCODE_PASSWORD) and that its service registration (service.json) matches,
# so the JobOps "OpenCode" provider can discover it (host app) or reach it via
# OPENCODE_URL / OPENCODE_PASSWORD (e.g. from Docker).
#
# Usage:
#   scripts/opencode-server.sh            # check; start, or ask before restarting
#   scripts/opencode-server.sh --yes      # no prompt; restart if the password differs
#   scripts/opencode-server.sh --status   # print status only (no changes)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${OPENCODE_ENV_FILE:-$ROOT/.env}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}"
SERVICE_FILE="$STATE_DIR/opencode/service.json"
LOG_FILE="${OPENCODE_LOG:-/tmp/opencode-server.log}"

ASSUME_YES=0
STATUS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --status) STATUS_ONLY=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

read_env() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

json_field() { # <file> <field>
  node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j[process.argv[2]]??""))}catch{}' "$1" "$2" 2>/dev/null
}

probe() { # <url> <password> -> http status of /api/info
  curl -s -m 4 -o /dev/null -w '%{http_code}' -u "opencode:$2" "$1/api/info" 2>/dev/null || echo 000
}

PASSWORD="$(read_env OPENCODE_PASSWORD || true)"
if [ -z "$PASSWORD" ]; then
  echo "ERROR: OPENCODE_PASSWORD is not set in $ENV_FILE" >&2
  echo "Add a line:  OPENCODE_PASSWORD=your-password" >&2
  exit 1
fi

RUN_URL=""; RUN_PW=""; RUN_PID=""
if [ -f "$SERVICE_FILE" ]; then
  RUN_URL="$(json_field "$SERVICE_FILE" url)"
  RUN_PW="$(json_field "$SERVICE_FILE" password)"
  RUN_PID="$(json_field "$SERVICE_FILE" pid)"
fi
ALIVE=0
if [ -n "$RUN_PID" ] && kill -0 "$RUN_PID" 2>/dev/null; then ALIVE=1; fi

print_status() {
  echo "env file      : $ENV_FILE"
  echo "service.json  : $SERVICE_FILE"
  echo "env password  : ${PASSWORD:0:4}… (len ${#PASSWORD})"
  if [ "$ALIVE" = 1 ]; then
    echo "running       : yes (pid $RUN_PID, url $RUN_URL)"
    echo "running pw    : ${RUN_PW:0:4}… (len ${#RUN_PW})"
    if [ "$RUN_PW" = "$PASSWORD" ]; then
      echo "password match: yes"
    else
      echo "password match: NO (server uses a different password)"
    fi
    echo "probe /api/info (env password): $(probe "$RUN_URL" "$PASSWORD")"
  else
    echo "running       : no"
  fi
}

if [ "$STATUS_ONLY" = 1 ]; then
  print_status
  exit 0
fi

start_server() {
  echo "→ starting 'opencode serve --service' with OPENCODE_PASSWORD from .env …"
  OPENCODE_PASSWORD="$PASSWORD" nohup opencode serve --service >"$LOG_FILE" 2>&1 &
  for _ in $(seq 1 30); do
    sleep 1
    [ -f "$SERVICE_FILE" ] || continue
    local url pw
    url="$(json_field "$SERVICE_FILE" url)"
    pw="$(json_field "$SERVICE_FILE" password)"
    if [ -n "$url" ] && [ "$(probe "$url" "$pw")" = "200" ]; then
      echo "✅ OpenCode server up at $url"
      return 0
    fi
  done
  echo "⚠ could not confirm startup; check $LOG_FILE" >&2
  return 1
}

report_jobops() {
  local url="$1"
  local port="${url##*:}"
  echo
  echo "JobOps configuration:"
  echo "  • Host app (dev): discovery is automatic via service.json — nothing to set."
  echo "  • Docker app:    set in .env and recreate the container:"
  echo "      OPENCODE_URL=http://host.docker.internal:${port}"
  echo "      OPENCODE_PASSWORD=<same value as above>"
}

if [ "$ALIVE" = 1 ] && [ "$RUN_PW" = "$PASSWORD" ]; then
  echo "✅ Already running with the .env password ($RUN_URL)."
  report_jobops "$RUN_URL"
  exit 0
fi

if [ "$ALIVE" = 1 ]; then
  echo "The OpenCode server is running at $RUN_URL but with a DIFFERENT password."
  if [ "$ASSUME_YES" != 1 ]; then
    printf "Restart it with the .env password? [y/N] "
    read -r answer </dev/tty || answer=""
    case "$answer" in
      y|Y|yes|YES) ;;
      *) echo "Cancelled."; exit 0 ;;
    esac
  fi
  echo "→ stopping service (pid $RUN_PID) …"
  kill "$RUN_PID" 2>/dev/null || true
  for _ in $(seq 1 15); do kill -0 "$RUN_PID" 2>/dev/null || break; sleep 1; done
  kill -9 "$RUN_PID" 2>/dev/null || true
  rm -f "$SERVICE_FILE" 2>/dev/null || true
fi

start_server
URL="$(json_field "$SERVICE_FILE" url)"
report_jobops "${URL:-http://127.0.0.1:49374}"
