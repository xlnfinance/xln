#!/bin/bash
# XLN secondary persistent local chain used as the production Tron simulator.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$REPO_ROOT/scripts/lib/port-layout.sh"

export ANVIL_PORT="${ANVIL2_PORT:-$(xln_rpc2_port)}"
export ANVIL_CHAIN_ID="${ANVIL2_CHAIN_ID:-31338}"
export ANVIL_STATE="${ANVIL2_STATE:-$REPO_ROOT/data/anvil2-state.json}"
export ANVIL_LOG="${ANVIL2_LOG:-$REPO_ROOT/logs/anvil2.log}"

exec "$REPO_ROOT/scripts/start-anvil.sh" "$@"
