# Hash-ladder reveal registry — spec

Sprites-style: the preimage reveal leaves the bilateral dispute path and becomes
a standalone, authenticated record in the Depository. Cross-j swaps then settle
**exclusively** from that record and never from calldata.

## Storage

```solidity
struct Reveal {      // one slot: 16 + 64 bits used
  uint16 ratio;      // fill ratio, same quantization as claims: floor(A*x/65535)
  uint64 blockNumber;// block at which this reveal was registered
}
mapping(bytes32 entityId => mapping(bytes32 ladderHash => Reveal)) hashladder;
```

Key is `(entity that revealed, ladder hash)` — never hash material alone.
Keying by hash alone is unsafe: same-J cross-token routes are legal
(`index.ts:1309` only rejects same-J same-token) and one order may deliberately
reuse its ladder (`pull.ts:212`).

## Write path

- Only through `processBatch`, which authenticates the requesting entity. The
  `entityId` in the key is therefore always the caller. A hub cannot write under
  a user's key, so it cannot reveal 1% on the user's behalf.
- One reveal carries the **whole** secret chain plus the ladder data. The
  contract verifies the secrets against the commitment and derives `ratio`
  itself; the caller never asserts a ratio.
- Because the reveal is single-shot and complete, two parties revealing the same
  ladder publish identical material. The old forgery (reveals at 4095 and 4096
  combine into a valid 8191, ~6.25% of notional) required *per-level* reveals,
  which were implemented and then removed. It does not arise here.
- **Overwrite is allowed.** A later registration by the same entity replaces its
  record. This is the defence against a hub replaying a reveal from an earlier
  dispute: the user can overwrite with the correct ratio.

## Read path — the invariant

Cross-j settlement must depend on **no calldata argument**. Today
`DeltaTransformer.verifiedPullFillRatio` is `private pure` and takes the ratio
entirely from `pullArg` — 32 bytes means full secret and 65535, 130 bytes means
the ratio is read straight out of the first two bytes. Both branches are
deleted.

Instead, each leg reads the record of **its own** counterparty entity:
- source leg reads the source hub entity's record,
- target leg reads the user entity's record.

The transformer already receives the entity for the leg it settles, so no
cross-chain identity mapping is needed; the same entity does not have to exist
under one id on both chains.

`pure` cannot read storage, so the ratio is resolved by the Depository and the
transformer signature changes accordingly (`applyBatch` also gains the reveal
deadline, see below).

## Window

Registration is always permitted; validity is decided at transform time. Checking
at registration would leave the §5.3 hole — a hub registers early against an
account with no active dispute and the global record then counts inside the
disputed one.

The dispute clock is measured in **blocks**, not wall timestamps. `pull.revealedUntilTimestamp`
is ABI legacy and ignored for pull settlement. Valid iff:

```
revealedBlock != 0 && revealedBlock <= disputeStartBlock + (disputeTimeout - disputeStartBlock) / 2
```

`T` is the **full** dispute period (`disputeTimeout - disputeStartBlock` blocks).
The beneficiary must register by `T/2`; the remaining half is the port/settle
buffer. Different wall-clock T across chains is allowed (different block times);
equal bilateral delay *config* is the prepare-time rule. Seeing a dispute on any
sibling leg auto-starts disputes on all siblings so every clock starts in time.

There is deliberately **no lower bound** on `revealedAt`. It was considered and
rejected by the owner: because the key includes the revealing entity and each
leg reads only its own counterparty's record, a stale record can never be
weaponised against another party. Keeping an old reveal as a floor that the user
may outbid at will is the useful behaviour; a hub that registers a ratio lower
than its own earlier one is simply hurting itself.

A late reveal is not rejected at write time — it is recorded and read as
`ratio = 0`.

## Barrier

Finalization is impossible while `block.number < disputeTimeout` on **both**
paths (timeout and counterparty-signed). `applyPull` reverts with
`PullRevealWindowActive` until full T elapses.

## Attack catalog — tests before Solidity

1. Hub reveals 1% under the user's key → impossible: `processBatch` binds the
   key to the caller.
2. Hub replays a reveal from a previous dispute → the user overwrites it with
   the correct ratio. Overwrite exists precisely for this.
3. Hub never reveals by `T/2` → its own leg reads 0. Silence costs the silent
   party, so the incentive points the right way.
4. Late reveal overwrites a timely one → self-inflicted only, since no other
   entity can write that key. Confirm it cannot be triggered by a third party.
5. Early finalize by the counterparty → blocked by the barrier, both paths.
6. Starter blindness: secrets arriving after `disputeStart` still count, because
   the registry is consulted at transform time rather than frozen into the
   starter's arguments.
7. Staggered per-pull deadlines against one scalar `starterArgumentsTimestamp`.
8. Quantization dust: on-chain claim is `floor(A*x/65535)`; the runtime must
   commit through the identical formula or disputed and off-chain amounts
   diverge.
9. Registry key collision: same-J cross-token routes and deliberate ladder reuse
   must not collide — covered by keying on `(entity, ladderHash)`.
10. Draining reserves during the IOU window.
11. Double claim / nullifier bypass.
12. Proof-body ceilings: ~192 bytes per pull in the body (176KB cap shared with
    HTLCs, swaps and subcontracts) and ~224 bytes per pull argument against a
    64KB starter-argument cap — about 145 claimable pulls per side.

## Machine-checked invariant

After the change no ratio may be derived from calldata in the transformer. This
is greppable and belongs in `check:*` alongside the other contract invariants,
so it cannot silently regress.
