#!/usr/bin/env bash
# The team's own environment: the product running on the team's own port with its own data, apart from the
# operator's dev server and databases. The planner runs up, reset, restart and down (e9g env …); anyone runs
# status. State lives in .e9g/run/env/ in the team's checkout.
#
#   .e9g/adapters/env.sh up|down|restart|reset|status
set -uo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT" || exit 2
RUN="$ROOT/.e9g/run/env"
PORT="${E9G_APP_PORT:-{{PORT}}}"
URL="http://localhost:$PORT/"
mkdir -p "$RUN"

up() {
  if curl -fsS -o /dev/null --max-time 3 "$URL"; then echo "env: app already up at $URL"; return 0; fi
  {{INSTALL}}
  # The command that serves the app on $PORT. The setup agent fits it to the project.
  (PORT="$PORT" nohup {{SERVE}} >"$RUN/app.log" 2>&1 & echo $! >"$RUN/app.pid")
  for _ in $(seq 1 120); do curl -fsS -o /dev/null --max-time 2 "$URL" && { echo "env: app up at $URL"; return 0; }; sleep 2; done
  echo "env: the app didn't answer at $URL in 4 minutes; see $RUN/app.log" >&2
  return 1
}
down() {
  [ -f "$RUN/app.pid" ] && kill "$(cat "$RUN/app.pid")" 2>/dev/null
  rm -f "$RUN/app.pid"
  echo "env: app stopped"
}
status() {
  if curl -fsS -o /dev/null --max-time 3 "$URL"; then echo "env: app up at $URL"; else echo "env: app down ($URL)"; return 1; fi
}

case "${1:-status}" in
up) up ;;
down) down ;;
restart | reset) down && up ;;
status) status ;;
*) echo "usage: $0 up|down|restart|reset|status" >&2 && exit 2 ;;
esac
