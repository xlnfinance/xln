# Unclear points and the choices made

Format: **id**, the point, the options, **choice**, the source it rests on. An entry is closed when the coordinator
decides. Until then the spec follows the choice written here.

## Account layer (`account.qnt`)

**A1. Two frames at one height (collision).**
Options: (a) Left wins, Right rolls back and takes Left's; (b) both give way and retry with a back-off; (c) the lower
frame hash wins.
Choice: (a). Left keeps its frame and ignores Right's, Right discards its own frame, puts its txs back at the front
of its mempool and holds Left's frame. Source: R-A1, `Types.sol` equal-nonce rule (Left wins), `xln.ts:10644`.
Consequence stated: Right has already signed a proof at that nonce for its own frame, so one signer holds two
signatures at one nonce. They are different branches (`authorIsLeft` is in the signed hash), and the contract's
tie-break picks Left's. P4b is therefore per (signer, nonce, branch), not per (signer, nonce).

**A2. Liveness under message loss (Q-A2).**
Options: (a) the proposer resends its frame, the receiver answers a repeat idempotently; (b) each proposal carries the
previous ack so nothing is ever lost; (c) time-based retransmission in the spec.
Choice: (a). `resend` is enabled while a frame is in flight; a receiver that already committed that frame answers
with the same ack. When to resend is Runtime policy, not protocol. Source: `design/account-model.md` P4/P5, no og
retransmission exists (`collision.ts:117`).

**A3. Rejection of a peer frame (Q-A3).**
Options: (a) refuse silently and count it; (b) send a reject message; (c) treat as dispute evidence and freeze.
Choice: (a) for this layer. A frame is all-or-nothing: the first tx that does not apply refuses the whole frame, the
receiver's state is untouched, and no message is sent. Two honest sides never refuse each other's frames in this
model, so the case is only exercised by stale and duplicate frames. The Byzantine-peer case (a frame whose claimed
state does not replay) is deferred to the dispute layer, where (c) applies. Source: R-X1, Q-E2, Q-A3.

**A4. Frame shape (Q-A4).**
Options: (a) propose-then-ack as separate messages; (b) each proposal carries the counter-signature of the last.
Choice: (a). Piggybacking an ack on the next proposal (og's `ack_frame`) is a transport optimisation with no state
effect, so it is not modelled. Source: `xln.ts:9556`.

**A5. Who signs when.**
Choice: the proposer signs the frame and the resulting dispute proof when it proposes; the receiver signs both when it
acks. A side commits a frame when the counterparty's signature over it exists. So an un-acked proposal already
gives the counterparty a signed proof (design/account-model.md section 2, "signing a proposal is consent to it").

**A6. No parent hash in the frame.**
Options: (a) a frame names its parent by hash; (b) the receiver replays the txs on its own tip and compares the
claimed state.
Choice: (b). A frame built on a different tip either replays to a different state (refused) or to the same state
(harmless). The wire still needs a hash for framing; that is an encoding detail. Source: R-E1 discussion.

**A7. Same-view admission (Q-E1).**
Choice: yes, one view. A local tx is admitted against the state the side is planning (committed state, or the frame in
flight / held) plus everything already queued, so a tx that could never apply never enters the mempool. At
proposal time the proposer still drops any tx that no longer applies (the peer's frame may have changed the state).
Source: Q-E1 recommendation, B-X3.

**A8. Clocks and deadlines (Q-X2, Q-P1).**
Choice: each side has its own clock; the clocks never differ by more than `DRIFT` (an assumption, not a rule the
protocol can enforce). A frame carries the proposer's timestamp; the receiver refuses it unless it is within
`TOLERANCE` of its own clock and not before the previous frame. Every deadline rule reads the frame timestamp, never
a wall clock: a secret is accepted iff `ts <= deadline`; an HTLC expires iff `ts > deadline`. There is no
enforcement margin in the Account: a margin is Entity policy. Source: R-X2, `htlc-deadline.ts`.
Open: `TOLERANCE >= DRIFT` is needed for two honest sides to accept each other; the model does not prove the
Runtime keeps it.

**A9. HTLC deadline horizon (coordinator decision, policy).**
Choice: a side refuses a lock whose deadline is more than `LOCK_SLACK` after the frame's timestamp. It is a per-side
policy parameter, not a protocol constant; the contracts bound nothing here. Modelled as a global for now.

**A10. HTLC resolution rights.**
Choice: only the payee can resolve (reveal) or cancel a lock; anyone can expire it, after the deadline. A secret is
represented by an integer and a hashlock by `hashOf(secret)`; who knows which secret is not part of the Account (it
comes from routing) and is modelled as unconstrained, which over-approximates honest behaviour. Source:
`account-model.md` section 4.

**A11. Not yet in this layer** (each tracked in PROGRESS.md): cooperative settlement and the on-chain epoch (N1:
sign proofs only for the current epoch; pause payments until the new baseline proof is co-signed), account open
(Q-A1), windows fixed at open (N3), swaps, multiple tokens, a Byzantine peer.


---

# J layer (chain.qnt): the Depository as one Account sees it

**C1. Scope: one Account, one token, signed proofs as an arena.**
The chain model does not run the Account protocol; it takes an honest-shaped history of signed proofs as given at
init (both-signed states at nonces 1..k, an unacked proposal at k+1, a Right proposal that lost a collision at k, the
baseline of the next epoch and one proposal on it) and lets the chain rules decide which can settle. Composition with
`account.qnt` (real histories) is the next step. Choice made because the dispute game is the hard part and the arena
makes Apalache-sized checking possible.

**C2. What "the honest party's belief" is (P1).**
Options: (a) only the latest both-signed proof; (b) also any newer proof the honest party itself signed.
Choice: (b). Signing a proposal is consent to it (design/account-model.md section 2), and the proposer's signature over
its own proposal is an enforceable dispute proof, so an adversary that presents it is not cheating. P1 therefore is:
every settled proof is of the current epoch and is either the highest both-signed proof, or newer and signed by the honest
party. The honest party can lose only if it is offline while a response is due (C7).

**C3. Nonce after finalize.**
Contracts: a finalize of the initial proof stores nonce n0+1; adopting a counter-proof or newer proof stores that nonce.
Both are followed. Consequence, not written anywhere in the sources: the stored nonce after a finalize can exceed the
height of the next off-chain frame, and `disputeStart` requires proof nonce > stored nonce. So the first proof of a new
epoch must carry a nonce above the chain's (a baseline), not the frame height. Proposal for settle.qnt (N1): the Account
tracks a `proofNonce` decoupled from frame height, and its first value in an epoch is `chainNonce + 1`.

**C4. R2C is allowed during a dispute.**
Account.sol `processR2C` has no dispute check. The model follows the contract: a deposit made during a dispute changes
the collateral and (crediting Left) ondelta, and finalize pays from the values at finalize time. A proof fixes only
offdelta. Neither side can lose by this: each deposit raises only its beneficiary's allocation. R2C does not advance the
epoch because no signature is involved. Open: whether to forbid it in the fixed contracts (simpler to reason about, but a
liveness cost for top-ups during a dispute); nothing in the model breaks if not.

**C5. Debt is lazy and unsecured.**
Payout shortfall pays from spendable reserve (reserve minus outstanding debt) after enforcing older debt, and books the
rest as debt. A later inflow does not pay debt; `enforceDebts` runs before the next outflow. P3 therefore counts
reserves plus collateral only, and `debt_only_when_broke` checks that debt is never booked while the debtor could pay.
The FIFO queue over several creditors is reduced to one creditor (the counterparty).

**C6. When the honest payee publishes a secret (deadline tolerance).**
The model's honest party publishes the moment it learns a secret for an open clause it is the payee of, i.e. the
tolerance is zero. A real party may wait, at the price of the tolerance parameter (coordinator decision: per-party policy,
not a protocol constant). The guarantee P1 gives is exactly "the payee is paid if it published by the deadline".

**C7. What "honest party offline" excuses.**
Time is a tick clock. A tick that passes while the honest party is offline and owes a response (a counter-proof, or a
secret to publish) sets a flag that switches P1 off: nothing can protect a party that never answers. Ticks that pass
while nothing is due do not count. So P1 is the statement "if the honest party answers within one tick of every duty,
it is never paid less than what it agreed to".

**C8. Evidence for a clause at finalize.**
A clause pays iff its secret is public by the deadline (registry), or the starter revealed it in start arguments (frozen
at start, evaluated at the dispute start time), or the non-starter reveals it in the finalize call (evaluated at finalize
time). The starter's frozen arguments are per branch: the initial proof, or the one named counter branch. Source:
Account.sol prepareDisputeFinalization, DeltaTransformer timestamps.

**C9. H1 is a wait, not a rule about who is paid.**
Finalize reverts while a clause is unrevealed and its deadline is open. The honest payee that knows the secret can end
the wait by publishing it. The model makes no separate claim about hubs that do not yet know the secret; they wait
until the deadline, then settle unpaid, and the upstream Account is then paid nothing for that clause. That is the
intended trade (a hub must not settle an inbound Account before its outbound lock is resolved), stated here so the
Entity layer can require it of the hub: an Entity with a forwarded HTLC starts and answers disputes on both Accounts
before the shorter deadline. Source: contracts-decisions H1.

**C10. Not in this layer.** Pull-carrying proofs (path 2 excludes them; swaps are v2), H3 (retired-board evidence needs
board rotation, so it belongs in entity.qnt), cooperative settlement and C2R (they advance the epoch too; settle.qnt),
several tokens, C2 (batch authority is per entity; nothing visible in a one-Account model), per-batch atomicity across
Accounts (N2: finalizes are submitted per Account, so one action is one batch).
