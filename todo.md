# xln mainnet release status

This is the only live TODO/NEXT file. It is a fail-closed release status, not a
product backlog; long-term work belongs in `docs/roadmap.md`.

September 30 implementation and verification: [J/E/A continuation](docs/jea-continuation.md).
The 138-target E2E snapshot and green full check are dated evidence, not mainnet acceptance.

## Current execution order — 2026-10-10

Latest owner decisions override the historical launch snapshots below: Ethereum,
native TRON and four-node XLNC; 10-fold lower XLNC gas budget; equal React/Svelte
priority; lending and multisig companies with existing EP shares included.
The owner signs mainnet transactions and approves the exact production build.

1. Preserve the shared working candidate in a WIP checkpoint and execute current
   source checks. Missing full-suite evidence stays explicit.
2. Reproduce the XLNC mixed-proof exit gas failure and measure its cause; current
   recorded 17,388,717 execution gas cannot fit the selected 6,000,000 block.
   Do not lower financial proof bounds or raise network gas to hide the failure.
3. Finish actual tutorial journeys on both UIs: payments, swaps/cross-swaps,
   lending/withdrawal/borrow/repay, disputes/recovery and companies. Existing React
   tutorial run is 8/8; newly changed Svelte financial regressions remain pending.
4. Freeze the candidate and satisfy the existing replay/native-J/recovery/load and
   release gates. Prepare the xln.finance deployment and rollback package tied to
   exact hashes; only then request the owner's build approval and signatures.

Working method: [improvement-loop.md](docs/improvement-loop.md). No additional
agent framework, duplicated checklist or new financial implementation is needed.

## Adopted launch design — 2026-09-05

Canonical product and evidence contract: [launch-design.md](docs/launch-design.md).

- First product: executable USDT Tron ↔ USDT Ethereum liquidity, with payment,
  same-jurisdiction WETH/USDT exchange and cross-jurisdiction USDT exchange.
  Keep assets jurisdiction-local; never merge their balances by ticker.
- Two market makers and three independent hub operators are the network-launch
  target. Our H1–H3/MM remain the engineering stand, not evidence of independent
  failure domains. The latest adopted design proposes a USD 10,000 canary,
  then 100,000 / 500,000 / 2–5 million / dynamic risk-managed stages; no funds
  move and no policy cap becomes real merely by accepting this design.
- Product evidence is executable liquidity by amount/direction, all-in price,
  quote availability, completion rate and p50/p95 execution. Count unique
  settled economic operations. Display unavailable values honestly; publish
  no illustrative balances, volumes, latencies, or unsupported privacy claims.
- Verification is discovery/trust metadata, never protocol permission. Prove
  H2 failure while an independently funded H1–H3 route remains executable.
- Ethereum, Tron, Base and experimental XLNC remain architecture targets;
  the first public liquidity workflow is Tron ↔ Ethereum. Landing-page work
  follows real quotes and same-candidate financial/recovery evidence.

## Earlier owner launch decisions — 2026-09-05

- Target: soft mainnet on Ethereum, Tron, Base and experimental XLNC.
  Earlier initial total capital/risk budget: USD 1,000; the later adopted design
  above proposes a larger canary. Growth still requires measured safety evidence.
  H1–H3 and MM are currently operated by us; do not describe them as independent operators.
- Mainnet correctness before customer acquisition. XLNC may start with one validator,
  but local full-node verification does not remove censorship/liveness/governance trust.
- The latest owner instruction rejects arbitrary protocol monetary ceilings. Limit our
  own funded launch exposure operationally; do not restrict other users' transfer amounts.
  Full-width arithmetic, solvency, signer authority and representable state remain mandatory.
- Add final governance evidence: CONTROL/DIVIDEND fixed supplies, board proposal/rotation,
  treasury authority, buyback execution and replay/rejection cases on the same candidate.
- Replace the second-Anvil-only Tron claim with genuine TVM/native RPC/event/finality evidence.
  Preserve the smallest shared adapter boundary; Anvil is only an EVM test fixture.
- Target ordinary verification cycles at 60 seconds through measured startup reuse and
  duplicate-work removal. Do not skip financial assertions or relabel smoke as parity/TPS.
- Validate pricing against actual all-in competing use cases; 1 bp payments / 3 bp swaps
  are hypotheses, not an established two-times advantage over every CEX tier.

## Active launch recovery boundary — 2026-09-05

- Separate P2P authentication and financial readiness is implemented in the
  working tree: retain the existing outbox until the exact recipient is ready;
  close new financial operations through J catch-up. Local WAL and portable
  checkpoint recovery retain the same ordered outbox evidence.
- Fresh production R7 is green after the TS recovery-mark correction: one cross-j
  swap in 625 ms, full process replacement and recovery complete in 38.681 s.
  Frozen checkpoint23/tail24–90: 67 frames, 108 Entity inputs, 104 outputs. TS W1/W4
  match all five evidence arrays. Native W1 verifies every frame/root/ordered digest
  and fsync, then fails its mandatory same-native restart with
  `RRS_NATIVE_RESTORE_STORAGE:RRS_ENTITY_CONTEXT_FRAME_REFS`. Native h29 context keys
  and digests are complete; the reader confuses canonical encoded-key order with raw
  string order. Fix that decoder boundary and repeat R7 before W4/live J/final gates.
  Evidence: `/tmp/xln-cross-j-wal-r7-20260905.log` and
  `/tmp/xln-cross-j-parity-r7-20260905/rust-w1.stderr.log`.
  Fixes preserve exact startup signer inventories, authenticated Runtime output
  boundaries/source frames and replay-only WAL routes; live guards remain strict.
  Focused Runtime regressions: 87 tests / 330 assertions / 2.89 s.
- Runtime output/readiness changes have focused TS and Rust vectors. A fresh production
  cross-j WAL is bound at `/tmp/xln-cross-j-wal-r4-20260905/recording-manifest.json`:
  checkpoint 22, tail through 57, 35 frames, 64 Entity inputs, 56 outputs. TS W1/W4
  replay verifies every frame and all five per-frame evidence arrays agree exactly.
  Rust restores the original signed checkpoint through canonical offline Account import;
  frames 23–44 match (22/35). Frame 45 exposed a TS worker bug: it proposes the whole
  mempool before the cross-j selector, so the later guard sees an empty mempool. Real
  worker regressions reproduce four failures (W1/W4, missing reciprocal leg/nine orders)
  in 1.385 s. Canonical preproposal selection and the same failed-HTLC continuation
  edge are fixed: 52 tests / 41,146 assertions / 9.42 s. R4 remains bug evidence.
  New immutable R6 checkpoint 24 plus tail 25–89 contains 65 frames, 105 Entity inputs
  and 104 outbox envelopes. TS W1/W4 match every frame and all five arrays exactly in
  2.837 s / 3.115 s. Native per-input admission, per-owner cascade order and late-intent
  admission pass 85 machine tests. Further R6 fixes cover J-height, atomic sibling
  publication, same-J-only pair dimensions and deferred remote Runtime outputs.
  Rust now matches 48/65 frames, heights 25–72. h67 fixes preserve speculative Cross
  book publication, canonical reveal admission and committed-only match metrics.
  At h68, restoring the existing per-input hub-rebalance kick makes all 46 Entity
  sections, canonical state hash and ordered outbox exact. Correcting an absent-order
  event closes the remaining signed frame mismatch. h69 now preserves same-frame
  scheduled collective work, exact rebalance Account touches and the canonical
  financial-effect subset. h72 now verifies retained prior native outbox evidence;
  seven focused regressions pass. First red h73: roots, metadata and outbox are exact,
  but the first live post-restart TS frame inherits 16 Account/two book dirty marks
  from recovery. Fixed in TS by clearing only successful per-frame recovery marks;
  real payment/recovery regression passes 31 assertions in 2.12 s and preserves
  cumulative checkpoint overlay. Fresh R7 above passes this boundary. Prior TS replay checks did not
  independently regenerate this touch list.
  Evidence: `/tmp/xln-cross-j-parity-r6-20260905/recording-native-import.json.w1.diffs/first-divergence-h73.json`.
  Completeness remains a final gate.
- Evidence-mode restart exposed two startup dependency errors and a real crypto worker
  process-liveness failure (pending job, process exits 0). Both are fixed and r5 restart
  is green. The original base checkpoint survives workload setup and recovery.
- Full check r4 passed 15 Solidity invariants in 8.23 s, then stopped on a new test's
  folder width. The test is grouped and the unchanged width threshold passes. Rust
  all-target/all-feature clippy is green. Run full check on the next stable candidate.
- Existing company-ipo scenario passed on actual local Anvil RPC: custody 100 billion
  CONTROL and DIVIDEND, settled takeover/handover and successor reserve authority.
  Buyback now proves exact committed movement of 10 billion CONTROL and 1 trillion
  six-decimal USDT base units, fee 0 under that fixture's policy, across eight asset
  copies. This is one buyback, not eight operations. All 211 frames survive persistence
  reload with the same root. Evidence: `/tmp/xln-company-ipo-20260905.log`.
  Four existing Solidity tests passed in 266 ms on current compiled source/bytecode:
  initial emission for Foundation/numbered Entity and retired-board rejection for batch,
  C2R and settlement, while historical dispute signatures remain accepted. These are
  local EDR tests; they do not prove every future issuance path. This result makes no
  burn, public-USDT or on-chain buyback-return claim.
- Incoming Spectrum and own Reserve→Account Move passed real browser R10 in 28.926 s:
  25→27.5 credit, 25.000025 funded including route fee, payment review restored without
  automatic send; zero page/MAC/auth errors and zero activity-view gap warnings.
  Same-j Swap also passed its real browser scenario in 24.100 s overall: 199.999992
  USDC debited, 0.0799760016 WETH received, 0.0879824 permanent WETH credit, zero pending
  work. Cross fresh-wallet setup is fixed by the existing canonical per-jurisdiction
  signer/import path and passed in 22.381 s. Actual Cross input then accepted explicit
  0.03→0.033 WETH credit with unchanged balances before confirmation, but its submitted
  order stayed resting. Selecting actual opposite MM liquidity now proves settlement:
  Cross debits 10,200 USDC, receives 10,198.98 gross USDT, net 10,197.860102 plus the signed
  1.119898 collateral fee. R14 Same-J + Cross pass 2/2 in 38.099 s with one bootstrap;
  pre-submit tariff, correct Account settings link and 12 px mobile clearance verified.
  Lending R1 stops at lending_fund admission: D3 still excludes live Lending despite
  existing handlers. Real worker proves no Account mutation; aggregate diagnostics
  now preserve the primary error. Spectrum/close payout and actual lease remain open.
- Native TVM deployed all eight contracts and passed canonical reserve deposit/withdraw:
  reserve 0→1,000,000→0, nonce 1→2, external balance restored. Evidence:
  `docs/evidence/tron-native-20260905/manifest.json`. Native cross-j and public rails remain.
  Configured native graph now passes the real provisioner with distinct contract addresses
  and native endpoints/finality. Bytecode templates 9/9 unchanged. Native import reached
  J_AUTHORITY_RECEIPT_MPT_PROOF_MISSING:FoundationBootstrapped:25:3; stock Tron headers
  do not authenticate arbitrary logs with a receipt root. The explicit validating-node
  trust decision is pending in docs/tron-native-test-plan.md; native cross-j stays closed.
- TS/Rust arbitrary payment/credit ceilings are removed, with full-width state and hold
  checks before mutation. The Solidity 2^200 domain still requires a coherent arithmetic
  and transformer ABI decision; owner confirmation requested in `docs/money-domain.md`.
  Do not claim all contract monetary ceilings are gone.

## Active Rust H1 milestone — 2026-08-31

- Remove avoidable Account-input/outbox data movement. Current 1000-user,
  five-second profile moves 52.3 MB of Runtime inputs and 45.5 MB of outbox;
  31.0 MB of the outbox is repeated frame/dispute Hanko material.
- Explain and reduce the `w1 -> w4` full-flow gap. Current diagnostic Account
  work improves 2.55x per Account input, while end-to-end drain improves only
  1.27x because W4 seals 51 Runtime frames / 14,655 Account inputs while W1
  seals 21 / 10,526 for the same 5,000 payments. The Account outcome trace has
  zero `FrameDuplicate`; isolate Account-frame fragmentation/bundling rather
  than misclassifying the ledger's repeated appearances as duplicate apply.
- Collapse the production Entity plan to the canonical three stages. Today an
  interleaved local transaction can split one frame into multiple
  `AccountRange` worker visits; the target is one Account ingress batch, one
  Entity financial batch, and one Account proposal batch.
- Collapse `commit_paybook_changes` from two shared-pool dispatches into one
  `256 shard -> changes[]` dispatch. Current code first maps every change into
  a mutation and then wakes the pool again for active radix slots; measured
  Paybook commit wall is 45 ms at W1 versus 168 ms at W4 for the same payment
  smoke, proving coordination overhead instead of scaling.
- Remove the two conditional post-proposal Account continuations from the
  normal architecture: failed-forward compensation must be decided before
  Paybook emits proposal work, and locally-produced settlement Hankos must be
  attached at publication instead of mutating the Account candidate after
  Entity certification.
- Remove derived Runtime-frame touch lists from the canonical WAL format once
  the TS storage/UI readers derive their views from canonical input/output
  rows; do not retain both representations.
- Eliminate duplicate EntityInput encoding: admission currently encodes the
  complete input only to measure it, then Runtime projection encodes it again
  inside the frame. One canonical byte representation must cross both steps.
- Run fresh, sequential Rust H1 payment saturation evidence at 5,000 users for
  20 seconds with W1 and W4, then run the same-chain swap gate. Report only
  committed operations with zero pending Account ACKs and zero transport loss.
- Run `bun run check`, checkpoint the coherent change on `main`, and push only
  after the focused Rust parity tests and live H1 gates are green.

## Current candidate — 2026-08-14

- Branch: `main` (the only writable release worktree).
- Open mainnet protocol/code blockers: **5**. Testnet remains the active product target.
- The executable mainnet gate currently blocks uncapped launch until aggregate
  financial-risk enforcement and the bilateral/on-chain lending covenant are real.
- Live Runtime/Entity/Account replicas must contain only the current committed
  head and bounded in-flight coordination. Historical frames, terminal orders
  and finalized J-event bodies are moving to their dedicated LevelDB history
  stores; release remains blocked while any live historical collection remains.
- Runtime/Entity/Account/Book candidates must use separate recomputable
  persistent-Merkle overlays. A frame may not clone or traverse the complete
  machine, and throughput evidence is not valid until every matched swap is
  bilaterally committed with all Runtime/outbox queues at zero.
- Cross-j Pulls intentionally use independent jurisdiction dispute clocks. Any
  observed leg dispute must make the user or hub Runtime atomically start every
  sibling dispute in one WAL candidate and port Source evidence to Target. This
  best-effort recovery invariant does not impose a shared settlement epoch and
  does not disable the product.
- Hash-ladder publication is an independent Sprites-like `processBatch`
  operation authenticated by the publishing Entity. The registry stores the
  account-scoped ladder record; it does not authorize against, retain, or
  promote a dispute ProofBody.
- `proposerIsLeft` is signed proof-header consensus data. LEFT wins an equal
  nonce; a strictly newer nonce wins regardless of side.
- Pull-free early finalization is available only to the non-starter as fresh
  mutual acceptance. The starter waits until T; every Pull finalization waits
  until T. Watchtowers may lock a newer signed counter-proof before T and may
  execute it only at T.

## Release evidence contract

The candidate is publishable only after all commands below are green on the
same bytes and an independent contract/runtime audit reports no blocker:

- `bun run check`
- `bun run gate:release`
- `bun run gate:mainnet-preflight` (owner explicitly excluded the soak gate)
- post-deploy `bun run prod:health`
- fully green unit tests, deterministic scenarios, and browser E2E on the same
  immutable candidate bytes

Completed work and stale findings are deleted rather than retained as open
checkboxes. Any new blocker must be added here immediately and removes release
authority until fixed and re-gated.
