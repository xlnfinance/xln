#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OUT_STATIC="frontend/static/runtime.js"
OUT_PUBLIC="frontend/public/runtime.js"
OUT_BUILD="frontend/build/runtime.js"

mkdir -p frontend/public frontend/static frontend/build

echo "[build-runtime] bundling runtime/runtime.ts -> $OUT_STATIC"
bun build runtime/runtime.ts --target=browser --outfile="$OUT_STATIC" --minify \
  --external http --external https --external zlib \
  --external fs --external path --external crypto \
  --external stream --external buffer --external url \
  --external net --external tls --external os --external util

cp "$OUT_STATIC" "$OUT_PUBLIC"
echo "[build-runtime] copied bundle -> $OUT_PUBLIC"

cp "$OUT_STATIC" "$OUT_BUILD"
echo "[build-runtime] copied bundle -> $OUT_BUILD"
