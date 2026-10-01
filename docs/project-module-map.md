# xln — module ownership and work map

Snapshot: `main` @ `566c850b3`, 2026-09-25. This is an **ownership specification**, not a payment tutorial. Each card lists its folder, **I** (inputs and their owner), **O** (outputs and their consumer), **S** (status supported by the evidence available at that date), and **Next** (three ordered tasks). Where a card names several folders, an implementer owns **one specific folder** and an integrator checks their shared I/O. An end-to-end flow does not itself own a state machine. These dated observations are not current release claims.

## Owner decisions

- **At this snapshot:** production mixed WAL demonstrated exact TS/Rust W1/W4/W8 parity over 134/134 frames, including R/E/A roots and ordered events/effects/outbox. Live Rust H1 W1/W4 each completed 650/650 payments, J watching, and `r2r/r2c/c2r` with onchain money conservation. `bun run check` passed after repairs. Of 12 core browser E2Es, 11 passed; cross-J exposed a protocol choice: one signed `fillRatio` debits the entire 78 USDC limit when receiving 0.03 WETH, although matching executes at the 75 USDC ask. The price contract, complete production transaction-kind coverage, and a valid 20-second TPS run remained open.
- **Do not conflate dated status:** `todo.md` dated 2026-09-05 records old failures for Rust restore, Tron receipt proofs, and lending admission. `docs/night-work-plan.md` dated 2026-09-18 records local native recovery and public-service/signing blockers. HEAD dated 2026-09-23 could have changed them. Reproduce each before calling it a current defect.
- **Ownership:** one implementer per R/E/A/J transition. Rust mirroring and review follow a stable diff. UI, QA, relay, and operations may proceed independently when they do not change that contract.

**Evidence recorded on September 25:** immutable WAL at `.logs/hlt-evidence/2026-09-25T03-13-05-243Z/recording-manifest.json`; `full-parity.log` in the same directory (**6/6 engine configurations, 134 frames**). Live Rust evidence at `.logs/hlt-live-rust-130-w{1,4}/` (**650/650 payments and three Move directions each**). Rust W4 replay apply took 815.8 ms versus W1 1771.0 ms (**2.17x**); live apply took 441 ms versus 726 ms (**1.64x**). This was a small functional load, not release TPS. The last check reported here was green; the Rust Runtime suite passed **352/352**.

## Source and documentation sizes

`N/C/D` means physical source lines / approximately nonblank, non-comment lines / lines of **directly associated** documentation. C is a lexical count, not a usefulness assessment. Counts use tracked Git files; module source sizes exclude tests, fixtures, generated files, and archives. Shared specifications are not counted repeatedly per folder.

- Runtime **23,410/20,761/197**; Entity **45,290/39,922/70**; Account **18,723/16,212/198**.
- Jurisdiction including adapters **24,168/21,456/56**; storage **23,875/21,530/591**; protocol **9,313/7,503/1,156** (documentation shared with RJEA/FinTS).
- Network **11,083/9,860/30**; Orderbook **2,700/2,320/24**; Watchtower **4,573/4,138/111**; API **16,557/15,107**, with no separate direct document assigned.
- Rust crates excluding tests: **178,446 physical lines**; web `frontend/src/`: **130,169**; native React `ui/src/`: **18,614**. All tracked source: **1,124,990**, including **294,540 test lines** and **56,938 vendor lines**.
- Markdown is counted separately: **118,330 lines** repository-wide. Of **78,844 lines in `docs/`**, exactly **57,571** belong to 22 historical release snapshots. Maintained documentation excluding release/evidence/audit: **19,634**. The full 78,000 lines are not an active specification.

`R/1000` is the author's subjective estimate of safe-change difficulty: 900+ affects protocol or money; 700–899 needs integration; below 700 is usually independently assignable. It is not measured readiness.

## P0 — one protocol and durable results

### 01 · `core/types/` + `core/protocol/` — shared contract · R920

- **I:** command types and signed wire data from Runtime, Entity, Account, and J.
- **O:** canonical bytes, hashes, identity, HTLC, and state primitives for every machine, WAL, and Rust.
- **S:** TS/Rust wire/root parity passed 6/6 configurations on mixed WAL; the Solidity vector remains a separate final gate.
- **Next:** 1) named wire/hash vector; 2) map all readers before deleting aliases; 3) one current codec without compatibility bypasses.

### 02 · `core/runtime/admit/` + `mempool/` — ingress and rejection · 3,700 LOC · R860

- **I:** API commands, P2P envelopes, J events, and scheduled wakes.
- **O:** canonical `RuntimeInput` for `frame/`; typed rejection of exactly one invalid transaction.
- **S:** mixed production replay exact on 134/134 frames; adversarial single-transaction rejection still needs its own vector.
- **Next:** 1) reject one transaction in a lane; 2) peer/user input order; 3) rejection diagnostics without reading process environment inside transitions.

### 03 · `core/runtime/frame/` + `loop/` — Runtime frame · 5,256 LOC · R960

- **I:** one `RuntimeInput` and the last committed Runtime state.
- **O:** candidate `RuntimeFrame`, ordered Entity/Account outputs, and WAL commit plan.
- **S:** mixed WAL exact on 134/134 frames across TS/Rust W1/W4/W8; a regression covers header-only J advancing the next Entity frame.
- **Next:** 1) first divergent frame; 2) exact inbound Account → Entity work → outbound Account order; 3) remove only a measured redundant candidate copy.

### 04 · `core/entity/consensus/` — Entity certificate · 12,114 LOC · R980

- **I:** `EntityInput`, board signatures, and previous Entity state.
- **O:** certified `EntityFrame`, root, and ordered secondary hash manifest for Runtime.
- **S:** Entity roots and ordered events matched on all 134 frames across six configurations.
- **Next:** 1) exact replay manifest; 2) candidate/committed isolation on failure; 3) partition into `input/`, `proposal/`, `frame/`, and `commit/` after parity.

### 05 · `core/entity/tx/` — Entity-owned work · 20,201 LOC · R975

- **I:** validated `EntityTx`, J facts, Account inputs, and product commands.
- **O:** new Entity state, local `AccountTx`, exact `AccountInput`, and Runtime outputs.
- **S:** mixed HLT replay exact over 134 frames; one production WAL does not yet represent all 63 EntityTx kinds.
- **Next:** 1) stage 1/2/3 trace; 2) one owner for each `AccountTx` admission; 3) final transaction-kind completeness after production parity. Small scopes: `handlers/account/`, `payments/`, `cross-j/`, `j-batch/`, `dispute/`.

### 06 · `core/account/consensus/` — bilateral frame · 5,938 LOC · R995

- **I:** peer proposal/ACK/ACK+frame/dispute and local Account replica.
- **O:** committed `AccountFrame`, cached duplicate response, or typed Entity rejection.
- **S:** strict recorder checked checkpoint and full restart; mixed replay Account roots were exact. Separate adversarial ACK vectors remain a release gate.
- **Next:** 1) exact duplicate without append; 2) LEFT collision and different hash/height rejection; 3) change ACK cost only after profiling. Scopes: `incoming/`, `proposal/`, `frame/`, `dispute/`.

### 07 · `core/account/tx/` — money and obligations · 4,952 LOC · R995

- **I:** locally admitted `AccountTx`, previous `AccountState`, certified J claim.
- **O:** new `AccountState`/root and financial outputs for bilateral consensus.
- **S:** mixed replay Account roots exact; 21 AccountTx kinds are catalogued, four supported only by general mixed replay evidence.
- **Next:** 1) compare both parties and `deriveDelta` at the first divergent Account; 2) adversarial deadline/HTLC/J-finality vectors; 3) remove duplicated financial formulas only with TS/Rust parity. Assign `handlers/{settlement,swap,balance,rebalance,j-events,htlc}/` by transaction kind.

### 08 · `core/jurisdiction/machine/` — certified J facts · 7,090 LOC · R950

- **I:** verified chain observations from adapters, Entity batches, signer evidence.
- **O:** certified J prefixes/events to Entity and Account; batch commitment for submission.
- **S:** live Rust W1/W4 checked watcher, J finalization, onchain `r2r/r2c/c2r`; J nonce advanced in both runs.
- **Next:** 1) one watcher event through J prefix; 2) signer threshold and event order; 3) pure normalizer without another authority. Scopes: `events/`, `history-consensus/`, `batch/`.

### 09 · `core/jurisdiction/adapter/` — external network · 16,835 LOC · R890

- **I:** RPC blocks/logs/receipts and committed Runtime submission intent.
- **O:** authenticated J observations and chain receipts/errors for Runtime.
- **S:** RPC and BrowserVM exist; the September 5 Tron receipt-proof failure in `todo.md` needs fresh verification.
- **Next:** 1) real watcher/receipt on the target network; 2) BrowserVM as development evidence, not production; 3) polling lag/retry measurement. Scopes: `rpc/`, `watcher/`, `events/`.

### 10 · `core/runtime/j-submit/` — J batch submission · 2,425 LOC · R880

- **I:** committed J batch intent after WAL and chain adapter responses.
- **O:** submission/receipt lifecycle and the next `RuntimeInput`.
- **S:** live Rust W1/W4 passed watcher → Entity → batch → receipt and three Move directions.
- **Next:** 1) full live chain; 2) retries without duplicate effects; 3) phase latency/cause counters.

### 11 · `core/storage/commit/` + `wal/` + `database/` — durable boundary · 4,480 LOC · R985

- **I:** Runtime candidate, canonical input bytes, ordered outbox.
- **O:** fsynced WAL/HEAD/outbox readable by recovery.
- **S:** strict checkpoint/full restart and mixed replay passed; `bun run check` passed after restoring local Hardhat 3 and forge-std.
- **Next:** 1) commit before effects in one frame; 2) persisted bytes/root/digest; 3) remove measured duplicate encoding/hashing without another durable oracle.

### 12 · `core/storage/recovery/` + `read/` — recovery · 8,095 LOC · R980

- **I:** checkpoint, ordered Runtime WAL inputs, stored commitments.
- **O:** restored R/E/A state or first mismatched frame/root/output digest.
- **S:** implementation exists; the old Rust restore failure in `todo.md` needs a HEAD rerun.
- **Next:** 1) exact per-frame replay; 2) crash before/after publication; 3) detailed Account dump only after the first mismatch.

### 13 · `core/runtime/delivery/` — post-WAL outbox · 3,896 LOC · R920

- **I:** committed Runtime outputs and peer/Entity/J addressing.
- **O:** exact P2P/API/J envelopes and retry state; ACK/receipt back to ingress.
- **S:** implementation exists; duplicate route-key merging was found in `pending.ts` and `plan.ts`.
- **Next:** 1) preserve the first accepted output's position; 2) consolidate the 23-line merge; 3) reconnect/restart without loss or duplicate effects.

### 14 · `core/hanko/` + `jurisdictions/contracts/` — proof and onchain enforcement · R990

- **I:** certified Entity/Account state, signer authority, nonce, previous state, J batch.
- **O:** Hanko/proof, contract transition, chain events for watchers.
- **S:** TS and Solidity exist; full cross-language hash/bytecode gate was not run. Solidity source: **6,605 LOC**; `core/hanko/`: **2,275 LOC**.
- **Next:** 1) one TS/Rust/Solidity proof vector; 2) signer/nonce/old→new/dispute counterexample; 3) synchronized artifacts/typechain and bytecode review for Solidity changes. Contract folders and Account/Depository/EntityProvider need one proof-change owner.

### 15 · `core/rscore/` — TS↔Rust boundary · 14,470 LOC · R935

- **I:** exact R/E/A inputs, checkpoint, wire codec, worker count.
- **O:** Rust calls/results and per-frame parity evidence for TS Runtime/QA.
- **S:** bridge passed all six TS/Rust W1/W4/W8 configurations. `core/rscore/` contains TypeScript workers and IPC; Rust lives in `rscore/crates/`. Do not delete the entire bridge folder.
- **Next:** 1) one immutable WAL; 2) first divergent frame; 3) live J after exact replay. No separate financial formula in the bridge.

### 16 · `rscore/crates/engine/` — Rust Account · 23,351 LOC · R980

- **I:** canonical Account input/wire and previous Rust Account state.
- **O:** Account root, ordered outputs, frame equal to TS Account.
- **S:** Account roots exact over 134 frames/six configurations; release binary and workspace tests passed `bun run check`.
- **Next:** 1) named AccountTx vector; 2) exact mixed-WAL roots/outputs; 3) remove a proven duplicate formula. Scopes: `src/tx/` 7,104, `consensus/` 6,169, `j_claims/` 2,605 LOC.

### 17 · `rscore/crates/entity-kernel/` — Rust Entity · 56,304 LOC · R985

- **I:** EntityInput, Rust Account results, J events, book/paybook work.
- **O:** Entity root, ordered outputs, candidate/certificate data for Rust Runtime.
- **S:** Entity roots/outputs exact over 134 frames/six configurations; cross-J/lending remain separate fixture vectors.
- **Next:** 1) three stages against TS; 2) J-event→Account path; 3) measure shard/batch cost before optimization. Scopes: `local_financial/` 7,422, `cross_j/` 8,456, `consensus/` 4,514, `orderbook/` 4,189 LOC.

### 18 · `rscore/crates/runtime/` + `batch/` + `process/` — Rust live Runtime · 90,096 LOC · R995

- **I:** checkpoint/WAL, RuntimeInput, Rust Entity/Account results, J watcher.
- **O:** Runtime roots and ordered outbox; live effects after commit.
- **S:** exact replay and live J W1/W4 passed; the 130-user functional stand is not valid 20-second TPS evidence.
- **Next:** 1) exact W1/W4 replay; 2) live J watcher→receipt; 3) phase profile/Amdahl before H1 TPS. Scopes: `runtime/src/{machine,processor,restore,j_watcher,j_submit}/`.

## P1 — economic products and services

### 19 · `core/entity/paybook/` — HTLC payment lifecycle · 1,190 LOC · R860

- **I:** payment EntityTx, route/capacity, J height, inbound Account lock/secret/ACK.
- **O:** hashlock record, ordered forward/settle/fail/refund Account intents, final Runtime event.
- **S:** implementation exists; September 18 local payment/recovery evidence does not prove the public HEAD flow.
- **Next:** 1) live payment→unique receipt; 2) timeout/restart/refund vector; 3) context materialization cost only after profiling. Account owns balances.

### 20 · `core/orderbook/` — book and matcher · 2,700 LOC · R940

- **I:** validated Entity offer/cancel/resize, Account eligibility, J pair/finality.
- **O:** price-time ordered matching events, book pages/root, Account swap-resolve intent.
- **S:** implementation exists; this report did not obtain current same-J/cross-J settled-fill evidence on its SHA.
- **Next:** 1) live settled fill; 2) TS/Rust order/root vector; 3) verify index hydration before matcher optimization. Scopes: `core.ts`, `pages/`, `cross-j/`, `swap-execution.ts`.

### 21 · `core/extensions/cross-j/` — linking two jurisdictions · 2,204 LOC · R965

- **I:** swap terms and both jurisdictions' finality from Entity/J machines.
- **O:** bound route/phase, Account/J intents, terminal Runtime result.
- **S:** cooperative source-buyer close now carries exact execution price to Account and releases unused hold; disputes retain the signed maximum. Focused TS tests passed 13/13 and TS/Rust compiled; browser E2E and parity for the new contract were still being checked. Full live Rust/J cross-J was not confirmed.
- **Next:** 1) full/partial/disputed swap through both receipts; 2) TS/Rust replay and onchain dispute vector for the chosen contract; 3) Hub economics in both assets including rounding.

### 22 · `core/pathfinding/` — routing and quotes · 546 LOC · R700

- **I:** Hub profiles/capacity/fees, asset, amount, direction.
- **O:** executable route/quote for Paybook/UI or a no-route explanation.
- **S:** implementation exists; current live-mesh executable depth was not measured.
- **Next:** 1) quote against actual available capacity; 2) explain rejection; 3) cache only after measurement.

### 23 · `core/orchestrator/market-maker/` — MM quotes · 7,087 LOC · R760

- **I:** Hub profiles, Account balances/capacity, token catalog, J RPC, quote policy.
- **O:** account-open/connectivity Entity inputs, same-J/cross-J offers, executable-depth health.
- **S:** implementation exists; submitted quote count does not prove liquidity, independent operators, or settled volume.
- **Next:** 1) executable amount/price and committed fills; 2) divide `mm-node-run.ts` (2,473 LOC) by lifecycle; 3) remove health duplicates only after mapping callers.

### 24 · `core/extensions/lending.ts` + Account handlers — lending and rebalance · R890

- **I:** lending/pull/rebalance intent and committed collateral/capacity.
- **O:** typed AccountTx, bilateral frame, financial receipt.
- **S:** handlers exist; September 5 `todo.md` recorded failed `lending_fund` admission, requiring focused rerun.
- **Next:** 1) named vector per transaction kind; 2) funding/close/reload; 3) UI exposure/fees only from committed Account data.

### 25 · `core/runtime/registration/` + `core/entity/auth/` — identity and board · R920

- **I:** signed registration/board update and certified J registry event.
- **O:** authorized Runtime/Entity identity and board/profile descriptor for verification.
- **S:** implementation exists; governance/retired-signer evidence remains a final gate for this report.
- **Next:** 1) board rotation; 2) retired-signer rejection; 3) key provenance in operator health.

### 26 · `core/network/{p2p,relay}/` — Runtime connectivity · 11,060 LOC · R830

- **I:** committed outbox, remote authenticated envelopes, endpoint/gossip metadata.
- **O:** verified inbound Runtime input, reconnect/delivery status, discovery.
- **S:** implementation exists; full H1 transport loss and pending Account ACKs were not measured here.
- **Next:** 1) reconnect with the same outbox; 2) separate peer auth/session closure from financial rejection; 3) zero-loss/drain metrics.

### 27 · `core/watchtower/` — backup and last-resort dispute · 4,573 LOC · R900

- **I:** signed encrypted archive/appointment, quota policy, chain dispute event.
- **O:** blind restore bytes, signed tower receipt, delayed counter-dispute action.
- **S:** local archive→fresh restore evidence was described on September 18; public tower readiness was not established.
- **Next:** 1) upload→fresh restore; 2) quota rejection preserving the previous copy; 3) live last-resort dispute timing.

### 28 · `frontend/src/lib/stores/vault/` + `ui/src/runtime/` — wallet and recovery · R930

- **I:** seed/keys, local store, encrypted tower archive, canonical checkpoint.
- **O:** restored session/state, typed commands, committed history/receipts.
- **S:** local recovery→new payment was confirmed in the September 18 plan; physical-device/public flow was not confirmed.
- **Next:** 1) fresh-device backup→restore→new payment; 2) interruption before publication; 3) honest recovery choices in UI.

### 29 · `brainvault/src/core/` — remembered-secret wallet · 603 canonical LOC · R900

- **I:** exact username/password/shards/multiplier and pinned Argon2id/BLAKE3 recipe.
- **O:** deterministic root and two local mnemonic/key/address projections.
- **S:** portable wallet semantics occupy 603 lines; large `src/native/` includes accelerators/vendor, not protocol size.
- **Next:** 1) identical root across engines/workers; 2) fresh-process address before funding; 3) portable core separate from acceleration.

### 30 · `core/api/{public,server,runtime-adapter}/` — API · 16,557 LOC · R690

- **I:** typed CLI/UI commands and latest WAL-committed Runtime state.
- **O:** admitted Runtime command, HTTP/WS response, read-only projection.
- **S:** implementation exists; `resolve.ts` (2,208 LOC) mixes routing/recovery/views; readiness of every flow was not verified.
- **Next:** 1) one command→final receipt contract; 2) public reads of committed state only; 3) split `resolve.ts` using its caller map.

### 31 · `core/orchestrator/` — Hub/MM startup · 24,138 LOC · R760

- **I:** configuration, DB, signer, network, J endpoints.
- **O:** running processes, readiness/health, MM intents for Runtime.
- **S:** implementation exists; `docs/night-work-plan.md` reported offline H1–H3 on September 18; current public health was not measured.
- **Next:** 1) H1–H3/MM restart without manual repair; 2) J readiness separate from P2P auth; 3) executable-liquidity health.

### 32 · `custody/` — service asset withdrawal · 3,735 LOC · R810

- **I:** signed custody admission/withdrawal request and chain status.
- **O:** authorized withdrawal, durable journal, operator ledger response.
- **S:** service exists; restart/replay and onchain reconciliation were not run here.
- **Next:** 1) signed admission; 2) nonce/replay after restart; 3) journal versus chain balance.

## P2 — views, tools, and evidence

### 33 · `frontend/src/` — web · 130,169 LOC · R620

- **I:** user action, vault/session, API projection.
- **O:** typed Runtime commands and committed balance/receipt/recovery screens.
- **S:** implementation exists; no browser/F12 verification on this report's SHA. `components/Entity/` has 41,622 LOC, too broad for one implementer.
- **Next:** 1) pay/swap/recovery through receipts; 2) assign screens by flow (`pay`, `swap`, `assets`, `workspace`); 3) remove redundant refreshes based on profiling, not file length.

### 34 · `ui/src/` + `native/` — mobile and desktop · 18,614+ LOC · R680

- **I:** native host bridge, vault state, API/runtime adapter.
- **O:** typed commands, native screens, receipts, restored wallet.
- **S:** September 18 simulator evidence exists; physical device, signing, public installation were not proven.
- **Next:** 1) on-device pay/swap/fresh restore; 2) camera denial and VoiceOver; 3) platform wrapper separate from shared typed client.

### 35 · `cli/` — terminal client · 3,283 LOC · R450

- **I:** user arguments/profile and daemon API.
- **O:** typed pay/swap/open/move/lend command and final terminal receipt.
- **S:** implementation exists; receipt/restart scenario was not run here.
- **Next:** 1) observable final receipt; 2) daemon/user-input errors; 3) retry without duplicate payment.

### 36 · `core/qa/` + `core/scenarios/` + `tests/` — evidence · R700

- **I:** production artifact, invariant, exact input.
- **O:** first divergent frame, named regression, gate evidence.
- **S:** `bun run check`, six exact-parity configurations, and live Rust J W1/W4 passed. Core browser E2Es were 11/12, with cross-J blocked by the price contract. Valid TPS remained open.
- **Next:** 1) named regression at first mismatch; 2) completeness after production WAL; 3) unique settled-operation counts. Split `core/qa/report.ts` (2,998 LOC) by actual output consumers.

### 37 · `scripts/` + `core/scripts/` + `tools/` — execution and gates · R650

- **I:** exact SHA, configuration, stand resources, verification commands.
- **O:** build/run artifacts, health, test/replay/performance evidence.
- **S:** `bun run check` passed; local dependencies restored from lockfile and standard `forge:setup`, without changing tracked artifacts.
- **Next:** 1) restore dependencies and repeat the same gate; 2) retain the heavy-stand lock; 3) consolidate the duplicate 14-line child-process wait in release runners.

### 38 · `ai/` + `debates/` — optional interfaces · R400

- **I:** user prompts and authorized read APIs.
- **O:** answer/artifact, with no direct authority to change consensus state.
- **S:** implementation exists; no established role in the release critical path.
- **Next:** 1) typed permission boundary; 2) remove only proven unused paths; 3) exclude from launch gates unless they provide useful economic value.

## Concrete deletion and deduplication shortlist

1. **Highest value:** identical 23-line route-key merge in `core/runtime/delivery/pending.ts:398–422` and `plan.ts:27–51`. One helper after an input-position/output-digest regression. Medium risk.
2. **Low UI risk:** identical 41-line MoveWorkspace prop forwarding in `EntityAssetsTab.svelte:228` and `AccountWorkspaceView.svelte:342`. One typed owner; browser/F12 verification.
3. **Low operations risk:** identical 14-line child wait in `run-capped-testnet-gate.ts:228` and `run-mainnet-preflight-gate.ts:188`. Shared process helper preserving timeout/exit semantics.
4. **Scenarios/operators:** 46-line Bob credit setup repeated in `ahb.ts`/`lock-ahb.ts`; 15-line registry retry in `hub-node.ts`/`mm-node-core.ts`. Share fixture/operational helpers, not financial reducers.
5. **Caution:** duplicate validators in `core/storage/schema/account-layout.ts:169–184` and `entity/layout.ts:125–140`. Prove recovery roots before deleting either copy.
6. **Hard to own, not disposable:** `EntityPanelTabs.svelte` 2,917 LOC, `SwapPanel.svelte` 2,880, `Graph3DPanel.svelte` 2,635, `vaultStore.ts` 2,884, `core/api/runtime-adapter/resolve.ts` 2,208, `core/qa/report.ts` 2,998. Split by action/caller rather than deleting by length.
7. **Preserve archives:** `docs/releases/` contains 22 snapshot files / 57,571 lines. Future large source snapshots should be separate artifacts; preserve historical links.

**Handoff contract:** SHA, last green command, first red command/error, immutable artifact, next single command, remaining gates. For R/E/A/J: L1 vector → production-equivalent L2 → `bun run check`. Before recorder/replay/HLT/TPS, check `bun run stand:status` and hold the machine lock.

**Time control:** one verifiable result per attempt; after ten minutes without new evidence, record the first failure and change the hypothesis or verification method. Do not repeat the same command without changing its cause. One heavy stand, one owner per edited area, review after a stable diff. Current AGENTS.md and explicit owner instructions govern execution limits and delegation.
