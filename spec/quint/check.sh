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
DISPUTE=${DISPUTE:-1}          # DISPUTE=0 skips the dispute lifecycle model (its own section below the module loop)

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
# dispute: the lifecycle of one Account across both Entities and the chain (dispute.qnt). It is the one module whose properties are
# EXPECTED to fail: each variant fixes the switches (FREEZE, LIVE, ACCEPT, NOTICE) for a code state, and the table below says which
# property holds there. An expected failure that stops failing means the model or the code moved: read DISPUTE.md and update both.
if [ "$DISPUTE" = 1 ]; then
  echo "== dispute: typecheck, scenario tests per variant, properties per variant"
  declared=$(grep -cE '^[[:space:]]*run[[:space:]]+[A-Za-z0-9_]*Test\b' dispute_test.qnt || true)
  for v in today freeze live decided accept all; do
    $Q typecheck "dispute_$v.qnt"
  done
  for v in today freeze live decided accept all; do
    out=$($Q test dispute_test.qnt --main "${v}_test" --backend typescript --max-samples 1 2>&1) || { echo "$out"; exit 1; }
    ran=$(echo "$out" | grep -cE '^[[:space:]]+ok ' || true)
    [ "$ran" = "$declared" ] || { echo "FAIL dispute_test $v: $declared declared, $ran ran"; exit 1; }
  done
  # variant property expected(ok|violation) samples
  expect() {
    local v=$1 prop=$2 want=$3 n=$4 got
    got=$($Q run "dispute_$v.qnt" --backend typescript --init init --step step --invariant "$prop" --max-steps 70 --max-samples "$n" --seed 0x5 --verbosity 1 2>&1 | grep -oE '^\[(ok|violation)' | tr -d '[' || true)
    if [ "$got" != "$want" ]; then echo "FAIL dispute_$v $prop: expected $want, got ${got:-nothing}"; exit 1; fi
    echo "   $v $prop: $want"
  }
  for v in today freeze live decided accept all; do expect "$v" sane ok "$SAMPLES"; done
  for p in newest_wins no_lock_left no_lock_right no_silent_zeroing; do expect today "$p" violation 2500; done
  expect freeze newest_wins violation 2500; expect freeze no_lock_left violation 2500; expect freeze no_lock_right violation 2500; expect freeze no_silent_zeroing violation 2500
  expect live newest_wins violation 2500; expect live no_lock_left violation 2500; expect live no_lock_right violation 2500; expect live no_silent_zeroing violation 2500
  expect decided newest_wins ok "$SAMPLES"; expect decided no_lock_left violation 2500; expect decided no_lock_right violation 2500; expect decided no_silent_zeroing violation 2500
  for p in newest_wins no_lock_left no_lock_right; do expect accept "$p" ok "$SAMPLES"; expect all "$p" ok "$SAMPLES"; done
  expect accept no_silent_zeroing violation 2500; expect all no_silent_zeroing ok "$SAMPLES"
  echo "== dispute: witnesses (each must be violated, or the path is unreachable)"
  for w in $(grep -oE '^  val w_[a-z_]+' dispute.qnt | awk '{print $2}'); do
    # a counter lapses (is told it lapsed) only in the code of today; every other state of the lifecycle is reached with all fixes in
    v=all; [ "$w" = w_no_counter_lapsed ] && v=today
    out=$($Q run "dispute_$v.qnt" --backend typescript --init init --step step --invariant "$w" --max-steps 70 --max-samples 3000 --seed 0x7 --verbosity 1 2>&1 || true)
    if echo "$out" | grep -q "Invariant violated"; then echo "   reached  $w"; else echo "   UNREACHED $w"; exit 1; fi
  done
fi
# htlc: an HTLC hold across a dispute on a route of two Accounts (htlc.qnt): the hub never pays out more than it collects. Four code variants
# (SEE, DISSOLVE) and one mutant (HOP = 0); the cells are expected results, as for dispute.
if [ "$DISPUTE" = 1 ]; then
  echo "== htlc: typecheck, scenario tests per variant, properties per variant"
  hdeclared=$(grep -cE '^[[:space:]]*run[[:space:]]+[A-Za-z0-9_]*Test\b' htlc_test.qnt || true)
  for v in today see dissolve both hop0; do $Q typecheck "htlc_$v.qnt"; done
  for v in today see dissolve both hop0; do
    out=$($Q test htlc_test.qnt --main "${v}_htlc_test" --backend typescript --max-samples 1 2>&1) || { echo "$out"; exit 1; }
    ran=$(echo "$out" | grep -cE '^[[:space:]]+ok ' || true)
    [ "$ran" = "$hdeclared" ] || { echo "FAIL htlc_test $v: $hdeclared declared, $ran ran"; exit 1; }
  done
  hexpect() {
    local v=$1 prop=$2 want=$3 got
    got=$($Q run "htlc_$v.qnt" --backend typescript --init init --step step --invariant "$prop" --max-steps 50 --max-samples 3000 --seed 0x5 --verbosity 1 2>&1 | grep -oE '^\[(ok|violation)' | tr -d '[' || true)
    if [ "$got" != "$want" ]; then echo "FAIL htlc_$v $prop: expected $want, got ${got:-nothing}"; exit 1; fi
    echo "   $v $prop: $want"
  }
  hexpect today paid_once violation; hexpect today route_safe violation
  hexpect see paid_once violation; hexpect see route_safe violation
  hexpect dissolve paid_once ok; hexpect dissolve route_safe violation
  hexpect both paid_once ok; hexpect both route_safe ok
  # hop0: the claim that lands after the upstream deadline is a schedule (claimNeedsRoomTest, run above), too rare for a random search at this size
  echo "== htlc: witnesses"
  for w in $(grep -oE '^  val w_[a-z_]+' htlc.qnt | awk '{print $2}'); do
    out=$($Q run htlc_both.qnt --backend typescript --init init --step step --invariant "$w" --max-steps 50 --max-samples 3000 --seed 0x7 --verbosity 1 2>&1 || true)
    if echo "$out" | grep -q "Invariant violated"; then echo "   reached  $w"; else echo "   UNREACHED $w"; exit 1; fi
  done
fi
echo "check.sh: all green"
