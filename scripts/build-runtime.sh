#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OUT_PUBLIC="frontend/public/runtime.js"
OUT_STATIC="frontend/static/runtime.js"

mkdir -p frontend/public frontend/static

echo "[build-runtime] bundling runtime/runtime.ts -> $OUT_PUBLIC"
bun build runtime/runtime.ts --target=browser --outfile="$OUT_PUBLIC" --minify \
  --external http --external https --external zlib \
  --external fs --external path --external crypto \
  --external stream --external buffer --external url \
  --external net --external tls --external os --external util

cp "$OUT_PUBLIC" "$OUT_STATIC"
echo "[build-runtime] copied bundle -> $OUT_STATIC"

