# Hash-ladder reveal registry — canonical spec

Cross-j Pull settlement reads authenticated Depository state, never a caller's
fill argument. Jurisdiction clocks and Pull deadlines are Unix seconds; runtime
expiry uses milliseconds and converts only at the boundary.

## Signed authority and storage

Each signed Pull commits its absolute `deadline` with its amount, claimed ratio,
ladder commitments and role in the Account ProofBody. The signed route expiry
derives `D_source = floor(expiresAt / 1000)` and
`D_target = D_source + CROSS_J_LEG_MARGIN`. User and hub admission enforce these
exact derived values in TypeScript and Rust.

The invariant is `D_source + CROSS_J_LEG_MARGIN <= D_target`, independent of
both dispute starts. The configured testnet margin is 233 seconds: 144 finality
(12 confirmations × 12 seconds), 5 observation, 24 Target inclusion (2 × 12),
and 60 relative clock skew (2 × 30). These are required delivery bounds, not
measured guarantees. Exceeding them does not authorize extending a signed deadline.

The hub retains the ladder secrets. A Source reveal publishes the portable
witness; the Target beneficiary immediately ports it under its authenticated
Entity, including before a Target dispute starts. No beneficiary fill signature
is introduced as authority.

Registry keys are `(revealerEntity, counterEntity, ladderHash, targetRole)`.
The pair is ordered, never sorted. `revealerEntity` comes from the authenticated Hanko;
a false counterparty writes an inert slot. The registry verifies the ladder
witness without receiving a ProofBody, dispute clock or Pull index.

Target ports use only `Depository.registerTargetHashLadderReveal`. The beneficiary's
current Hanko binds `keccak256(abi.encode(keccak256("XLN_TARGET_HASH_LADDER_REVEAL"),
chainId, Depository, beneficiary, registration))`; registration includes the ordered
counterparty, role, commitments and complete witness. This publication has no Entity
batch nonce and Target registrations in `processBatch` are rejected. Entity consensus
certifies the hash; Runtime publishes after WAL commit and retries the immutable
payload through its durable publication outbox. An unrelated batch ACK cannot delay it.

Bilateral Source `cross_pull_close` rejects frame timestamps whose floored Unix second
exceeds `D_source`, including zero-fill closes. At D it is accepted; Target cooperative
closes remain ungated because they pay the user.

## Immutable evidence

Both Source and Target slots preserve their first verified ratio and timestamp.
An exact retry is a sticky no-op; a different ratio reverts `E12`. Retries after
the deadline cannot replace timely evidence with a late timestamp. Registration
may occur before a dispute or after the deadline; the signed Pull alone decides
whether that evidence has financial effect. There is no dispute-relative reveal
window or timestamp-refresh path.

Ordered Account scoping isolates unrelated ladder reuse. Runtime admission
rejects ambiguous reuse within one Account; there is no global ladder guard.

## Settlement and finalization

The signed Account clock must satisfy
`disputeTimeout = disputeStart + leftResponseSeconds + rightResponseSeconds`.
For each Pull, finalization requires
`block.timestamp > max(disputeTimeout, pull.deadline)`.
At the deadline itself evidence remains admissible and finalization is blocked.
With multiple Pulls the largest deadline governs. TS and Rust schedule the
finalization continuation at that maximum plus one second.

The effective ratio is `max(claimedRatio, timelyRegistryRatio)`, where the
registry ratio contributes only when `0 < revealedAt <= pull.deadline`.
Pre-dispute evidence is valid; a record at D is valid and at D+1 is late.
Delta is `floor(amount * effective / 65535)` minus the already signed claimed
portion. Runtime finality uses the exact signed Pull and timestamped record
before retiring the active dispute; queue latches are not settlement authority.

Pull-free finalization retains the Account role rules: the non-starter can
mutually accept the starter's signed state, while the starter waits for timeout.

## Adversarial coverage

The contract regression starts Target at 100 and Source at 110, then reveals
Source at 120. Target's old relative window has elapsed, but it cannot finalize
at zero before D_target. Porting the witness pays both beneficiaries 1000.
Tests also cover D/D+1, pre-dispute evidence, equal/conflicting late retries,
insufficient deadline margin, signed ABI binding and TS/Rust settlement vectors.

The pending-batch regression reveals Source at 1000, observes it at 1149, and
ports Target at 1173 before D_target=1233 while an unrelated batch ACK is due
at 1297. Cooperative Source D+1 rejection, late Target acceptance, signed-domain
mutation rejection, immutable retries and WAL recovery cover both publication paths.
