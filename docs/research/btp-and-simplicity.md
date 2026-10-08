# BTP versus xln, and what to borrow for simplicity

Reviewed 2026-10-07 against xln `d6a0845fd96c885f3033c2752aad493ab7103661`.
Read-only: no core, contract or protocol change was made. This complements
[provable-account-mechanisms.md](provable-account-mechanisms.md), which
compares features; this report asks only **what makes xln simpler and harder to
break**. Recommendations marked _owner choice_ change consensus or contracts.
[channel-protocol-shapes.md](channel-protocol-shapes.md) puts twelve designs
side by side and works the one-signature idea and a Lightning-style `account_reestablish`
out to hash layout and adversarial checks.

## Verdict

- **Simpler: BTP**, by about two orders of magnitude. It is a 4-packet RPC
  framing layer for WebSockets, not an account protocol.
- **Better for holding value: xln**, decisively. BTP signs nothing, agrees on
  no state, and its `Transfer` is a non-idempotent increment. A lost
  `Response` leaves the balance unknowable, and nothing is enforceable by a
  third party.
- To make BTP safe you would have to add signed absolute state, idempotent
  replay, durable recovery, an adjudicator and collateral, which is xln's core.
  The useful comparison is therefore **per guarantee**, not per line.

## BTP 2.0 against the xln Account layer

| Property            | BTP 2.0 ([RFC 0023](https://interledger.org/developers/rfcs/bilateral-transfer-protocol/)) | xln Account                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Wire kinds          | 4: `Message`, `Transfer`, `Response`, `Error`                                              | 4: `ack`, `ack_frame`, `dispute`, `board_hanko_refresh` (`core/types/account.ts:442-458`)                       |
| What changes value  | `Transfer.amount`: _"additional value … compared to the previous settlement state"_        | Signed frame over txs **and** absolute post-state root (`account/consensus/frame/hash.ts:114-125`)              |
| Agreement           | "Authoritative State" kept by one or both peers; may diverge on expiry                     | Both Hankos on the same `stateHash`; mismatched root rejected                                                   |
| Duplicates          | Request IDs _"are not idempotent"_, explicitly for speed                                   | Exact retry re-ACKs from cache; different bytes at same height rejected (`incoming/replay.ts:131-162, 410-512`) |
| Authentication      | Bearer `auth_token` once per connection                                                    | secp256k1 hello challenge + X25519/HKDF session + AEAD, `encSeq` exactly +1 (`network/p2p/ws-protocol.ts`)      |
| Enforcement         | Out of scope (sub-protocols)                                                               | J dispute: start/counter/finalize, newer nonce wins (`jurisdictions/contracts/Account.sol`)                     |
| Credit / collateral | Out-of-band connector config                                                               | In signed Delta: collateral, ondelta/offdelta, credit limits, allowances, holds                                 |
| Crash recovery      | Undefined                                                                                  | WAL replay + flat outbox re-emit of exact signed bytes                                                          |
| Error semantics     | `T00` retry 1–60 s; `F00–F08` never retry                                                  | 23 typed `AccountInputRejectionCode`s, local only, no retry class (`account/input/input-rejection.ts:9-32`)     |
| Size                | ~300-line spec                                                                             | 5,938 LOC Account consensus; 131,782 LOC core TS; 6,557 LOC Solidity                                            |

**Already better than BTP.** xln signs absolute post-state, is idempotent at
the frame level, and uses end-to-end ACK as the completion signal. The comment
in `ws-protocol.ts:61-66` forbids a second, transport-level receipt layer;
that is the end-to-end argument done correctly.

**Worth copying from BTP:**

1. **Retry classes.** `T` (retry the same bytes later) versus `F` (never retry
   these bytes) is the smallest useful error taxonomy. xln's 23 codes have no
   class, and the peer never learns input-level rejects. Lower priority than
   first stated: signed-invalid frames already escalate to dispute.
2. **Silence on unexpected or unreadable input** to prevent feedback loops.
   xln already behaves this way; keep it if a reject notice is added.
3. **One primary action per request.** xln matches this per AccountTx.

**Explicitly avoid:** incremental amounts, non-idempotent IDs, trusted
"authoritative state" and bearer-token-only authentication.

## Ideas after a second code check (2026-10-07)

The first draft ranked eight ideas. Each was re-checked against current code
at the same SHA; three were wrong or overstated and are corrected below.

### Confirmed gaps, in priority order

| #   | Idea and source                                                                                                                       | Code fact                                                                                                                                                                                                                                                                                                                                                                                                                            | Change                                                                                                                                                                                        | Cost                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| A   | **Maximum HTLC horizon.** BOLT2 `max cltv_expiry`, ILP short expiry                                                                   | Forwarding checks only a _minimum_ deadline (`entity/paybook/materialize-context.ts:237-242`, `deadline_unsafe`); `HTLC` constants have only `MIN_*` values (`config/constants.ts:154-176`); the Account lock checks only "already expired" (`account/tx/handlers/htlc/lock.ts:42-46`). A lock expiring in years is forwarded and freezes the hub's outbound capacity for that long, financed by credit the hub granted the attacker | Reject forward/lock when `timelock > now + MAX` or `revealBeforeHeight > finalizedJ + MAX` (honest default expiry is 30 s, `DEFAULT_EXPIRY_MS`)                                               | Very low            |
| B   | **Admission must fit one J finalization.** Hydra future-exit check                                                                    | Legal maximum Account (128 tokens, 32 payments, 32 swaps, 18 pulls) costs 17,363,517 gas against XLNC's 6M (`jurisdictions/test/foundry/stress/BatchBounds.t.sol:260`); no gas-aware admission exists in `core/account` or `core/entity`                                                                                                                                                                                             | Replace independent count limits with one weighted bound `finalizeGas(dimensions) ≤ budget`. Already the open owner choice in [jea-continuation.md](../jea-continuation.md)                   | Low–medium          |
| C   | **Stateless collision rule.** [Lightning `option_simplified_update`](https://github.com/lightning/bolts/pull/867), Starlight tiebreak | Rollback runs only after the winner validates and is committed in the same transition (`account/consensus/index.ts:848-874`), so the duplicate guard (`collision.ts:153` TS continue, `rscore/.../incoming/apply.rs:676-680` Rust reject) is unreachable; TLA agrees (`RbNotReached`)                                                                                                                                                | Delete `rollbackCount` / `lastRollbackFrameHash` from both engines, checkpoint wire (`rscore/crates/batch/src/checkpoint_wire/rows.rs:190`) and storage tags 23/24, with an offline migration | Low, _owner choice_ |
| D   | **Basic multipart payment.** BOLT4 MPP                                                                                                | A second lock with an active hash is rejected (`committed-htlc-followups.ts:103-110`, `hashlock_already_active`)                                                                                                                                                                                                                                                                                                                     | Receiver accepts same-hash locks across its accounts until the encrypted total is reached, then reveals once; otherwise cancels all                                                           | Medium              |

### Withdrawn or demoted after the check

| Draft idea                            | Correction                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exactly-once payment IDs              | **Already implemented.** `recordRuntimeAdapterCommand` keeps lane, sequence, `commandId` and `inputHash`; a retry returns the prior result and a reused ID with a different payload is rejected (`api/runtime-adapter/server.ts:975-1005`, `runtime/command/frontier.ts`). Merchant order identity remains a product feature, not a protocol gap. |
| Peer-visible reject / signed NACK     | **Demoted.** A signed frame that fails deterministic replay already escalates to `DisputeRequired` (`account/consensus/index.ts:781-793`). Only input-level rejects (clock, profile, hash) are silent; that is an upgrade-discipline issue.                                                                                                       |
| One signature per state               | **Demoted.** Two hashes per epoch are real (`entity/consensus/input/hanko-witness.ts:485-493`), but settlement still needs its own post-settlement dispute Hanko, so the saving is below one signature per frame and requires a frozen-core change.                                                                                               |
| Close that cannot fail                | **Dropped.** `settle_update` could be replaced by reject + propose (`entity/tx/handlers/payments/settle.ts:7-11`); the gain is small.                                                                                                                                                                                                             |
| Proof of liabilities, VOPR simulation | Not protocol gaps. Simulation remains the proof programme's C9/C10.                                                                                                                                                                                                                                                                               |

### Why the collision rule can be stateless

The repo's own TLA run ([proofs/tla/report.md](../../proofs/tla/report.md))
gives three facts:

1. **The guard is dead code in normal operation.** It is unreachable without a
   crash fault (`RbNotReached` holds; 337,955 states).
2. **The fault that does reach it breaks both engines, in different ways.**
   That fault is a crash which saves the rollback but loses the winning commit.
   After it, TypeScript strands txs (`OrphanPending` violated) and Rust
   deadlocks (`CollisionTermination` violated).
3. **The engines already diverge on exactly these lines.** TS
   `collision.ts:153` continues; Rust `engine/.../incoming/apply.rs:679`
   rejects with `ROLLBACK_DUPLICATE`.

Deleting the memory removes the divergence, two durable fields and BUG-05's
precondition at once. Verification is cheap: rerun the six existing configs
with the fields removed and expect every invariant plus `CollisionTermination`
to hold.

Full turn-taking was weighed and rejected for now. The Lightning PR adds
`yield`/`update_noop` messages and a turn wait, and it was **closed unmerged
on 2026-05-30**. xln's existing one-proposal-in-flight plus LEFT-wins already
gives single-writer-per-height with fewer messages.

## Considered and not recommended

| Idea                                                                         | Reason                                                                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starlight merge-on-collision                                                 | Correct only for commutative payments. xln txs (swaps, locks, settlement) are not commutative.                                                        |
| Vector one-round sync (_"behind by one update"_)                             | Already equivalent: `ack_frame` piggyback plus cached re-ACK.                                                                                         |
| LN-Symmetry / eltoo                                                          | Already the xln model: newer nonce wins, no penalty; a tower needs only the latest proof.                                                             |
| ILP packetized payments                                                      | Bounds per-packet risk because ILP lacks enforceable conditions. xln's signed locks are J-enforceable; idea A's horizon cap captures the useful part. |
| ILP rule _"settlement for one account MUST NOT depend on any other account"_ | Deliberate difference: the Depository debt queue links an Entity's accounts by insolvency design. Document it, don't change it.                       |
| Canton/Daml 2PC with mediator and sequencer                                  | Adds a third party to every update. xln's bilateral Hanko plus J already gives finality without one.                                                  |

## Next single steps

1. Idea A: add the maximum-horizon reject next to `deadline_unsafe` with a
   regression test for a far-future forwarded lock.
2. Idea B: owner chooses the XLNC capacity versus admission bound; then one
   weighted admission inequality replaces the separate count limits.
3. Idea C: TLA variant with the fields deleted, then the two-engine deletion.

## Limits

- Source study, not execution. No upstream test suite was run.
- xln counts come from a read-only inventory at the SHA above.
- Lightning force-close root-cause statistics were not found in a primary
  source; anecdotal reports (reestablish desync, fee disagreement, HTLC
  deadline cascades) are not ranked here.
- The first draft overstated three ideas; the corrections above were checked
  against code at the stated SHA.

## Sources

[BTP 2.0](https://interledger.org/developers/rfcs/bilateral-transfer-protocol/) ·
[ILP architecture](https://interledger.org/developers/rfcs/interledger-architecture/) ·
[ILP over HTTP](https://interledger.org/developers/rfcs/ilp-over-http/) ·
[BOLT PR 867](https://github.com/lightning/bolts/pull/867) ·
[option_simple_close](https://bitcoinops.org/en/newsletters/2023/07/26/) ·
[Vector protocol](https://github.com/connext/vector/blob/main/modules/protocol/README.md) ·
[Starlight protocol](https://github.com/hamidire/starlight/blob/main/starlight/doc/Protocol.md) ·
[XRPL payment channels](https://xrpl.org/docs/concepts/payment-types/payment-channels) ·
[TigerBeetle create_transfers](https://docs.tigerbeetle.com/reference/requests/create_transfers/) ·
[TigerBeetle safety](https://docs.tigerbeetle.com/concepts/safety/) ·
[TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md) ·
[Mojaloop invariants](https://docs.mojaloop.io/community/standards/invariants.html) ·
[Summa](https://pse.dev/projects/summa) ·
[Canton synchronizer](https://docs.canton.network/overview/reference/synchronizer-overview)
