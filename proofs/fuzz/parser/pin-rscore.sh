#!/usr/bin/env bash
# Pin the fuzz crate's rscore dependencies to an immutable commit extraction.
#
# Why: proofs/readme.md pins SHA 80924b035f363d4ad8f4a8c08e6f39dcc7736a78 and
# requires every report to record the actual tree state. The live working tree
# can carry uncommitted parallel-task edits (it did during the C7 runs), so
# measured runs must build rscore exactly as committed at the pinned SHA.
#
# Usage:
#   ./pin-rscore.sh <commit-sha>   # extract and swap deps to the pinned copy
#   ./pin-rscore.sh restore        # swap deps back to the live tree
set -euo pipefail
cd "$(dirname "$0")"
PIN_DIR=".rscore-pinned"

if [ "${1:-}" = "restore" ]; then
  python3 - <<'EOF'
path = "fuzz/Cargo.toml"
text = open(path).read()
text = text.replace(f'path = ".rscore-pinned/rscore/crates/', 'path = "../../../../rscore/crates/')
open(path, "w").write(text)
EOF
  echo "restored live-tree rscore paths"
  exit 0
fi

SHA="${1:?usage: pin-rscore.sh <commit-sha>|restore}"
rm -rf "$PIN_DIR"
mkdir -p "$PIN_DIR"
git -C ../../.. archive "$SHA" rscore | tar -x -C "$PIN_DIR"
python3 - <<'EOF'
path = "fuzz/Cargo.toml"
text = open(path).read()
text = text.replace('path = "../../../../rscore/crates/', f'path = ".rscore-pinned/rscore/crates/')
open(path, "w").write(text)
EOF
echo "pinned rscore deps to $PIN_DIR ($SHA)"
