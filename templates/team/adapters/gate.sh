#!/usr/bin/env bash
# The checks CI runs, in the same order, on the checkout it's run in (a member's worktree, or the merge queue's
# scratch copy). Exit 0 only when every check passes. Prints one line per check and the tail of the first failure.
#
#   .e9g/adapters/gate.sh            every check (the merge queue runs this on the merged result)
#   .e9g/adapters/gate.sh --quick    the fast subset a builder runs before finishing
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 2
LOGS="$(mktemp -d)"
trap 'rm -rf "$LOGS"' EXIT

check() {
  local name="$1" started
  shift
  started=$(date +%s)
  if "$@" >"$LOGS/$name.log" 2>&1; then
    echo "gate: $name ok ($(($(date +%s) - started))s)"
    return 0
  fi
  echo "gate: $name FAILED ($(($(date +%s) - started))s)"
  tail -n 40 "$LOGS/$name.log"
  exit 1
}

{{QUICK_CHECKS}}
if [ "${1:-}" != "--quick" ]; then
{{FULL_CHECKS}}
fi
echo "gate: all checks passed"
