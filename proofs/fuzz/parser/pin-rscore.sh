#!/usr/bin/env bash
# Pin the fuzz crate's rscore dependencies to an immutable commit extraction.
#
# v2 (audit c7-repro A-1): the original in-workspace extraction broke cargo two
# ways — relative path deps resolved against fuzz/ (nonexistent) and the
# extraction inside this crate's workspace tree collided with rscore's own
# workspace inheritance. Extraction now lands in the system temp dir, outside
# any workspace; path deps become absolute. Verified shape: the c7-repro audit
# built and fuzzed from an out-of-tree extraction (proofs/audits/c7-repro).
#
# Usage:
#   ./pin-rscore.sh <commit-sha>   # extract and swap deps to the pinned copy
#   ./pin-rscore.sh restore        # swap deps back to the live tree
set -euo pipefail
cd "$(dirname "$0")"
LIVE='path = "../../../../rscore/crates/'

if [ "${1:-}" = "restore" ]; then
  python3 - "$LIVE" <<'EOF'
import re, sys
live = sys.argv[1]
text = open("fuzz/Cargo.toml").read()
text = re.sub(r'path = "[^"]*rscore/crates/', live, text)
open("fuzz/Cargo.toml", "w").write(text)
EOF
  echo "restored live-tree rscore paths"
  exit 0
fi

SHA="${1:?usage: pin-rscore.sh <commit-sha>|restore}"
PIN_ROOT="$(mktemp -d -t rscore-pin-${SHA:0:9}-XXXXXX)"
git -C ../../.. archive "$SHA" rscore | tar -x -C "$PIN_ROOT"
python3 - "$PIN_ROOT" <<'EOF'
import re, sys
pin = sys.argv[1]
text = open("fuzz/Cargo.toml").read()
text = re.sub(r'path = "[^"]*rscore/crates/', f'path = "{pin}/rscore/crates/', text)
open("fuzz/Cargo.toml", "w").write(text)
print(f"fuzz/Cargo.toml pinned to {pin}/rscore/crates/")
EOF
echo "pinned rscore deps to $PIN_ROOT ($SHA)"
