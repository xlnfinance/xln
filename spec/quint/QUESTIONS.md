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

**C3. Nonce after finalize. CLOSED (coordinator, N1 addendum).**
Contracts: a finalize of the initial proof stores nonce n0+1; adopting a counter-proof or newer proof stores that nonce.
Both are followed. Consequence, not written anywhere in the sources: the stored nonce after a finalize can exceed the
height of the next off-chain frame, and `disputeStart` requires proof nonce > stored nonce. So the first proof of a new
epoch must carry a nonce above the chain's (a baseline), not the frame height. Decision: off-chain frame height and proof nonce are separate counters, and the baseline proof that reopens an Account
after an epoch-advancing event carries a nonce strictly above the chain's stored nonce for that Account.

**C4. R2C is allowed during a dispute. CLOSED (coordinator: accepted as is, recorded as H4 in contracts-decisions.md).**
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

---

# Settlement and epochs (settle.qnt)

**S1. The Account state machine gains a lock.**
A cooperative update is agreed in an ordinary frame (the "Lock" frame: the diffs, `dl`, `dr`, and the nonce of the update).
From the moment it commits, the Account accepts no payment until the epoch that update opens is read from the chain (or a
dispute replaces it). This is N1. Three rules make it hold, each killed by a mutant:
(a) the honest side re-applies its signing rules when an ack arrives, not only when it offers: an offer signed before the
chain moved is dropped; (b) a side that starts (or answers) a dispute stops signing at that moment, before it has read the block;
(c) a payment signed for an epoch the chain has left is never committed by a payee.

**S2. The update is signed by the side that does not submit it.**
Depository `_settleDiffs` verifies the counterparty's current-board hanko over `(epoch, nonce, diffs, forgive)`; the submitter
is authorised by its own batch. So one signature is enough to execute, and whoever holds the other side's signature can execute at
any time until the epoch or nonce moves. The update dies with any other epoch event (finalize, another update); it cannot
execute during a dispute. Source: `Account.sol:1540-1650`.

**S3. CLOSED (coordinator, 17:20Z): option (b) adopted. N1 as decided leaves a window in which the honest side has no proof for the epoch.**
After an update executes, every earlier proof is dead (C1) and the baseline of the new epoch is co-signed only after the
event is read. Until then the honest side cannot start a dispute (no proof), and the counterparty can extend the window for as
long as it declines to co-sign. It is a hostage situation, not theft: the counterparty's own share is frozen too. Reachable in
the model (`rebaseLeavesAWindowWithoutAProofTest`; property `hostage_free` fails when `presign = false`).
Options:
 (a) accept it and bound it by policy (settle only what you can afford to have frozen);
 (b) pre-sign the baseline of epoch+1 in the Lock frame, and make the update fold the Account's offdelta into ondelta
     (`ondeltaDiff = -dl + offdelta`). Then every epoch starts from "offdelta 0, no clauses". That baseline is correct whichever
     event opens the epoch: an update (offdelta folded) or a finalize (everything paid out, so it pays nothing). Checked:
     `hostage_free` holds, custody moves without moving anyone's claim (`claims_conserved`), and the pre-signed proof is
     harmless after a finalize (`presignBaselineAfterFinalizeIsHarmlessTest`). No contract change: the contract's
     `ondeltaDiff` is an independent signed field.
 (c) a contract change: every epoch starts with an implicit both-signed baseline (offdelta 0, no clauses, at the stored nonce).
     Not modelled: (b) reaches the same end with no contract change, and the spec would have to carry a rule the chain does
     not have today.
Cost of (b): one exception to "sign only for the current epoch", and a settlement may carry no open clause (a clause would
be dropped by the fold; R-A3 already forbids settling over queued work).
Choice: (b); the model has both modes (`mode` = presign, otherwise the rebase of N1 as first decided).
Decision, as it now reads in N1 (revised 17:36Z, replacing the first S3 note): a party signs proofs only for the current epoch,
with one exception: EVERY frame also carries a co-signed baseline of epoch+1 (offdelta 0, no clauses). A finalize can open a
new epoch with no settlement Lock before it, and the honest side would be left without a disputable proof again. A settlement
still requires no open clauses in v1 (lifting that is a v2 proposal: settle.qnt proofs carry no clauses, so this is not a guard
here and the Entity layer enforces it with R-A3), and the update folds offdelta into `ondeltaDiff`.
The baseline's nonce is a chain nonce, never the frame height, and the smallest one that survives every opening event is
**frame nonce + 3**. Derivation (chain.qnt): an update stores its own nonce; a finalize on path 1 or 2 stores the adopted
proof's nonce; a timeout finalize (path 0) stores the nonce of the proof the dispute started with, plus 1. A counterparty
can start or adopt what the honest side has signed: every co-signed proof, and its own unacked proposal at tip + 1. So the
largest stored nonce is (tip + 1) + 1 = tip + 2, and a start needs a nonce strictly above it: tip + 3.
`baselineNonceIsTipPlusThreeTest` runs that schedule (Left starts with Right's unacked proposal and lets the window run out:
stored 4, baseline 5); with a gap of 2 the baseline is dead (`baseline-gap-two`, killed by the test and by `baseline_clears`),
with a gap of 1 an update already kills it (`baseline-gap-one`). `baselineRidesEveryFrameTest` runs the case with no
settlement at all (`pay-frame-without-baseline` is killed by it and by `hostage_free`). `hostage_free` holds in this mode
and fails in the rebase mode (witness `w_hostage`), so the window is gone rather than merely unreached.
Not modelled: an unacked baseline of epoch+1 signed only by the honest side can also be presented by the counterparty; every
baseline pays offdelta 0 on an emptied Account, so presenting any of them pays the same.

**S3b. A party that starts a dispute uses its newest co-signed proof (coordinator, 17:36Z).**
An older proof, or a proposal it has not seen countersigned, is presentable on chain and can be the one that settles, so the
starter never picks by convenience: `honestStart` uses `tipId`. `starterUsesNewestProofTest` and the mutant
`honest-starts-with-older-proof` (chain.json) pin it: with nobody answering, the older proof would be paid.

**S4. Fund only into an Account you hold a proof for.**
Found by simulation: after a finalize opened epoch 1 the Account has no proof; a deposit into it is a stake nobody can
enforce. Rule: a side runs R2C only when it holds a both-signed proof of the current epoch that a dispute could start with.
This is the "open" protocol of Q-A1 stated as an order of operations: co-sign the baseline, then fund.

**S5. Lag between the chain and a side.**
Each side reads the chain with a delay. The model lets it act on a stale view but requires the honest side to read the chain
before time passes (a tick). That is the bound "J event lag + processing < response window". H2's floor (60 s) is the number
that has to exceed it; the protocol cannot enforce it, so it is a deployment parameter to be written next to the floor.

**S6. Not modelled here.** Open clauses in a settlement (fold kills them; the spec only says refuse), several tokens, debt
forgiveness (`forgiveDebtsInTokenIds`), an `ondeltaDiff` that changes what a side is owed (a settlement paying an off-chain
balance out of reserves; the two shapes covered are custody-only and fold), credit limits across epochs, and the Entity's
choice of when to settle.

---

# The Entity (entity.qnt)

The Entity under test is a hub with two Accounts: IN (peer 1 sends, we are the payee of its locks) and OUT (we send on to peer 2,
we are the payer). Both peers are adversaries; the Entity is honest and online.

**E1. One frame, four phases, one input.**
A frame is a pure function `frame(state, input)`: (1) the input: a peer's frame, a peer's ack or a J event; (2) the hooks:
resolve, expire, route, fail back, escalate, reveal, all reading the state after the input; (3) a signed local command;
(4) one proposal per Account, ascending. A real frame batches several inputs in phase 1; the model feeds one, which keeps the
phase order and the state space small. Inside a batch the choice is: peer frames first, then J events. A dispute event that
arrives with a peer frame then freezes the Account with evidence that includes the frame. Source: R-E4, R-P4; the batch order is
mine (lessons.md does not fix it).

**E2. What is and is not modelled.**
A hub, one token, one route per slot (IN slot k feeds OUT slot k), amount 1 or 2, two secrets. The Entity's reaction time is
zero ticks: time advances only when the Entity has nothing left to do at this tick (a checked assumption, not a rule the protocol
can enforce; the deployment number is "processing < one tick"). The two replicas of one Account are account.qnt's business; here a
peer frame is one transaction, validated, applied and acked at once. Not modelled: several routes per slot, tokens, boards, the
J batch (jbatch, next), several inputs per frame, an offline Entity (runtime.qnt), `SetCredit`, swaps.

**E3. The deadline arithmetic, derived.**
Let LAG be the ticks a J transaction needs to be included, and the ticks a J event needs to reach the Entity. A payee that knows
a secret only off-chain must put it on the chain by the deadline, so it starts a dispute at deadline - ESC with ESC >= LAG
(`escalation-too-late`: escalating at the deadline puts the secret there one tick late). An onward lock must end HOP before the
inbound one: peer 2 may resolve at the last tick of its lock, the hub learns it then, and needs ESC ticks after that
(HOP >= ESC; `forward-deadline-equal` and its consequence test show the loss with HOP = 0). The model also passes with HOP = 1 =
LAG. The spec value is **HOP = 2 = 2 * LAG**: one tick of slack for the Entity's reaction, which the model sets to zero. The
inequalities are the rule; the numbers are deployment parameters. Source: R-P2, R-P3.

**E4. When a forwarded route may be failed back.**
Not when the onward deadline passes: peer 2 may have put the secret on the chain by then (inclusion time <= deadline) and the
Entity reads the event up to LAG later. The route fails back when the onward lock is gone from a signed state (a newer proof
without it beats any older one), or when the deadline + LAG has passed with the secret still unknown, and never while the secret
is known (that is a claim, not a failure). `failback-without-lag` with `lateRevealCannotBeMissedTest`.

**E5. What a dispute carries, and until when.**
Every known secret that opens a payee clause of the proof the Entity stands on: at the start, and again in every later frame
for a secret learned afterwards (`publishFor`, one rule with two moments). The proof it stands on is its tip when it reads the
dispute (its own start or the peer's). `publish-first-slot-only` shows the loss (the second route's secret is not on the chain).
Source: #37, R-P3.

**E6. What the model needs from the chain (an interface, not a proof).**
A clause pays its payee iff its secret is on the chain by the clause's deadline and the proof holding the clause is the one the
dispute settles; a secret on the chain pays nobody by itself (there must be a dispute on that Account whose proof holds the
clause); starting the dispute after the deadline still pays a clause whose secret was revealed in time. chain.qnt has the first
two (`revealedClausePaysTest`, `lateSecretPaysNothingTest`); the third is used by the Entity model (a late start is fine as long
as the reveal was on time) and has no test there yet. To close by composing entity and chain.

**E7. A route slot is not a private namespace.**
Peer 2 may put a lock of its own into OUT slot k. Then the forward is refused (`lock_exists`) and the route fails back. The rule
"pick a free OUT slot" is not modelled; the properties talk about the lock the Entity put there (`outLockOf`).

**E8. Commands.**
A signed command names one or more Accounts. It applies to all of them or to none (the nonce is spent only when it applies), it is
admitted against the planning view (tip, our frame in flight, our queue) and a replayed nonce is refused without effect
[Q-E2, Q-E1]. Hooks' own transactions bypass the queue cap (they are the protocol, not a user).

**E9. Collisions as the Entity lives them.**
Left ignores the peer's frame and keeps its own in flight; Right puts its frame back at the front of its queue and applies the
peer's [R-A1]. `rightRollsBackOnCollisionTest`, `leftKeepsItsFrameOnCollisionTest`.

**E10. A refused peer frame is a value.** It counts and changes nothing; it never halts [R-X1] (`halt-on-refusal`).

**E11. Found while writing it.**
(a) The first version treated any lock in OUT slot k as the onward lock: peer 2's own lock in that slot broke `deadline_chain`
(E7). (b) A secret on the chain pays nobody without a dispute holding the clause; the first `route_safe` treated it as payment and
called a correct fail back a loss. Both were the model being wrong, not the Entity.
