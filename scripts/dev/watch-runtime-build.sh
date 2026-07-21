#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

bun --no-orphans build runtime/runtime.ts \
  --target=browser \
  --outfile=frontend/static/runtime.js \
  --minify \
  --external http \
  --external https \
  --external zlib \
  --external fs \
  --external path \
  --external crypto \
  --external stream \
  --external buffer \
  --external url \
  --external net \
  --external tls \
  --external os \
  --external util \
  --watch \
  2>&1 | while IFS= read -r line; do
    if [[ -z "${line//[[:space:]]/}" ]]; then
      continue
    fi
    printf '%s\n' "$line"
  done
