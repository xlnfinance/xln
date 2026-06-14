# XLN TODO

Last updated: 2026-06-15

This is the only live TODO/NEXT file for the repository. Older planning notes
under `docs/archive/` are historical evidence, not active backlog. When this
file and older docs disagree, prefer code and tests first, then this file.

## Closed Or Removed

- Removed the stale testnet handoff whose old faucet/runtime notes were from a
  retired stack and are not active release blockers.
- Removed the broken root `next.md` symlink to a non-existent planning path.
- Removed duplicated live TODO/NEXT pages from frontend static docs. The app
  should not serve stale February/May planning snapshots as current status.
- Merged `ai/todo.md` into this file as auxiliary work, then removed the
  separate AI TODO source.
- Removed old agent scratchpads and top-level audit drafts from the live tree.
  Current consensus/signature/contract concerns are represented below instead
  of scattered through dated request documents.
- Removed obsolete jurisdiction contract-size consultation notes that referred
  to pre-refactor `Depository.sol` structure.
- Closed as `v0.1.5` work: official same-origin watchtower endpoint, scheduler,
  public sweep closure, encrypted active tower remedy payloads, body caps,
  health stats caching, tower GC, runtime backup send barrier, browser recovery
  restart survival, and prod health recovery.
- Confirmed in the `0.1.5` release pass: `bun run gate:ci`,
  `bun run test:e2e:full`, `bun run test:e2e:prod:payment`, and
  `bun run prod:health` passed.
- Closed RPC J-replica state commitment placeholder: RPC/external
  jurisdictions now expose an explicit unavailable root instead of fake zero
  bytes; BrowserVM replicas must provide a real captured root.
- Closed destructive reset guardrails: mesh `/api/reset` now requires explicit
  destructive confirmation and token protection for public binds; browser
  `/resetdb` requires a nonce-cookie handshake, and restore/version failures no
  longer wipe local client state automatically.
- Closed persistence inspect/repair operator path: `bun run debug:persistence`
  inspects frame DB, snapshots, WAL tail, recovery bundles, and tower receipts;
  `--strict` turns warnings/critical findings into non-zero exit codes, and the
  command is inspect-only with explicit repair guidance instead of automatic
  persistence mutation.
- Closed the current RPC/JAdapter release blocker: ethers provider cache/batch
  behavior is disabled for XLN RPC providers, local Anvil latest-state
  `staticCall` snapshot races are tolerated only after successful gas estimate
  on dev chains, and fatal-log scanning no longer treats that handled dev race
  as a protocol failure.
- Confirmed on current `main` (`d328c43a`): `bun run gate:release` passed,
  production health smoke returned healthy, and a release soak was manually
  stopped after 13 complete `gate:ci + hub10k` iterations with exit code `0`.

## P0 - Release And Mainnet Readiness

1. **Publish the GitHub Release object for `v0.1.5`.**
   - Tag `v0.1.5` is pushed.
   - `gh release create` is blocked until `gh auth login` or `GH_TOKEN` is
     available in this workspace.

2. **Finish release-duration soak before any mainnet-candidate claim.**
   - Already passed for `0.1.5`: `gate:ci`, full browser E2E, prod payment E2E,
     prod health.
   - Passed on current `main`: `bun run gate:release`.
   - Partial evidence on current `main`: 13 full `bun run soak:release`
     iterations (`gate:ci` plus `hub10k`) passed before the run was stopped
     manually for time.
   - Still needed for a mainnet candidate: a complete uninterrupted
     multi-hour `bun run soak:release`.

3. **Make real mainnet ops explicit.**
   - Chain/RPC endpoints selected and documented.
   - Funded operator/tower accounts and gas policy documented.
   - Backup/restore and incident drills run against production-like data.
   - Monitoring and alert thresholds cover runtime, relay, storage, market
     maker, and watchtower.

4. **External audit handoff.**
   - Refresh `docs/security/external-audit-brief.md`.
   - Produce the current audit pack with `bun run security:audit-pack`.
   - Do not treat internal E2E success as a substitute for audit on real funds.

## P1 - Protocol And Runtime

1. **Peer State Refresh (PSR).**
   - Define and implement the live peer refresh wire flow from
     `docs/recovery-watchtower-protocol.md`.
   - Exit: a wiped client can recover from honest peer/hub state even when the
     tower is unavailable.

2. **Recovery coverage UX and receipts.**
   - Show local, tower backup, delayed-last-resort, and peer-refresh coverage
     per runtime/account.
   - Surface last successful tower upload height and failure reason.

3. **Typed failure taxonomy across runtime and ops.**
   - Split failures into explicit categories instead of treating every loud
     error as the same kind of stop.
   - Baseline categories: `Contradiction` is fatal and halts,
     `ExpectedEmpty` is normal empty state, `TransientRace` retries with a
     bounded TTL and only becomes fatal after expiry.
   - Apply first to transport, bootstrap, faucet/seed funding, market maker,
     settlement batching, and health readiness before touching consensus hot
     paths.
   - Exit: orchestrator/health can explain why a component is degraded without
     guessing from logs or swallowing real contradictions.

4. **Consensus and Hanko production review.**
   - Re-check current account commit semantics, settlement hankos,
     chain/contract domain separation, J-event finalization, and mempoolOps
     against the current code instead of old audit snapshots.

5. **Contract governance/access-control scan.**
   - Re-run a current pass over `EntityProvider`/`Depository` for permission
     checks, gas bounds, and public debug surfaces before external audit.

6. **One delivery abstraction.**
   - Collapse direct-vs-relay send logic, pending queues, TTLs, retries, and
     ACK interpretation into one transport boundary.
   - Relay is the official baseline; direct delivery is an opportunistic fast
     path with the same bounded queue semantics.
   - Exit: callers receive one typed delivery result and no longer reimplement
     retry/defer/fatal decisions per call site.

7. **Canonical identity refs.**
   - Treat jurisdiction/entity/account refs as protocol identity and display
     names as cosmetic only.
   - Delete alias allowlists and name-based matching from runtime, market maker,
     health, and tests.
   - Exit: adding a new testnet label cannot break hub/MM matching.

8. **Canonical fill and amount representation.**
   - Exact bigint amounts are the source of truth.
   - `uint16` fill ratios are a one-way lossy projection for on-chain
     hash-ladder proofs only; never round-trip ratio data back into exact
     settlement amounts.
   - Exit: cross-j orderbook, claim, settlement, and dispute paths share one
     precision boundary and one set of dust/rounding invariants.

9. **Bootstrap lifecycle as an explicit state machine.**
   - Model startup phases and barriers the same way protocol state is modeled:
     P2P, relay, hubs, custody, MM same-chain offers, MM cross offers,
     watchtower, health.
   - A send/seed/quote action should be impossible before its barrier is met.
   - Exit: production health can show the exact blocked phase and dependency.

10. **Orchestrator blast-radius boundaries.**
    - Decouple child process supervision from whole-tree failure.
    - Ancillary feature failure degrades that feature and keeps diagnostics
      queryable; protocol contradiction remains a loud fatal stop.
    - Exit: faucet/demo/MM/watchtower failure cannot take down the health
      endpoint needed to debug the node.

11. **Settlement conservation proof.**
    - Prove fund conservation across `pull_lock -> resolve -> on-chain release`
      on both legs, including debt/collateral and dispute finalization.
    - Cover `_disputeFinalizeInternal` line-by-line with adversarial fixtures.
    - Exit: external audit gets executable invariants, not just E2E success.

12. **Economics and scale validation.**
    - Document fee design, collateral ratios, market-maker incentives, and
      griefing costs for swaps and disputes.
    - Profile runtime/orderbook/MM under contention before raising real-money
      limits.
    - Exit: mainnet limits are backed by measured capacity and explicit
      incentive assumptions.

## P2 - Product And UI

1. **Lending tab.**
   - Product/runtime design lives in `docs/lend.md`.
   - Do not mix this with the current production swap/health gate.
   - Exit: hub lending pools, fixed-term lend/borrow/repay lifecycle, and
     browser E2E are green on Testnet and Tron.

2. **Token support boundary.**
   - Either prove multi-token collateral E2E or keep the product explicitly
     USDC/single-token for the current release line.

3. **Custody and fee UX.**
   - Make custody balance and auto-fee behavior read as one coherent flow.

4. **SettlementPanel consistency.**
   - Keep direct on-chain flows and entity/quorum flows visually and logically
     distinct.

5. **Activity/account-card context.**
   - Show routing, HTLC, swap, J-event, dispute, and recovery events clearly
     enough for demo and support/debug use.

## Auxiliary AI Work

These are useful local-product tasks but not XLN launch blockers.

- Finish GPT-OSS 120B MLX download at `~/models/gpt-oss-120b-heretic-mlx`.
- Install `piper` so `/api/synthesize` can produce voice locally.
- Fix the green visual speech indicator in `/ai`.
