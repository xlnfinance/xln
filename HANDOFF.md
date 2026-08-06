# Handoff — cross-J delivery, scenario coverage, hash-ladder registry

Owner goal: get the release bar green. Owner's ordering, stated explicitly:
**scenarios first for every XLN case, e2e as a second wave** (e2e is there to
catch frontend bugs). Test on local anvils only — no Sepolia. Changing and
redeploying contracts is authorised.

Repo state at handoff: `main` = `6784d1b13`, pushed, working tree clean.
`bun run check` is EXIT 0 (Solidity invariants 15/15, runtime types clean, all
`check:src` gates, frontend). `test:e2e:fast` is **red** — see §3.

---

## 1. What landed this session

Nine commits on `main`, each with its reasoning in the commit body.

| Commit | What |
|---|---|
| `87c645efd` | MM bootstrap retry: `attemptedBootstrapIntentOrderIds` was a permanent `Set`, so one failed attempt blacklisted that book slot for the whole run. Now a `Map<offerId, ts>` expiring after `MARKET_MAKER_BOOTSTRAP_INTENT_RETRY_MS`. |
| `f8d613ccb` | `check:english-source` was red on `main` and failed all of `bun run check`: a committed build artifact (`ui/public/runtime.js`, Russian BIP39 wordlist) and a Russian quote in the old handoff. |
| `36a56f6e8` | Replaced the wrong root-cause note in `todo.md`. |
| `65e973a54` | Two concurrent cross-j cohorts cancelled each other's pairing; orphaned legs were deferred forever. |
| `e83c18792` | A signed cross-j intent was counted as bootstrap progress, so any failed spec became permanently ineligible. |
| `42d190176` | A duplicate cross-j intent killed the hub process (`RUNTIME_ENTITY_INPUT_APPLY_FAILED` → `RUNTIME_LOOP_ERROR`) and took the mesh with it. |
| `1fd8af5f3` | Absorbing that duplicate silently was equally wrong — the submitter stayed blind and resent forever. It now re-announces. |
| `febfa922f` | The stall capsule now carries the stuck outputs themselves, not just counts. |
| `6784d1b13` | `bootScenario` accepted `rpcUrl` but the adapter always used ambient `ANVIL_RPC`, so a second jurisdiction in one scenario process was inexpressible. |

Two of these carry regression tests verified in both directions (they fail on the
parent commit with an exact string): the cohort matching test fails with
`Expected: 4, Received: 3`, the hub idempotence test with
`CROSS_J_RAW_PREPARE_AFTER_MATERIALIZATION`.

---

## 2. Measured facts — do not re-derive these

- Healthy bootstrap on this box, `bun run prod:bootstrap:bench --runs=1`:
  **~110s total**, of which the MM offer-depth phase is **~71s (64%)**.
  Reproducible: 110.2s and 111.0s across two runs.
- `reset_market_maker` in the failing gate: **280762ms** (loaded box) and
  **280798ms** (idle box). A 36ms spread across two machine states is a fixed
  deadline, not slow work. **Machine contention is not the cause.**
- The commit `87c645efd` has **no** effect on bootstrap time (110.2s vs 111.0s
  baseline). It fixes a failure mode, not speed. Do not credit it with the
  blocker.
- `output-routing-reliable-order.test.ts` is **baseline-red on clean `main`:
  12 pass / 19 fail**. Always diff against a stashed baseline before concluding
  you broke something — this cost a wrongly reverted fix here.

---

## 3. The live blocker

MM never completes `bootstrap-cross`: 0 of 6 routes, while same-chain depth is
fully ready (60 offers/hub, all pairs 20/20). Two shapes seen, run to run:

1. The MM selects 45 intents, submits, they never become offers, the retry
   window expires, it selects **the same 45** — 118 times in one run. The churn
   keeps changing the progress signature, so the stall watchdog does not fire.
2. The other direction reports `candidateCount: 0` and `coverageGaps: 0` with
   135 offers still unsent, because pending cross requests count as progress via
   `getPendingCrossRequestOrderIds` and never clear.

Progress accounting has now been patched four times. **The root is not the
accounting** — it is that a submitted cross-j intent never materialises. The
mesh does not capture hub-side logs, which is why this could not be traced
further from e2e artifacts.

Structural facts established by reading the code, worth keeping:

- `outputEnvelopeGroupKey` (`runtime/runtime/delivery/dispatch.ts:92`) is the
  target `runtimeId` **alone**, and atomic cross-j pairing runs strictly inside
  one such group. An atomic cohort addressed to two Runtimes can never be
  complete by construction.
- An incomplete atomic unit is excluded from retry scheduling
  (`pending.ts:609`, `if (!unit.complete) return []`) **and** parked in
  `waiting` unconditionally (`pending.ts:547`). Both are deliberate; together
  they make any incomplete cohort a silent permanent wedge.
- The MM stall watchdog's backlog exemption (`mm-node-run.ts:1411`) never
  expires while a pending output persists, because `workStartedAt` advances on
  every `process()` tick. That is why the failure was 280s of silence rather
  than a 60s `MARKET_MAKER_BOOTSTRAP_STALLED`.

**Owner decision: atomic cohort delivery stays.** It is what guarantees the two
legs move symmetrically. Fix it; do not design it away.

---

## 4. The next task, in order

1. **Finish the cross-jurisdiction scenario.** The repo had zero of them (15
   scenarios, none cover cross-j) — that gap is why this area rotted.

   `runtime/scenarios/cross-j.ts` exists and gets as far as applying the intent,
   then stops at `CROSS_J_OWNER_RUNTIME_COLLISION`, because it runs everything
   in one process. That is the protocol refusing the shape, not a bug to work
   around: `resolveCrossJurisdictionRuntimeTopology`
   (`runtime/extensions/cross-j/boundary.ts`) requires both users on one
   Runtime, both hubs on another, and the two distinct.

   **Build it the way this repo already does multi-Runtime — do not invent an
   in-process bridge.** `p2p-relay.ts` is the orchestrator and `p2p-node.ts` is
   the node; copy that shape:
   - the orchestrator reserves a free relay port, `spawn`s node processes with
     `--role/--seed/--relay-url`, waits on stdout markers via
     `waitForLineOrError`, and `killAll`s at the end;
   - each node is one process: `main(seed)` → `startRuntimeLoop(env)` →
     `startP2P(env, { relayUrls, seedRuntimeIds, advertiseEntityIds })`, each
     with its own `XLN_DB_PATH`.

   Two facts already established the hard way, worth not rediscovering:
   - `P2PConfig` carries **no** relay port or host. The relay *server* is a
     separate thing `p2p-node.ts` starts when given `--relay-port`; that part
     must be lifted into the cross-j node before its hub role can host it.
   - The second node must not redeploy the stacks or it lands on different
     contract addresses. Connect via `JAdapterConfig.fromReplica`
     (`{ name, chainId, rpcs, contracts }`) and have the hub node publish its
     deployed addresses on stdout for the orchestrator to pass along.
2. Fix the delivery bug it exposes.
3. Extend to the flagship case the owner named: **MM disputes with two-sided
   cross swaps** — the original problem, where a market maker loses its receive
   legs when one bilateral account is disputed. Every edge case, at scenario
   level, not e2e.
4. Then the hash-ladder registry — spec in
   [`docs/hashladder-registry-spec.md`](docs/hashladder-registry-spec.md),
   design settled with the owner. Needs a Depository redeploy.
5. e2e last, as the second wave.

---

## 5. Environment traps — read before running anything

1. **Machine-wide port slots.** The runner leases one of 7 stacks (bases
   20000/20020/…/20120). Another Claude session may hold some; its anvils live
   under `/tmp/xln-repro/` — **do not kill those**. Run `CI=true bun run
   test:e2e:fast` to force one stack at a time.
2. **Reap your own orphans before every run**, and check the ports themselves,
   not just the guard port:
   ```bash
   for base in 20000 20020 20040 20060 20080 20100 20120; do
     for off in 0 1 2 4 12; do lsof -ti:$((base+off)); done
   done
   ```
   Kill only processes whose args do **not** contain `xln-repro`.
3. **Never edit any tracked file while an e2e run is in flight.** The runner
   hashes every file from `git ls-files` and aborts with `E2E_CODE_DRIFT` —
   editing `todo.md` mid-run is enough.
4. **Stale artifact lock.** `.logs/.test-artifact-run-lock.json` can outlive its
   process. Check the pid is dead, then delete.
5. Scenario runs need `XLN_RUNTIME_SEED`, e.g.
   `XLN_RUNTIME_SEED=dev-scenario-seed bun runtime/scenarios/run.ts settle`.
6. Diagnostics worth knowing: the MM writes
   `<shard>/rdb/mesh/mm/bootstrap-events.jsonl` (per-wave candidate/selected
   counts, and the full stall capsule on timeout), and hub crashes land in
   `<shard>/rdb/mesh/.control-plane/diagnostics/`.

---

## 6. Invariants that must NOT be relaxed to go green

- **`forwarded: for=_xln_public_proxy`** (`runtime/orchestrator/proxy.ts:39`):
  everything the orchestrator forwards is marked public so a hub never treats it
  as a local operator. Operator-only routes must be asked of the hub's own port.
- **Certified frame conflict guard** (`runtime/storage/index.ts`): compares
  `frame.hash`, not the whole link, because validators legitimately hold
  different certificate variants of the same committed frame. A differing hash
  is a real fork and still conflicts.
- Do not close the blocker by raising `--stack-timeout-ms` or by making the
  shard deadline progress-aware. Both only reword the failure.

Ruled out, do not re-attempt: adding a WebSocket proxy to `vite preview`
(`preview.proxy` already carries `/relay` with `ws: true`; a second listener
interleaves frames).

---

## 7. Open questions already filed

- A cross-j certified command lost in flight is unrecoverable: once a user
  Entity has committed `crossJurisdictionAuthorizations[orderId]`, a resubmitted
  identical intent early-returns without re-emitting the certified command, and
  nothing prunes the authorization. Consensus-critical (the map is in the state
  root). Recorded in `todo.md` with file and line references.
