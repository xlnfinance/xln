# XLN TODO

Canonical TODO, merged from:
- `NEXT-SESSION.md`
- `docs/next.md`
- `docs/todo.md`
- `ai/todo.md`

Closed items from the old session notes were intentionally removed.
In particular, the old `xlnomy1`/CORS/testnet-faucet/jMachines blockers are no longer active.

## Runtime / Product

1. Contract integration coverage for current Depository API.
Status: open.
Why it stays:
- `jurisdictions/test/Depository.integration.ts` is still `describe.skip`
- it still carries the TODO to update to current `processBatch/unsafeProcessBatch`
Exit:
- hardhat integration suite covers reserve transfer, settlements, dispute start/finalize, replay/nonce safety on the current ABI.

2. Explicit nonce / replay safety tests.
Status: open.
Why it stays:
- still no narrow test proving batch replay reverts and nonce always advances exactly once.
Exit:
- one test submits a valid batch, replays it, and gets revert
- one test proves nonce increment after settle/finalize paths.

3. RPC settlement scenario as a first-class scenario.
Status: open.
Why it stays:
- there is broad scenario coverage, but not a clearly named minimal `settle -> j_broadcast -> submitTx -> chain event -> workspace clear` RPC scenario.
Exit:
- a dedicated RPC settlement scenario exists and is green on local anvil.

4. Restart / crash recovery soak.
Status: open.
Why it stays:
- restart health/bootstrap is now fixed, but there is still no long-running proof that pending work survives ugly restarts without drift.
Exit:
- kill/restart soak test shows no silent loss, no dual-runtime weirdness, and clean recovery of pending work.

5. Long soak under load.
Status: open.
Why it stays:
- still no multi-hour payment/swap/dispute soak proving memory and consensus stability.
Exit:
- sustained run with stable memory, no stuck queues, no consensus divergence.

6. Single-token vs multi-token contract.
Status: open.
Why it stays:
- the stack clearly supports USDC-first flows, but the old MVP note about token assumptions is still directionally true.
Exit:
- either multi-token collateral/reserve flows are fully supported end-to-end
- or the API/UI reject unsupported token paths explicitly.

7. RPC `stateRoot` / J-state commitment quality.
Status: open.
Why it stays:
- old MVP notes about weak RPC-side J commitment/state-root handling were never explicitly closed.
Exit:
- RPC J-side state commitment is captured and usable for replay/dispute/debug parity.

8. Gossip freshness / encrypted routing fallback audit.
Status: open.
Why it stays:
- old MVP note about stale gossip leading to degraded routing/encryption behavior was never explicitly closed with a targeted test.
Exit:
- targeted test proves peer keys refresh in bounded time and onion/encrypted path is used without cleartext fallback in the intended flow.

9. `reserve -> collateral` UI simplification.
Status: open.
File:
- `frontend/src/lib/components/Entity/EntityPanelTabs.svelte`
Task:
- keep exact-amount transfer only
- remove percent presets from this flow.

10. `SettlementPanel` transfer path consistency.
Status: open.
Task:
- decide whether this stays a direct on-chain `submitReserveToReserve`
- or moves behind entity-tx + quorum flow for consistency with the rest of the product.

## Multisigner-First

Goal: single-signer must remain just `1-of-1`, not a separate auth model.

1. Define one authorization envelope for all entity actions.
- Include `entityId`, action hash, quorum hanko, nonce/domain.
- Remove semantics where `signerId` alone implies authorization.

2. Keep proposer as coordinator only.
- proposer may coordinate/propose/precommit
- proposer alone must not authorize state-changing entity actions.

3. Make ingress verification quorum-aware.
- validate hanko against board + threshold for every action class
- reject proposer-only auth outside explicit demo-only paths.

4. Unify signing APIs around quorum primitives.
- replace single-signer helper usage in live action paths
- keep `1-of-1` as configuration, not a separate code path.

5. Tighten board-of-record rules.
- prefer local replicated board config
- define first-contact / gossip fallback rules explicitly
- keep replay deterministic.

6. Migrate J-batch auth to strict entity quorum.
- every batch submit path uses validated quorum hanko
- remove implicit proposer signing assumptions.

7. Add complex-board tests.
- `1-of-1` parity
- `7-of-10` happy path
- insufficient quorum rejection
- circular board claim validation
- proposer compromise simulation.

## AI

1. GPT-OSS 120B MLX download.
Status: in progress.
Location:
- `~/models/gpt-oss-120b-heretic-mlx`

2. Install `piper` TTS.
Status: open.
Why it stays:
- `ai/todo.md` says `/api/synthesize` still returns `400` when `piper` is missing.

3. Fix green visual speech indicator in `/ai`.
Status: open.

## Notes

- `NEXT-SESSION.md` is now historical, not canonical.
- `docs/next.md` still contains useful audit debt, but `docs/todo.md` should be treated as the active list.
- `ai/todo.md` still exists as a local workspace note, but its open items are mirrored above.
