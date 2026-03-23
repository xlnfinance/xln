#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$REPO_ROOT/scripts/lib/port-layout.sh"

RPC_PORT="$(( $(xln_rpc_port) + 1 ))"

cd "$REPO_ROOT"

exec bun runtime/scripts/dev-anvil-stack.ts \
  --spawn-anvil \
  --keep-alive \
  --port "$RPC_PORT" \
  --name "Localhost 2"
