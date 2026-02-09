#!/bin/bash
# Deploy server to production with fresh DB state (wrapper).
# Usage: ./scripts/deploy-fresh.sh [--frontend]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

exec ./deploy.sh --remote root@xln.finance --push --fresh "$@"
