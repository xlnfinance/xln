#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OUT="frontend/static/runtime.js"

mkdir -p frontend/static

echo "[build-runtime] bundling runtime/runtime.ts -> $OUT"
bun build runtime/runtime.ts --target=browser --outfile="$OUT" --minify \
  --external http --external https --external zlib \
  --external fs --external path --external crypto \
  --external stream --external buffer --external url \
  --external net --external tls --external os --external util

echo "[build-runtime] done: $OUT"
