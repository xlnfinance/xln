# Hash-ladder reveal registry — canonical spec

Cross-j Pull settlement reads authenticated Depository state, never a caller's
dynamic fill argument. Jurisdiction clocks are unix seconds; runtime stores unix
milliseconds and converts only at the boundary.

## Signed authority and storage

```solidity
// targetRole is a separate namespace; packed = revealedAt << 16 | fillRatio
mapping(bytes32 revealerEntity =>
  mapping(bytes32 counterEntity =>
    mapping(bytes32 ladderHash =>
      mapping(bool targetRole => uint256 packed)))) records;
```

The key is `(revealerEntity, counterEntity, ladderHash, targetRole)`. The order
is consensus-critical and is never sorted: the reverse pair is another slot.
`revealerEntity` comes only from the outer Hanko-authenticated `processBatch`;
registration supplies `counterEntity`. A false counterparty creates an inert
record outside the Pull's exact ordered Account namespace.

The witness remains independent of ProofBody: `processBatch` authenticates the
revealer, while the hash-ladder proof authenticates the ratio. A first Source
write additionally requires an active ordered Account dispute and its signed
revealer-side window; otherwise an early write could consume the immutable
slot before `S`. Target remains freely refreshable. No ProofBody or Pull index
exists in registration calldata.

## Write policy

- Source (`targetRole=false`) is single-shot. An exact retry is a sticky no-op;
  a different second ratio reverts `E12`.
- Target (`targetRole=true`) is replaceable. A lower ratio reverts `E12`, an
  exact or higher ratio refreshes the timestamp, and a higher ratio atomically
  replaces progress. This permits pre-existing public evidence to be
  republished inside a newly opened target dispute window.
- Every successful new record verifies full or partial hash-ladder material and
  emits the portable witness. Source and Target policy comes from the signed
  Pull, never caller calldata.

There is no global ladder guard. Ordered Account scoping makes unrelated-account ladder
reuse inert; Runtime admission still rejects ambiguous reuse inside one Account.
The signed Pull binds the exact commitments and role at settlement.

## Per-Account reveal window

For both roles, validity uses the dispute start of the Account being settled:

```text
S = disputeStartTimestamp
W = leftResponseSeconds  when Pull beneficiary is left
    rightResponseSeconds when Pull beneficiary is right

valid = revealedAt >= S && revealedAt <= S + W
```

Both bounds are inclusive. The lower bound rejects a record from an older
dispute after accidental ladder reuse. A zero window is valid bilateral policy:
start and registration can execute in one block because Depository processes
`disputeStarts` before `hashLadderRegistrations`.

Source and Target have independent Accounts and independent starts. A Target
does not wait for a synthetic "second phase"; its window opens at its own `S`.
Sibling dispute fanout is must-close so every required Account obtains its own
clock promptly.

## Settlement and finalization barrier

The signed Account clock must satisfy:

```text
T = S + leftResponseSeconds + rightResponseSeconds
```

If the final ProofBody contains a Pull, both timeout and counterparty-signed
finalization paths must wait until `block.timestamp >= T`. This barrier prevents
one chain settling at zero before evidence can be published on its sibling.
A Pull-free ProofBody has no registry barrier, but the channel role still
matters. The non-starter may immediately accept the state selected and signed
by the starter: its fresh outer Hanko makes the close mutual. The starter has
no fresh response and must wait until `T`; otherwise an old counterparty
signature would become an immediate unilateral close.

For a signed Pull with `claimedRatio`, final effective ratio is:

```text
effective = max(claimedRatio, timelyRegistryRatio)
timelyRegistryRatio = record.fillRatio when record is inside [S, S+W], else 0
```

Delta is `floor(amount * effective / 65535)` minus the already signed claimed
portion. Runtime terminal accounting must use the exact final ProofBody and the
timestamped record before retiring active-dispute evidence; a raw late Target
event must never overwrite `claimedRatio`.

## Runtime parity

- Draft registration dedupe keys by `(revealer, counterparty, ladderHash, role)`.
- Registration carries no ProofBody authorization. Runtime buffers a verified Target port
  until the target Account has a draft/observed dispute so the write lands
  inside the only window where it can affect settlement.
- Own-slot `sourceRegistryFillRatio/targetRegistryFillRatio` fields are queue
  latches, not settlement truth. Timestamped Source/Target records mirror chain
  state for exact finality calculation.
- Source keeps the first deferred witness. Target keeps the latest monotonic
  witness. Reveal/finalize co-batching is forbidden unless the reveal is paired
  with its own exact draft start in Depository's canonical operation order.

## Adversarial checklist

1. One party writes the other's slot: impossible because `revealerEntity` is
   taken from processBatch Hanko. Reversing the pair or declaring a false peer
   selects another inert slot.
2. Second Source ratio: `E12`; exact retry is sticky and harmless.
3. First early/late Source: `E12`, no slot and no event. A timely exact retry
   remains a sticky no-op even after the window.
4. Late higher Target: stored with a new timestamp, then settles only the signed
   claimed ratio because the record is outside `[S,S+W]`.
5. Old-dispute record: lower-bound check makes it ineffective.
6. Early Pull finalization: `PullRevealWindowActive` until full signed sum.
7. Pull-free finalization: immediate only for the non-starter's mutual
   acceptance; the starter still waits until `T`.
8. Same ladder on unrelated Accounts: isolated by the ordered pair. Ambiguous
   reuse inside one Account is rejected before signing; no global gas guard.
9. Quantization: every layer uses `floor(amount * ratio / 65535)`.
