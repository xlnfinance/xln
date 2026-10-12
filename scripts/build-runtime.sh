#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OUT="${XLN_RUNTIME_BUNDLE_OUT:-frontend/static/runtime.js}"
WORKER_OUT="${XLN_ACCOUNT_WORKER_BUNDLE_OUT:-$(dirname "$OUT")/account-worker.js}"

mkdir -p "$(dirname "$OUT")" "$(dirname "$WORKER_OUT")"

echo "[build-runtime] bundling core/api/public/browser.ts -> $OUT"
bun build core/api/public/browser.ts --target=browser --outfile="$OUT" --minify \
  --define 'process.env.NODE_ENV="production"' \
  --external http --external https --external zlib \
  --external fs --external path \
  --external stream --external buffer --external url \
  --external net --external tls --external os --external util \
  --external node:module

echo "[build-runtime] bundling core/runtime/workers/account/worker.ts -> $WORKER_OUT"
bun build core/runtime/workers/account/worker.ts --target=browser --outfile="$WORKER_OUT" --minify \
  --define 'process.env.NODE_ENV="production"' \
  --external http --external https --external zlib \
  --external fs --external path \
  --external stream --external buffer --external url \
  --external net --external tls --external os --external util \
  --external node:module

echo "[build-runtime] done: $OUT + $WORKER_OUT"
