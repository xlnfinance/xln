#!/usr/bin/env bash
# Pin the rscore sources that proofs/kani verifies to an immutable committed
# SHA (parallel-task working-tree WIP must not drift the verification subject).
#
# Regenerates proofs/kani/pinned-rscore/ deterministically:
#   ./pin-rscore.sh            (uses the default PIN_SHA below)
#   PIN_SHA=<sha> ./pin-rscore.sh
#
# The extracted tree is the complete committed rscore workspace, so the
# engine/protocol/hanko/crypto path dependencies of the equivalence tests
# resolve consistently at the pinned SHA.
set -euo pipefail

PIN_SHA_DEFAULT="13f51950a483dc5b721c722259881fb089768368"
PIN_SHA="${PIN_SHA:-$PIN_SHA_DEFAULT}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$ROOT/proofs/kani/pinned-rscore"

echo "Pinning rscore to $PIN_SHA"
rm -rf "$DEST"
mkdir -p "$DEST"

git -C "$ROOT" archive "$PIN_SHA" rscore | tar -x -C "$DEST"
git -C "$ROOT" rev-parse "$PIN_SHA" > "$DEST/PINNED_SHA"

# Record the hashes of the radix sources compiled into the proof crate
# (the verification subject for C6) plus the engine delta math (C5 subject).
cd "$DEST"
{
  echo "rscore pinned to: $(cat PINNED_SHA)"
  shasum -a 256 \
    rscore/crates/protocol/src/radix.rs \
    rscore/crates/protocol/src/persistent.rs \
    rscore/crates/protocol/src/persistent/node.rs \
    rscore/crates/protocol/src/persistent/records.rs \
    rscore/crates/engine/src/state/delta.rs
} > "$ROOT/proofs/kani/pinned-hashes.txt"

cat "$ROOT/proofs/kani/pinned-hashes.txt"
