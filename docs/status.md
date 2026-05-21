# XLN Status

This is the canonical status surface for XLN.

Use this file for:
- the current launch picture
- the blocker order
- the active engineering backlog
- the non-negotiable assumptions for the current network shape

Historical planning snapshots were moved to `docs/archive/planning/`.

## Current Snapshot

**Date:** 2026-05-21
**State:** pre-mainnet, testnet/prod-runtime hardening in progress

What appears true from the current docs set:
- the bilateral runtime and core consensus architecture exist and are actively exercised
- the largest remaining work is not protocol invention, but integration, recovery, security hardening, and operational cleanup
- several old status docs had diverged; this file replaces them as the source of truth

## Precedence

When docs disagree, use this order:

1. code + tests
2. `status.md`
3. `mainnet.md`
4. protocol/spec docs
5. archive docs

## Non-Negotiable Current Assumptions

These ideas were spread across older planning docs. They stay live here because
they still define the shape of the system.

### Network shape

- **Hub = normal entity.**
  No special consensus model for hubs. A hub is an entity with reserves,
  connectivity, and gossip metadata.
- **Runtime is the source of truth.**
  Frontends are readers/controllers, not authorities.
- **Bilateral state is the main execution surface.**
  The J-layer is the court and settlement anchor, not the fast path.
- **Transport must support direct/public runtime operation.**
  Relay and public WS exist to deliver messages, not to own protocol state.

### Product shape

- **USDC-first is acceptable only if explicit.**
  Silent single-token assumptions are not acceptable.
- **Recovery/watchtower is not optional for mainnet.**
  Offline users need a recovery/dispute story.
- **Debug surfaces are protocol infrastructure.**
  `/api/debug/events`, health, metrics, and replayability are part of the product.

## Blocker Order

These are the highest-value unresolved items after deduping older planning docs.

### P0 — launch blockers

1. **Contract integration coverage for the current Depository API**
   - old integration suite is still skipped or incomplete against the live ABI
   - exit: deposit, reserve transfers, settlement, dispute start/finalize, replay safety all covered on the current contract surface

2. **Explicit nonce / replay safety tests**
   - replay remains the highest-risk fintech failure mode
   - exit: one test proves replay revert, one proves nonce advancement exactly once across settle/finalize paths

3. **RPC settlement scenario**
   - BrowserVM coverage is not enough
   - exit: minimal `settle -> j_broadcast -> submitTx -> chain event -> workspace clear` scenario passes on local anvil/RPC

4. **Dispute E2E scenario**
   - dispute handlers exist, but the full unhappy-path scenario still needs proof
   - exit: unilateral dispute and counter-dispute flows pass end to end

5. **Recovery / watchtower implementation path**
   - the protocol draft exists; the implementation tracker must close the gap
   - exit: a documented minimum recovery path exists and is tested against offline/dispute failure modes

### P1 — mainnet hardening

6. **Restart / crash recovery soak**
   - restart behavior has improved, but still needs sustained proof
   - exit: kill/restart tests show no silent drift, no lost pending work, no split-brain behavior

7. **Long soak under load**
   - exit: multi-hour payment/swap/dispute run with stable memory and no consensus divergence

8. **Runtime transport operational cleanup**
   - bounded reconnect policy
   - clear transport readiness in health
   - one coherent deploy/setup path

9. **Persistence repair tooling**
   - checkpoint-first persistence is fine only if inspection/repair is operationally usable

10. **RPC state commitment quality**
   - RPC-side `stateRoot` / J-state commitment quality needs to match dispute/debug needs

### P2 — explicit product limits and cleanup

11. **Single-token vs multi-token clarity**
   - either multi-token works E2E or unsupported paths fail explicitly

12. **Custody / fee UX consistency**
   - custody balance and auto-fee flows are valid product bets, but they must read cleanly in UI and docs

13. **SettlementPanel path consistency**
   - decide whether the flow stays direct on-chain or moves behind entity/quorum semantics

14. **Activity / account-card polish**
   - present routing, HTLC, and J-event context cleanly enough for debugging and demo use

## Workstreams

### Contracts and J-Layer

- integration tests for current Depository API
- nonce/replay proofs
- RPC settlement and dispute scenarios
- explicit state commitment capture on RPC
- clear single-token policy until broader token support is real

### Runtime and Consensus

- restart/crash recovery soak
- long-running consensus soak
- exception policy cleanup:
  - `drop`
  - `defer`
  - `debug-assert`
  - `fatal`
- continue treating `consensus-invariants.md` as the living bug-prevention checklist

### Recovery and Offline Safety

- turn `recovery-watchtower-protocol.md` from broad draft into tracked implementation scope
- prove peer state refresh, recovery bundles, and dispute protection on realistic failure cases

### Transport and Ops

- bounded reconnect and better readiness semantics
- one deployment surface for frontend, runtime, relay, and anvil/testnet
- preserve health/metrics as first-class operational interfaces

### Product and UI

- simplify reserve-to-collateral UX
- keep dev/scenario surfaces out of the normal wallet path
- make settlements/disputes/recovery visible enough for a serious demo and for support/debug use

### Multisigner-First Direction

This remains active and should not disappear under status cleanup.

- one authorization envelope for entity actions
- proposer is coordinator, not implicit authority
- ingress verification is quorum-aware
- `1-of-1` is configuration, not a separate auth model
- J-batch auth moves to strict entity quorum semantics
- complex-board tests must exist, not just happy-path single-signer tests

### AI / Auxiliary Work

These are real backlog items, but not launch-defining:

- local model/tooling setup
- `piper` install for TTS
- AI UI polish issues such as visual speech indicator behavior

## What Moved Out

The following documents were not deleted for idea preservation; they were moved
because they had become snapshots rather than canonical status:

- `docs/archive/planning/todo-2026-03.md`
- `docs/archive/planning/next-2026-02.md`
- `docs/archive/planning/mvp-testnet-spec-2026-02.md`
- `docs/archive/planning/mainnet-readiness-2026-01.md`

Read them when you need historical context or the exact earlier wording.
