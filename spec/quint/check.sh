#!/usr/bin/env bash
# Everything that must pass before a Quint spec change is committed.
#   ./check.sh            typecheck, scenario tests, invariants and witnesses by simulation
#   MUTANTS=1 ./check.sh also run every mutant (slow: minutes per module)
#   SAMPLES=2000 ./check.sh more simulation traces
# Use the typescript backend: the default rust evaluator is downloaded from GitHub releases, which the sandbox
# proxy refuses (`Release v0.7.0 not found: Failed to fetch from GitHub: Forbidden`).
set -euo pipefail
cd "$(dirname "$0")"
Q=./node_modules/.bin/quint
SAMPLES=${SAMPLES:-500}
MODULES=${MODULES:-account chain settle}

for m in $MODULES; do
  echo "== $m: typecheck"
  # per-module entry points: action names, the invariant that bundles the properties, trace length
  init=init; step=step; inv=safe; steps=40
  case "$m" in
    chain)  steps=16 ;;                                  # the chain clock is short; longer traces only repeat finalizes
    settle) init=winit; step=wstep; inv=wsafe; steps=25 ;;
  esac
  $Q typecheck "$m.qnt"
  if [ -f "${m}_test.qnt" ]; then
    echo "== $m: scenario tests"
    $Q test "${m}_test.qnt" --backend typescript --max-samples 10
  fi
  echo "== $m: invariant '$inv' over $SAMPLES traces of $steps steps"
  $Q run "$m.qnt" --backend typescript --init $init --step $step --invariant $inv --max-steps $steps --max-samples "$SAMPLES" --seed 0x1 --verbosity 1 \
    | grep -E "^\[|Use --seed"
  echo "== $m: witnesses (each must be violated, or the path is unreachable)"
  for w in $(grep -oE '^  val w_[a-z_]+' "$m.qnt" | awk '{print $2}'); do
    out=$($Q run "$m.qnt" --backend typescript --init $init --step $step --invariant "$w" --max-steps $steps --max-samples 3000 --seed 0x7 --verbosity 1 2>&1 || true)
    if echo "$out" | grep -q "Invariant violated"; then
      echo "   reached  $w"
    else
      echo "   UNREACHED $w"; exit 1
    fi
  done
  if [ "${MUTANTS:-0}" = "1" ]; then
    echo "== $m: mutants"
    MUTANT_STEPS=$steps python3 mutants/run.py "$m"
  fi
done
echo "check.sh: all green"
