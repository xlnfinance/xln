# Hash-ladder reveal registry — spec

Sprites-style: the preimage reveal leaves the bilateral dispute path and becomes
a standalone, authenticated record in the Depository. Cross-j swaps then settle
**exclusively** from that record and never from calldata.

## Storage

```solidity
// Packed in one slot: high bits = revealedAt (unix seconds), low 16 = ratio
mapping(bytes32 entityId => mapping(bytes32 ladderHash => uint256 packed)) hashLadderReveals;
// view: getHashLadderReveal(entity, ladderHash) → (uint16 fillRatio, uint256 revealedAt)
```

Key is `(entity that revealed, ladder hash)` — never hash material alone.
Keying by hash alone is unsafe: same-J cross-token routes are legal and one
order may deliberately reuse its ladder.

## Write path

- Only through `processBatch`, which authenticates the requesting entity. The
  `entityId` in the key is therefore always the caller. A hub cannot write under
  a user's key, so it cannot reveal 1% on the user's behalf.
- The caller supplies `fillRatio` plus ladder material; the contract verifies
  partial/full proofs against the commitment (`verifyPartial` / `verifyFull`).
- **Single-shot:** first successful write locks both `fillRatio` and
  `revealedAt`. Same-ratio retry is a no-op (idempotent). Any other overwrite
  reverts `E12`. Counterexample rejected: dust bookmark before `T/2` then raise
  to full after `T/2` would still settle full under sticky-time raises.
- Publishing reveal material in events is still required for porting. With
  single-shot, only one authorized level is ever registered per ladder slot.

## Read path — the invariant

Cross-j settlement must depend on **no calldata fill argument**. Each leg reads
the registry record of **its beneficiary** entity via
`getHashLadderReveal` (source hub / target user as coded in `applyPull`).

## Window

**Invariant (owner):** a reveal is active for settlement only if its
`revealedAt` is at or before `start + T/2`. Anything later is late → reads as
**fill 0**. Only the pre-`T/2` registration is economically live. Write path
never rejects late registrations; finalize/transform enforces the cutoff.

Registration is always permitted; validity is decided at transform time.

The dispute clock is measured in **jurisdiction unix seconds**
(`block.timestamp`), not blocks. Pulls have no sealed market-expiry deadline;
settlement is dispute-relative. Valid iff:

```
revealedAt != 0
&& revealedAt <= disputeStartTimestamp + (disputeTimeout - disputeStartTimestamp) / 2
```

`disputeTimeout` is the **absolute** unix end of the challenge window.
`T = disputeTimeout - disputeStartTimestamp` (seconds). The beneficiary must
register by `start + T/2`; the remaining half is the port/settle buffer.
Different wall-clock T across chains is allowed; equal bilateral delay *config*
is the prepare-time rule. Seeing a dispute on any sibling leg auto-starts
disputes on all siblings so every clock starts in time. There is **no**
cross-j admission margin between Ts — sibling entities share a runtime and
fanout is event-driven (**must-close**).

There is deliberately **no lower bound** on `revealedAt` beyond presence. A
stale record can never be weaponised against another party because the key
includes the revealing entity and each leg reads only its beneficiary's record.

A registration whose `revealedAt` is after `start + T/2` is not rejected at
write time — it is recorded and read as `ratio = 0` at finalize.

## Barrier

Finalization is impossible while `block.timestamp < disputeTimeout` on **both**
paths (timeout and counterparty-signed). `applyPull` reverts with
`PullRevealWindowActive` until full T elapses.

## Attack catalog — tests before Solidity

1. Hub reveals 1% under the user's key → impossible: `processBatch` binds the
   key to the caller.
2. Hub raises after first reveal → `E12` (single-shot).
3. Hub never reveals by `T/2` → its own leg reads 0. Silence costs the silent
   party.
4. Late first registration → recorded but settle 0.
5. Early finalize by either path → blocked by the full-T barrier.
6. Starter blindness: secrets arriving after `disputeStart` still count, because
   the registry is consulted at transform time rather than frozen into the
   starter's arguments.
7. Quantization dust: on-chain claim is `floor(A*x/65535)`; the runtime must
   commit through the identical formula.
8. Registry key collision: same-J cross-token routes and deliberate ladder reuse
   must not collide — covered by keying on `(entity, ladderHash)`.

## Owner decisions

- **T/2 cutoff:** late `revealedAt` ⇒ settle 0. Only pre-`T/2` reveal is active.
- **Single-shot reveal:** first write locks ratio + time; no raise (`E12`).
- **Runtime exact-once queue:** never max-ratio replace a pending/sent/on-chain
  ladder write — a higher retry would revert the whole `processBatch` and poison
  co-batched finalizations. Mirror: `route.registryFillRatio` + draft/sent check.
- **Sibling fanout:** must-close — observing one leg auto-starts the sibling
  dispute (source reveals must be squeezable for the target). Missing signer
  binder on a live route throws.
- **Cross-j ProofBody:** always includes pulls (route + encoded DeltaTransformer
  batch); otherwise not a cross-j leg.
- **Symmetric T/2 on both legs:** intentional — no admission margin / asymmetric
  porter window. Port race after late reveal is accepted residual; fanout only
  aligns clock *start*.
