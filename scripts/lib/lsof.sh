#!/bin/sh
set -eu

# macOS lsof closes every possible inherited descriptor before parsing flags.
# Bound only this scanner child, never the runtime or the inspected processes.
scanner_limit=$(ulimit -n)
if [ "$scanner_limit" = unlimited ] || [ "$scanner_limit" -gt 65536 ]; then
  ulimit -n 65536
fi
exec lsof "$@"
