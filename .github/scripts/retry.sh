#!/usr/bin/env bash
# Run a command up to three times, waiting a little longer after each failure, so a mirror that times out once does not
# turn a gate lane red. The command is whatever follows:   bash .github/scripts/retry.sh uv tool install ast-grep-cli==0.45.3
# RETRY_DELAY is the first wait in seconds (default 15; the tests set it to 0).
set -u
readonly ATTEMPTS=3
for attempt in $(seq 1 "$ATTEMPTS"); do
  if "$@"; then
    exit 0
  fi
  echo "retry.sh: attempt $attempt of $ATTEMPTS failed: $*" >&2
  [ "$attempt" -lt "$ATTEMPTS" ] && sleep $((attempt * ${RETRY_DELAY:-15}))
done
exit 1
