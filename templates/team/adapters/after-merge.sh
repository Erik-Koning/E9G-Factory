#!/usr/bin/env bash
# After a merge into the integration branch: e9g merge runs this outside the merge lock, under the app lock, with
# BEFORE and AFTER (the commits the branch moved between) and E9G_LIGHT=1 when the planner asked for a light run.
# Rebuild and restart the team's app, then recheck. Lines starting "after:" go into the merge's report.
set -uo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT" || exit 2
{{INSTALL}}
"$ROOT/.e9g/adapters/env.sh" restart >/dev/null || { echo "after: the app didn't restart"; exit 1; }
echo "after: app restarted at ${AFTER:0:7}"
