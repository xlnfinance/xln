# Handoff — XLN release gate + cross-J barrier design

Owner goal, verbatim: **"доделывай все сценарии и е2е до зеленого! нужен релиз"**
(get all scenarios and E2E green for release).

Everything below is verified by running it, not inferred. Repo state at handoff:
`main` = `d9f95421a`, pushed, working tree clean of this work.

---

## 1. Where things stand

### Scenarios — effectively done

- Wired gate `bun run test:scenarios:parallel:isolated` (7 scenarios): **7/7 PASS**.
- Full catalog `bun runtime/scenarios/run.ts all --set=all` (15): **14/15 PASS**.
- The one red is `multi-sig`, which the owner explicitly declared **aspirational**
  — leave it, it is recorded in `todo.md`. It is not in the wired gate.
  Its next error is `RELIABLE_INGRESS_TERMINAL_ORDER_CONFLICT:hash-precommit`.
- Do **not** use `runtime/scenarios/all-scenarios.ts` to judge health. It runs
  in-process with a shared chain and DB; scenarios collide on deployer nonces
  and stores. `runtime/scenarios/run.ts` is the isolated runner (own RPC port
  and DB per worker) and is the real suite.

### E2E — every failing target fixed individually; full-run confirmation outstanding

`test:e2e:fast` is the release gate (owner's choice). It has 18 targets and runs
with `--max-failures=1`, so **only one blocker surfaces per run** — the ten below
were found strictly one at a time, each behind the previous.

Each of these was red and is now green, verified by an isolated single-spec run:

| Target | Isolated run | Root cause |
|---|---|---|
| radapter remote import | PASS 32s | `readRemoteRuntimeRequestFromUrl` strips the capability from the URL as it parses — reading it **consumes** it — and `+layout.svelte` read it twice. The second read saw an empty hash, so the app silently booted an empty local runtime. Regression from `deb7e5347`. |
| payment-smoke | PASS 50s | Browser signs its relay hello for the origin it dials (preview), server answered with its own → `WS_HELLO_AUDIENCE_MISMATCH`, hello never sent, socket closed, **silently** (the error goes to `onError`, nothing logs it). Plus the public faucet is on by default in prod but was off in the stack. |
| custody | PASS 61s | The direct withdrawal POST carried no same-origin headers, so the CSRF guard rejected it 403 **before** the balance check — the assertion "server remains the authoritative fail-closed balance gate" was measuring the wrong gate. |
| lending | PASS 37s | Faucet amount cap of 100 vs scenarios funding 2000+. |
| dispute | PASS 156s | Three walls: operator-only `/api/debug/*` asked through the orchestrator, which **deliberately** stamps forwarded requests as public (`forwarded: for=_xln_public_proxy`); `/api/rpc` has no route (it is `/rpc`); a watcher poll read its whole 256-block range as one JSON-RPC batch, exceeding the proxy's 128-call cap → 413 → fatal watcher exit; and a 256-state chain history window pruned the EntityProvider deployment block that runtime restore re-proves. |
| watchtower-recovery | PASS 62s | Waited on button labels (`Derive wallet`, `Open XLN wallet`, …) that no longer exist; the derive button is labelled by input mode. |

Commits, all on `main`: `6356f2bfe`, `d1903c061`, `53d8e3481`, `8a730c7e2`,
`1bb79bd52`, `c3e6e8b55`, `d9f95421a`, plus `9922a2744` (storage) and the
scenario fixes `5e9fcd8ff`, `9f1a3ca14`, `230b01d75`.

**What is left:** one clean full run of `test:e2e:fast` that gets through all 18
targets. Runs kept aborting on infrastructure, not on tests — see §2.

None of the ten was a regression from this work. `payment-smoke` was explicitly
re-run on the pre-work commit `020b7f32d` and failed identically (66.2s vs 66.8s).

---

## 2. Environment traps that cost hours — read before running anything

1. **Machine-wide port slots.** The runner leases one of 7 stacks
   (`local-test-stack-v1`, bases 20000/20020/…/20120). **A different Claude
   session is holding three of them** (its anvils live under `/tmp/xln-repro/r1..r3`,
   pids were 30089-30091). Do not kill those. With only 4 slots free, the
   default local concurrency of 8 stacks (`run-e2e-fast.ts:93`) exhausts the
   pool and dies with `LOCAL_TEST_PORT_SLOTS_EXHAUSTED` — which looks like a
   test failure and is not. Run `CI=true bun run test:e2e:fast` to force one
   stack at a time.

2. **Reap your own orphans before every run.** Aborted runs leave `anvil`,
   `vite preview`, `orchestrator.ts` and `hub-node.ts` behind holding slot
   ports. The guard port (base+19) can be free while inner ports are held, so
   check the ports themselves:
   ```bash
   for base in 20000 20020 20040 20060 20080 20100 20120; do
     for off in 0 1 2 4 12; do lsof -ti:$((base+off)); done
   done
   ```
   Kill only processes whose args do **not** contain `xln-repro`.

3. **Never edit any file while a run is in flight.** The runner hashes every
   file from `git ls-files` (`e2e-isolated-runtime.ts:187`) and aborts with
   `E2E_CODE_DRIFT` — editing `todo.md` mid-run is enough. The owner noted docs
   should not count; narrowing that hash to code-only is a one-line change but
   weakens the gate, so it was left alone pending their word.

4. **Stale artifact lock.** `.logs/.test-artifact-run-lock.json` can outlive its
   process (`TEST_ARTIFACT_CLEANUP_ACTIVE_RUN`). Check the pid is dead, then
   delete the file.

5. Scenario runs need `XLN_RUNTIME_SEED` set, e.g.
   `XLN_RUNTIME_SEED=dev-scenario-seed bun runtime/scenarios/run.ts`.

---

## 3. Invariants that must NOT be relaxed to make tests pass

Two guards were hit during this work and are **correct**; the tests were wrong:

- **`forwarded: for=_xln_public_proxy`** (`runtime/orchestrator/proxy.ts:39`).
  Everything the orchestrator forwards to a hub is marked as coming from a
  public proxy so the hub never treats it as a local operator. It has its own
  test (`orchestrator-proxy-security.test.ts`). Operator-only routes must be
  asked of the hub's own port instead.
- **Certified frame conflict guard** (`runtime/storage/index.ts`). It now
  compares `frame.hash` rather than the whole link, because validators of one
  Entity legitimately hold different certificate variants of the same committed
  frame and reach the key on different Runtime frames — before the fix, any
  multi-validator Entity failed its first history write. A differing hash is a
  real fork and still conflicts. Do not loosen further.

Also ruled out and reverted — do not re-attempt: adding a WebSocket proxy to
`vite preview`. `preview.proxy` already carries `/relay` with `ws: true` and
vite attaches its upgrade listener lazily; a second listener interleaves frames
and produces `Invalid frame header` / `code=1006`.

---

## 4. Debugging techniques that actually cracked these

- **Probe the page, don't guess.** A `page.evaluate` right after `goto` dumping
  `location.hash` + `localStorage['xln-runtime-adapter-mode']` proved the URL
  was consumed. A probe inside `waitForHubRuntimeProfile` returning
  `p2p.getReconnectState()` and the relay URLs proved the socket was in backoff.
- **Log the silent path.** The relay hello mismatch was invisible because the
  error goes to `onError`. One temporary `console.error` in the catch
  (`ws-client.ts`) printed the exact expected/received audiences and ended a
  multi-hour hunt. Revert such probes immediately after.
- **Always diff against the pre-work baseline** before claiming a regression:
  `git worktree add <dir> 020b7f32d`, symlink `node_modules` and
  `frontend/node_modules`, copy the current `scripts/debug/gpt.cjs` (the old one
  references contracts that no longer exist), then run the same spec there.

---

## 5. Next work item the owner approved: barrier + registry in the contracts

This is designed and agreed but **not started**. It fixes the original problem
that opened this session: a market maker with a two-sided cross-J book loses its
receive legs when one bilateral account is disputed.

### Why the current design loses money

The dispute unit (a bilateral account) is coarser than the risk unit (a leg
direction). The starter's transformer arguments are frozen at
`disputeStartTimestamp` (`Account.sol:487`), so a leg whose secret only arrives
later collapses to zero while the pay legs settle.

### The agreed fix (owner's own formulation, sharpened)

1. **On-chain hash-ladder registry.** `hashladderRevealedAt[commitment] = block`.
   Permissionless: anyone can carry 32 bytes from another chain and register
   them. `DeltaTransformer` already has exactly this for payment hashlocks
   (`revealSecret` / `hashToTimestamp`, consulted by `applyPayment` with the
   right `revealedAt <= revealedUntilTimestamp` check); pulls simply do not read
   it. Full-fill hashes are already byte-compatible; partial fills need a
   per-`partialRoot` record of `{maxRatio, timestamp}`.

2. **The registry must be the ONLY credit path for pulls.** Today
   `verifiedPullFillRatio` (`DeltaTransformer.sol:267`) takes the binary from
   calldata. If that stays, the hub can present the binary privately at
   finalization and never publish it, and nothing forces disclosure.

3. **Pass the reveal deadline into the transformer** — one extra parameter on
   `applyBatch` (current selector at `Account.sol:169`). Checking the window at
   registration time instead leaves a hole: the hub registers late against an
   account with no active dispute, and the global record then counts inside the
   disputed one. `applyPull` must check
   `revealedAt <= min(pull.revealedUntilTimestamp, disputeStart + REVEAL_WINDOW)`.

4. **Barrier on BOTH finalization paths.** Finalization must be impossible
   before `disputeStart + REVEAL_WINDOW + PORT_WINDOW`. Today the counterparty
   can finalize immediately (`Account.sol:476`) — that early finalize is what
   makes every other mitigation moot. Owner's numbers: hub must reveal by the
   half-way point, +24h before the dispute can close at all, so the user always
   has time to carry the preimage from the other chain.

5. **Registration is single-shot per commitment.** A nibble reveal for digit `d`
   is `H^(15-d)(base)`, so a higher digit derives every lower one, and a rising
   ratio can lower individual nibbles (`0x0FFF → 0x1000`). Two authorized
   reveals let an observer forge `0x1FFF` — verified numerically: reveals at
   4095 and 4096 produce a valid 8191 against the same commitment, ~6.25% of
   notional. This is pinned by `runtime/__tests__/hash-ladder-single-shot.test.ts`.
   It is also why per-level settlement (`cross_pull_reveal`) was implemented and
   then **removed** at the owner's instruction — do not reintroduce it. Cross-J
   settlement applies on the counterparty's request or on a full fill, once.

### Attack catalog to cover with tests before writing Solidity

1. Hub sequences the two finalizations to strand the receive leg.
2. Starter blindness — secrets arriving after `disputeStart`.
3. Staggered per-pull deadlines against one scalar `starterArgumentsTimestamp`.
4. Early finalize by the counterparty.
5. Quantization dust: on-chain claims are `Q(x)=floor(A·x/65535)`; runtime must
   commit through the same formula or disputed and off-chain amounts diverge.
6. Escrow/registry key collision — never key by hash material alone; same-J
   cross-token routes are legal (`index.ts:1309` only rejects same-J same-token)
   and `pull.ts:212` deliberately lets one order reuse its ladder.
7. Draining reserves during the IOU window.
8. Double claim / nullifier bypass.
9. Watchtower hanko domain omits `accountKey` (`HankoEncoding.sol:89-113`) —
   harmless today because the pair is fixed, a replay domain the moment any
   multi-lane scheme lands.
10. Proof-body ceilings: pulls are ~192 bytes in the body (176KB cap shared with
    HTLCs, swaps and subcontracts) and ~224 bytes per pull argument against a
    64KB starter-argument cap — roughly **145 claimable pulls per side** for
    whoever starts the dispute, and the body is rebuilt and hashed every frame.
    This is the standing argument for keeping resting orders out of Account
    state entirely.

---

## 6. Memory files written this session

Under `~/.claude/projects/-Users-zigota-xln/memory/`, indexed in `MEMORY.md`:

- `cross-j-pull-restating-design.md` — the barrier-over-escrow decision, the
  single-shot ladder property, and what was implemented then removed.
- `e2e-fast-gate-blockers.md` — the radapter fix and the payment-smoke hunt.
- `multisig-scenario-height1-divergence.md` — why multi-sig is aspirational.
- `ahb-scenario-stale-frame-budget.md` — the ordering-vs-settled assertion rule.

---

## 7. Immediate next step — and the eleventh blocker, already surfaced

The last run was `CI=true bun run test:e2e:fast` (serial, to fit the four free
slots). It did not reach the targets. It died in stack bring-up:

```
SHARD_BASELINE_RESET_ERROR api=http://127.0.0.1:20062 timeoutMs=300000
  requireMarketMaker=true requireCustody=true cause=TimeoutError
[mesh.orchestrator] timing {"ms":280762,"stage":"reset_market_maker"}
```

The market-maker reset alone burned 280s of the 300s baseline budget, with
health polls failing to reach `127.0.0.1:20075/api/health` and `:20067/api/me`.
This matches the standing `todo.md` entry — "the mesh now forms and the market
maker reaches ready, but full bootstrap still exceeds its readiness budget" —
so it is the known bootstrap-readiness item, now the gating one, and it is
**environmental pressure sensitive**: the same targets each passed in isolation
within 30-60s when the machine was quiet. The other session holding three stack
slots and its six anvils is real contention on this box.

Order of work from here:

1. Reap orphans (§2), confirm 4+ free slots, and re-run `CI=true bun run
   test:e2e:fast` on an otherwise idle machine. If the market-maker reset still
   overruns, that is the target to fix, not the specs.
2. If it needs fixing: instrument `reset_market_maker` in the orchestrator's
   reset path and find what it waits on; the health polls above suggest a
   node whose API never comes up rather than slow work.
3. Only then start the contract work in §5, and give it its own spec with the
   attack catalog before any Solidity — it is consensus-critical and needs a
   Depository redeploy.
