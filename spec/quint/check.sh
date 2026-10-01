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
MODULES=${MODULES:-account chain settle entity jbatch runtime}

# quint test runs only the `run` definitions whose name ends in Test. A `run` without the suffix never executes and passes for ever, so
# every file must declare only Test-suffixed runs, and the number of tests that ran must equal the number declared (an assertion with
# nothing to check is a trap).
run_tests() {
  local f=$1
  local bad declared out ran
  bad=$(grep -E '^[[:space:]]*run[[:space:]]+[A-Za-z0-9_]+' "$f" | grep -vE '^[[:space:]]*run[[:space:]]+[A-Za-z0-9_]*Test\b' || true)
  if [ -n "$bad" ]; then
    echo "FAIL $f: a run without the Test suffix never executes:"; echo "$bad"; exit 1
  fi
  declared=$(grep -cE '^[[:space:]]*run[[:space:]]+[A-Za-z0-9_]*Test\b' "$f" || true)
  out=$($Q test "$f" --backend typescript --max-samples 10 2>&1) || { echo "$out"; exit 1; }
  echo "$out" | tail -3
  ran=$(echo "$out" | grep -cE '^[[:space:]]+ok ' || true)
  if [ "$ran" != "$declared" ]; then
    echo "FAIL $f: $declared tests declared, $ran ran"; exit 1
  fi
}

echo "== params: the numbers the layers share"
run_tests params_test.qnt

echo "== compose: what the Account layer co-signs, settled by the chain's payout"
run_tests compose.qnt

for m in $MODULES; do
  echo "== $m: typecheck"
  # per-module entry points: action names, the invariant that bundles the properties, trace length
  init=init; step=step; inv=safe; steps=40
  case "$m" in
    chain)  steps=16 ;;                                  # the chain clock is short; longer traces only repeat finalizes
    settle) init=winit; step=wstep; inv=wsafe; steps=25 ;;
    entity) steps=25 ;;
    jbatch) steps=25 ;;
    runtime) steps=30 ;;
  esac
  $Q typecheck "$m.qnt"
  if [ -f "${m}_test.qnt" ]; then
    echo "== $m: scenario tests"
    run_tests "${m}_test.qnt"
  fi
  echo "== $m: invariant '$inv' over $SAMPLES traces of $steps steps"
  $Q run "$m.qnt" --backend typescript --init $init --step $step --invariant $inv --max-steps $steps --max-samples "$SAMPLES" --seed 0x1 --verbosity 1 \
    | grep -E "^\[|Use --seed"
  if [ "$m" = chain ]; then
    echo "== $m: invariant '$inv' from an Account that just opened epoch 1 with no signed frame (initE1)"
    $Q run "$m.qnt" --backend typescript --init initE1 --step $step --invariant $inv --max-steps $steps --max-samples "$SAMPLES" --seed 0x1 --verbosity 1 \
      | grep -E "^\[|Use --seed"
  fi
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
