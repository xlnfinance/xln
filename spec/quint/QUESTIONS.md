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

**A9. HTLC deadline horizon: `MAX_LOCK_HORIZON` (coordinator decision, N2, policy).**
Choice: a side refuses a lock whose deadline is more than `MAX_LOCK_HORIZON` after the frame's timestamp (`deadline_too_far`). It is
a per-side policy parameter, not a protocol constant; the contracts bound nothing here. The coordinator names the default 7 days, never
below the 24 h async window, enforced in time and in J height, at lock admission and at forward. The model has one clock: a tick is a
unit of time and of J height alike (`LAG` counts J inclusion in ticks), so the two bounds are one number here, and the second check would
only repeat the first; a real implementation keeps both (a lock may carry a J height deadline the chain reads). At forward the hub's own
onward lock goes through the same `applyTx`; its deadline is the inbound one less `HOP`, so it is inside the horizon whenever the
inbound lock was (`farDeadlineIsRefusedTest`; `forwardKeepsTheMarginTest` forwards a lock at the horizon); mutant `horizon-off`.

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

**C11. The honest side takes time: a floor for the windows, derived. ACCEPTED by the coordinator (2026-09-29).**
Until now the chain model let the honest party answer at the same tick as the event ("time does not move while a response is
due"). A real party reads the chain LAG ticks late and its answer needs LAG ticks to be included, so it answers REACT = 2 * LAG
after the event, and the adversary gets those ticks for free. The model now makes time stop only REACT ticks after the start
(or after the last counter), or LAG ticks after the payee learned the secret (that one needs no read). Consequence, and the rule
the contracts must meet: **the two windows of a dispute together must exceed REACT** (`wl + wr > 2 * LAG`; with LAG = 1 the
model floor is 2 ticks per window; the contracts' 60 s floor meets it while a J event is read and included in under 60 s). Options: (a) floor per window `MIN_WINDOW >= LAG + 1`, (b) floor on the
sum. Choice: (a), it is what the contract can check on one proof, and it keeps H2's shape (a per-window floor). The deployment
numbers are what the coordinator decides: a floor in blocks that is several times the slowest read + inclusion. Model evidence:
`window-floor-below-react` (MIN_WINDOW = 1: the adversary finalizes a stale proof at the tick the answer would have landed),
`react-longer-than-windows`, `lastMomentCounterStillWinsTest`. The Entity side is `answer_in_window` (`windows-shorter-than-answer`);
`params_test.qnt` pins the shared numbers (LAG, REACT, DWIN, HOP >= REACT, ESC >= LAG), so a change to one layer fails the test.
A second consequence: a payee that learns the secret at the deadline is not owed payment (its publish needs LAG): the property
`p1_clause` reads "learned at least LAG before the deadline" (`no-publish-tolerance`). This is the deadline tolerance of E3 seen
from the chain. Source: R-P2, H2.

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
before time passes (a tick). That is the bound "J event lag + processing < response window". C11 now derives it: the H2 floor
(60 s per window in the contracts) has to exceed LAG, so that both windows together exceed REACT = 2 * LAG; the protocol cannot
enforce the lag, so LAG is the deployment number written next to the floor.

**S6. Not modelled here.** Open clauses in a settlement (fold kills them; the spec only says refuse), several tokens, debt
forgiveness (`forgiveDebtsInTokenIds`), an `ondeltaDiff` that changes what a side is owed (a settlement paying an off-chain
balance out of reserves; the two shapes covered are custody-only and fold), credit limits across epochs, and the Entity's
choice of when to settle.

---

# The Entity (entity.qnt)

The Entity under test is a hub with two Accounts: IN (peer 1 sends, we are the payee of its locks) and OUT (we send on to peer 2,
we are the payer). Both peers are adversaries; the Entity is honest and online.

**E1. One frame, four phases, several inputs. CLOSED.**
A frame is a pure function `frameOf(state, inputs)`: (1) the inputs: peers' frames and acks, then J events; (2) the hooks:
resolve, expire, route, fail back, escalate, reveal, all reading the state after the inputs; (3) a signed local command;
(4) one proposal per Account, ascending. Inside a batch the order is: peer frames first, then J events (then the command). A
dispute event that arrives with a peer frame then freezes the Account with evidence that includes the frame
(`peerFrameBeforeChainEventTest`); the other order freezes first and the frame changes nothing (`chainEventBeforePeerFrameDiffersTest`),
so the order is a rule, and it is the Runtime's canonical order (runtime.qnt R1). The action `feedTwo` feeds any two inputs in that
order and the invariants hold over 5000 traces; `only-first-input-of-a-frame` is killed by `ackAndRefusalInOneFrameTest`. Source: R-E4,
R-P4; the batch order is mine (lessons.md does not fix it).

**E2. What is and is not modelled.**
A hub, one token, one route per slot (IN slot k feeds OUT slot k), amount 1 or 2, two secrets. The Entity's reaction time is
zero ticks: time advances only when the Entity has nothing left to do at this tick (a checked assumption, not a rule the protocol
can enforce; the deployment number is "processing < one tick"). The two replicas of one Account are account.qnt's business; here a
peer frame is one transaction, validated, applied and acked at once. Not modelled: several routes per slot, tokens, boards, an
offline Entity (a Runtime that is down: chain.qnt `offline`), `SetCredit`, swaps. The J batch is jbatch.qnt; several inputs per frame
are E1.

**E3. The deadline arithmetic, derived. CLOSED.**
Let LAG be the ticks a J transaction needs to be included, and the ticks a J event needs to reach the Entity. A payee that knows
a secret only off-chain must put it on the chain by the deadline, so it starts a dispute at deadline - ESC with ESC >= LAG
(`escalation-too-late`: escalating at the deadline puts the secret there one tick late). An onward lock must end HOP before the
inbound one: peer 2 may resolve at the last tick of its lock, the hub learns it then, and needs ESC ticks after that
(HOP >= ESC; `forward-deadline-equal` and its consequence test show the loss with HOP = 0). The model also passes with HOP = 1 =
LAG (chain.REACT was 0 then). Since C11 REACT = 2 * LAG and `params_test.qnt` requires HOP >= REACT. The spec value is **HOP = 2 = 2 * LAG**: one tick of slack for the Entity's reaction, which the model sets to zero. The
inequalities are the rule; the numbers are deployment parameters. Decision: HOP = 2 * LAG is a named policy parameter, not a
protocol constant. Source: R-P2, R-P3.

**E4. When a forwarded route may be failed back. CLOSED.**
Not when the onward deadline passes: peer 2 may have put the secret on the chain by then (inclusion time <= deadline) and the
Entity reads the event up to LAG later. The route fails back when the onward lock is gone from a signed state (a newer proof
without it beats any older one), or when the deadline + LAG has passed with the secret still unknown, and never while the secret
is known (that is a claim, not a failure). `failback-without-lag` with `lateRevealCannotBeMissedTest`. Decision: the hub waits one LAG after the onward deadline before it fails back.

**E5. What a dispute carries, and until when. CLOSED.**
Every known secret that opens a payee clause of the proof the Entity stands on: at the start, and again in every later frame
for a secret learned afterwards (`publishFor`, one rule with two moments). The proof it stands on is its tip when it reads the
dispute (its own start or the peer's). `publish-first-slot-only` shows the loss (the second route's secret is not on the chain).
Decision: every known payee secret goes into a dispute. Source: #37, R-P3.

**E6. What the model needs from the chain (an interface, not a proof). CLOSED on the chain side.**
A clause pays its payee iff its secret is on the chain by the clause's deadline and the proof holding the clause is the one the
dispute settles; a secret on the chain pays nobody by itself (there must be a dispute on that Account whose proof holds the
clause); starting the dispute after the deadline still pays a clause whose secret was revealed in time. chain.qnt has the first
two (`revealedClausePaysTest`, `lateSecretPaysNothingTest`); the third is `lateStartStillPaysARevealedClauseTest` (a hub fixture: the
payee reveals, four ticks pass, the starter starts with the older proof; finalize pays the payee 3, no debt), with the mutant
`reveal-counts-only-if-start-in-time` killed by it. Decision (coordinator, 18:15Z): the contracts pin the same fact on the real contracts
(`contracts/test/vm/h1-htlc-deadline.test.ts`, #47): a secret revealed before the deadline is paid at finalize even when the dispute
starts after it; one revealed after is not. Entity and chain are composed at four points, each checked: (1) the interface above, in
`chain_test.qnt`; (2) one set of numbers, `params_test.qnt` (LAG, REACT = 2 * LAG, DWIN = 2 * MIN_WINDOW, HOP >= REACT, ESC >= LAG);
(3) the answer's timing: the chain forces the honest side only REACT ticks after an event (C11) and the Entity's answer lands
inside the windows (`answer_in_window`); (4) the entity's deadline arithmetic played on the real dispute game
(`hopMarginPaysTheHubTest`, `noMarginLosesTheHubTest`). One state machine with both would only re-check (1) to (4) with more
states: the chain's state is one Account and the Entity's is two, so a joint model needs the Account histories of the real
frames (the next item, "account + chain").

**E7. A route slot is not a private namespace. CLOSED (2026-09-29).**
The inbound slot number and the onward slot number are unrelated: peer 2 may hold OUT slot 1 with a lock of its own, and a command of
ours may have one in flight. The route (per inbound slot k) carries its own OUT slot `os`: the lowest slot that is free on the planning
view (committed, in flight, queued) and that no route which is not over holds (`freeOutSlot`). None free: the inbound lock fails back
at once. A route keeps its slot until both locks are gone and nothing is queued for it (`resetOne`), and the ghost record of what
peer 2 did with the lock is kept per OUT slot. Options: (a) reuse k (the first model; refused whenever the slot is taken), (b) pick
the free slot (chosen; a forward is refused only for lack of credit or of a free slot). Tests `onwardSlotIsTheLowestFreeOneTest`,
`twoForwardsInOneFrameUseTwoSlotsTest`, `slotStaysReservedUntilTheRouteIsOverTest`, `peerHoldsTheLowSlotTest`,
`ownLockInFlightHoldsTheLowSlotTest`; mutants `fixed-out-slot`, `free-slot-ignores-the-plan`, `free-slot-ignores-reservations`.

**E8. Commands.**
A signed command names one or more Accounts. It applies to all of them or to none (the nonce is spent only when it applies), it is
admitted against the planning view (tip, our frame in flight, our queue) and a replayed nonce is refused without effect
[Q-E2, Q-E1]. Hooks' own transactions bypass the queue cap (they are the protocol, not a user).

**E9. Collisions as the Entity lives them.**
Left ignores the peer's frame and keeps its own in flight; Right puts its frame back at the front of its queue and applies the
peer's [R-A1]. `rightRollsBackOnCollisionTest`, `leftKeepsItsFrameOnCollisionTest`.

**E10. A refused peer frame is a value.** It counts and changes nothing; it never halts [R-X1] (`halt-on-refusal`).

**E12. Our start lands beside the peer's: DisputeOpSkipped. CLOSED.**
We send a dispute start; the peer's start reaches the chain first. There is one dispute per Account, so ours is skipped and the chain
emits `DisputeOpSkipped` (J2). What the Entity does: (1) until it reads the outcome of its own start it is `await`ing; the outcome is
either DisputeStarted (ours landed) or DisputeOpSkipped (ours was skipped); (2) the peer's DisputeStarted, which comes first in chain
order, is answered as any peer dispute is: freeze, name the tip, publish every known secret; (3) the skip ends the wait, the open
dispute is not ours (`byUs` false) and, if the peer's event was not read yet, the skip answers it too (the same answer twice is one
answer). Counter after the window closed: the Entity's answer is late, which `answer_in_window` already flags (C11); the skip event
then only tells it not to send the counter again. Options for (1): treat the next DisputeStarted on the Account as the outcome of our
start (rejected: it would swallow the peer's dispute; the starter is in the event). Model: `ownStartLands`, `peerStartsBeside`, events
`JStarted` and `JSkip`, property `skip_ends_the_wait`, tests `ownStartLandsIsReadTest`, `skippedStartEndsTheWaitAndAnswersTheOpenOneTest`,
`skipAloneAnswersTheOpenDisputeTest`, mutants `skip-outcome-not-read` and `skip-read-as-started`. The race needs an escalation and three more steps: the random simulation reaches
it only on some seeds (seed 1 kills `skip-outcome-not-read` by the invariant, seed 7 does not reach it in 3000 traces), so the witness
`w_no_outcome` covers the landed start and the scenario tests cover the skip.

**C12. Several clauses in one Account: what the single-clause chain model leaves out. CLOSED by a check.**
The Account layer allows up to LOCK_SLOTS open clauses, `chain.qnt` holds one per proof. The contract (`DeltaTransformer._applyBatch`) settles
the payments one by one, each adds its amount to the delta when its secret is on the chain by its deadline, independently of the others; a
clause that is still open and unrevealed makes the whole finalize revert until its deadline has passed (H1), so a finalize waits for the
latest unrevealed deadline. So the clauses interact in two places only: the wait (the maximum, not each) and the sum, which the payout then
clamps to the collateral with the rest as debt. The sum is the risk: two clauses that are each fine alone can together push a side
outside its credit. `compose.qnt` checks it exhaustively over a small domain (offdelta -4..6, limits 0..2, two slots each empty or a
clause of either payer with amount 1..3): for every Body that satisfies RCPAN and every subset of resolved clauses, the chain's `payout`
leaves no side owing more than the credit it was granted and pays out exactly the collateral. Non-vacuous: the domain has Bodies with two
open clauses and with debt, and RCPAN without the open clauses (`weakRcpan`) is violated. Mutants: `rcpan-ignores-open-clauses`,
`payout-forgets-the-debt`, `payout-pays-the-collateral-twice`. Not covered: a wait that differs per clause in the chain model itself (the
single clause has one deadline); the maximum-of-deadlines is the contract's line, stated here and checked by `finalizeWaitsForDeadlineTest`
for one clause.

**E11. Found while writing it.**
(a) The first version treated any lock in OUT slot k as the onward lock: peer 2's own lock in that slot broke `deadline_chain`
(E7). (b) A secret on the chain pays nobody without a dispute holding the clause; the first `route_safe` treated it as payment and
called a correct fail back a loss. Both were the model being wrong, not the Entity.

---

# The J batch (jbatch.qnt)

One Entity, one token, four ops (a payment, a secret reveal, a dispute step, another payment). The chain facts are read from
`contracts/contracts/Depository.sol` `processBatch` / `_processBatch`: a batch is signed for an entity and a nonce and lands only at
`nonce = stored + 1`; a reverting op reverts all of it; a signed batch never expires and anybody can submit it, again, later. The
honest relayer submits every batch in ascending nonce order and each first attempt happens within LAG; the adversary picks which batch
of one nonce lands (when the Entity signed several), spoils dispute ops (`poison`), moves the reserve and re-submits anything ever signed.
Simulation only.

**J1. What a lost, reverted or dropped batch does (Q-J1). CLOSED.**
A batch that reverts leaves nothing on the chain, and it stays valid: the reserve and collateral it names are untouched, and it can be
sent again by anyone, at any time (`resubmittedBatchIsHarmlessTest`: the second landing is refused by the nonce, E2, and runs nothing;
`chain-accepts-old-nonces` shows the double payment otherwise, property `pay_once`). So the Entity's latches are Entity-side bookkeeping
with one rule: a latch is released only when a batch carrying the op has landed, or the op can never apply (its dispute moved, seen as
a DisputeOpSkipped). Never on a timeout: `drop-every-op-of-a-failed-batch` (property `dropped_only_dead`) abandons a payment whose
signed batch then lands later. A payment failed at its nonce (J5) is queued again and signed at a fresh nonce
(`revertedPaymentDoesNotBlockTheUrgentOpTest`). Source: Q-J1.

**J2. A dispute op that cannot apply: revert the batch or skip the op? ACCEPTED (TOLERANT); the contracts thread changes it test-first.**
Today one dispute start over a dispute that moved (the adversary finalized first, a counter already registered) reverts the whole
batch, and the secret reveal in the same batch is lost with it. Options: (a) as is; (b) dispute-class ops (start, counter, finalize,
reveal) skip when they cannot apply or already ran, and emit an event; payments, deposits and settlements keep reverting; (c) as (a) and
the Entity puts every urgent op in a batch of its own. Choice: (b). With (a) an urgent op cannot be bound by LAG: every spoiled op
costs a round (`contract-reverts-on-moved-dispute`), with (c) k urgent ops cost k rounds. This is a contract change for the
contracts thread; until it lands the spec's deadline numbers need `(k + 1) * LAG` where k is the number of concurrent urgent ops.
Also required: an urgent op that already ran is skipped when it appears again (a batch that is sent again).
**The event (coordinator, 2026-09-29, built in the contracts).** A skipped dispute op emits
`DisputeOpSkipped(sender, counterentity, op, reason, nonce)`. The reasons the spec covers: a start beside an open dispute (there is at
most one dispute per Account), a counter after the window closed, an op that already ran. The event is a chain fact like any other:
the Entity that sent the op learns from it that the op is dead and abandons it (`skip_read`, mutant `entity-ignores-the-skip-event`);
without it the node waits for an outcome (a DisputeStarted) that never comes. The Runtime must read it (R7) and the Entity must
act on it (E12).

**J3. How the Entity signs urgent ops. CLOSED (given J2, J5 and F1).**
(1) An urgent op (a reveal or a dispute step) never rides with a payment: a payment that cannot run (reserve moved) would take it
down (`pack-everything`, `urgent-batch-carries-payments`). (2) Each urgent op that is in no live batch gets one batch of its own, at a
fresh nonce (F1). (3) Payments wait until nothing is live (`urgent-waits-for-outstanding` shows the price of also making urgent ops
wait). With J2, J5 and F1 an urgent op lands within LAG of reaching the Entity, which is the LAG the deadline arithmetic of the
Entity layer uses (`params_test.qnt` pins jbatch.LAG = entity.LAG). The first version of this rule signed a pair of batches, the
first at a nonce a live payment batch also held; the simulation found that an older batch signed for a nonce burns the fresh one's
nonce. F1 replaces the pair.

**F1. A signed batch is final at its nonce (coordinator, from the J2 review). CLOSED.**
`processBatch` is permissionless: anybody may send any signed batch, at any time. With J2 a batch whose ops are all stale lands as a
no-op and still takes its entity nonce. So the rule is: never sign different content at a nonce you have already signed, and always
send a replacement at a fresh nonce (above every nonce signed so far, `topSigned`). An abandoned batch costs nothing when the fresh
ones sit above it: it lands as a no-op in the same round and the ones above it land right behind it. Property `nonce_final` (no two signed
batches with one nonce and different content); mutant `resign-at-a-signed-nonce` (the fresh nonce ignores what is signed) shows the
burn. Test `neverTwoBatchesForOneNonceTest`.

**F2. After an abort only urgent ops go back at once (coordinator rule, 2026-09-29). CLOSED.**
The Entity may give a signed draft up (a rolled-back frame, a restart that lost the outbox), but the signed batch is not recalled and
can still land (F1: it never expires). A dispute step, secret reveal or hash-ladder op runs once or is skipped (J2), so it goes back into
the draft at once at a fresh nonce; if both copies land it has still run once (`abortedRevealIsSignedAtOnceTest`). A payment, a deposit
or a reserve move runs every time its batch lands, so it goes back only after the abandoned batch's nonce is used, and after the Entity
has read `BatchFailed` if the batch failed (`inFlight` and `nothingAlive` keep counting an abandoned batch for those ops:
`PAY_HELD_AFTER_ABORT`). The model has one op kind for all three (`Pay`: R-SPLIT groups payments, settlements and reserve moves as the
ones a failed batch does not touch); deposits and reserve moves are the same as payments for this rule, and the mutant
`abort-requeues-payments-at-once` (the abandoned batch and its replacement both land) violates `pay_once`. Tests
`abortedPaymentIsNotSignedAgainTest`, `abortedPaymentWaitsForBatchFailedTest`. The Entity layer models no deposit op of its own; the
rule lives in the J batch layer where the ops are queued.

**J5. A batch that fails still takes its nonce. ACCEPTED (b) by the coordinator (2026-09-29); the contracts thread builds it test-first.**
Today a batch that reverts (a payment the reserve cannot cover) leaves no trace, its nonce stays open, and every batch above it waits.
F1 forbids signing another content at that nonce, so with the contract as it is a drained reserve holds every urgent op hostage until
somebody refills it: `payment-revert-keeps-the-nonce` violates `urgent_lands` (found by simulation the moment F1 went in). Options:
(a) as is, and the Entity tops up the reserve on reading a failed payment (an external deposit takes no entity nonce): the urgent op
waits REACT + LAG, not LAG; (b) **a batch that fails takes its nonce, applies nothing and emits `BatchFailed(entity, nonce, reason)`**
(Ethereum's own rule for a failed transaction): nothing is ever blocked, the payment is queued and signed again at a fresh nonce;
(c) payment ops skip like dispute ops (rejected: it makes a batch non-atomic, and a settlement that pays half is worse than one that
does not run). Choice: (b). It is a small change in `processBatch` (catch the failure, keep the nonce, revert the effects). Until it
lands the deadline numbers of the Entity layer need option (a)'s bound. The Entity reads BatchFailed like DisputeOpSkipped (R7).
Decision: (b), for a failing payment or settlement op; (c) is rejected. The whole transaction must succeed: the failure is caught, its effects
are undone, the nonce is stored and `BatchFailed` is emitted. A failure that reverts the transaction itself loses the nonce write and the nonce stays open
(that is today's contract: `payment-revert-keeps-the-nonce`). The Entity reads `BatchFailed` and queues the payment again at a fresh nonce; it does
not sign it again before it has read the event (`failed_read`, mutant `entity-ignores-batch-failed`). Tests: `revertedPaymentDoesNotBlockTheUrgentOpTest`.
Model: `NONCE_ON_FAIL`, `failedEv`, `failSeen`; `urgent_lands` holds under it.
**As built (coordinator, 2026-09-29).** Two limits that the spec now carries.
**R-SPLIT.** Only a batch with no dispute, reveal or hash-ladder op gets the BatchFailed treatment (applies nothing, takes its nonce).
A mixed batch that fails still reverts whole and keeps its nonce open. So the Entity's rule: dispute, reveal and hash-ladder ops never share a
batch with payment, settlement or reserve ops. This was already J3(1); it is now also the chain's line: `urgent-batch-carries-payments`
(the Entity mixes them) breaks `urgent_lands` because the failed mixed batch reverts, loses the urgent op and holds every batch above it.
**Gas guard.** A failure that leaves under 1/32 of the gas reverts the transaction instead of emitting BatchFailed, so a relayer cannot burn
a good batch by starving the call. Model: `starve` (a relayer call with too little gas), `GAS_GUARD`, property `no_burn`; mutant `no-gas-guard`
burns a payment batch that would have applied (`starvedBatchLandsLaterTest`). The starved call of an urgent batch only reverts whole, which
leaves the batch valid for the honest relayer's next attempt.

**J4. Nonces: what the contract's strict sequence costs.**
Any signed batch is a nonce burner in the adversary's hands (F1), and a payment batch that reverts blocks every batch above it (E2, J5).
Options: (a) keep the strict sequence (F1 and J5 work around it), (b) unordered nonces with revocation. Choice: (a) for v1. (b) removes
the burn and the hostage chain but needs a revocation batch before an op is re-signed, and the double-run hazard for payments returns. The batch limits
of R-J3 (`MAX_ENCODED_BATCH_BYTES`, per-array bounds) are not modelled: a full batch is a refusal, as in R-J3.

---

# The Runtime (runtime.qnt)

The Entity is abstracted to its input history (the keys of the inputs it applied, in order); the signed frame it sends is
`(height, history)`. Two different histories at one height are an equivocation. Inputs: chain events (key k), peer messages
(10 + k), commands (20 + k). One frame is three steps, apply in memory, make it durable, send; a crash and restart can happen
between any two. Simulation only.

**R1. The order of a frame (R-R1). CLOSED.**
A frame applies the inputs due at its tick as one batch in ascending key order: the peer's messages, then chain events, then
commands, whatever order they arrived in (peers first: a frame co-signed at the tick a dispute is read is in the evidence, E1). `frame-in-arrival-order` (property `canonical_frames`), `canonicalOrderTest`. A frame opens
only when an input is due (the idle gate): `empty-frame`, `noFrameWithoutInputTest`. Canonical order is the spec's choice; the
Entity's own order inside the frame (input, hooks, command, propose) is entity.qnt's and is a separate rule [R-E1].

**R2. J watching: exactly once, in order (R-J1). CLOSED.**
The watcher offers the event after the cursor, again and again until it is applied. The cursor moves with the frame that applies the
event, in the same durable write, and nowhere else: `cursor-moves-when-read` loses an event after a crash, `cursor-not-with-state` leaves
the cursor behind the history, `no-dedupe` applies an input twice (`exactly_once_j`, `chainEventSurvivesACrashTest`). A gap in the
event sequence is not something the Runtime can repair: see R5.

**R3. Durable before it leaves. CLOSED.**
(1) A signed frame is sent only after the state that produced it is durable: with the frame in flight a crash throws away memory, the
restart derives the next frame from different inputs, and the Entity has signed two frames for one height. The counterparty then holds
proof of it (`send-before-persist`, property `no_equivocation`). (2) A command is acknowledged to its user only once durable
(`ack-before-persist`, `acked_durable`). (3) On restart the last signed frame is sent again, and it is the same frame
(`crashAfterDurableResendsTest`); peer messages and commands that were only in memory are resent or resubmitted by their senders
(assumption: a peer resends until acked, which account.qnt models; a command is resubmitted by its user until acknowledged).

**R4. Time.**
The Runtime's clock is an input: a frame carries the timestamp the Runtime committed for it, never a wall-clock read inside the
Entity, so replaying the log reproduces the state [R-R1]. entity.qnt takes `now` from the input and advances it only when the Entity
is quiescent, which is this assumption stated for the Entity (zero reaction time; the deployment number is "processing under one tick").

**R5. The halt taxonomy (R-X1, Q-R1). CLOSED, a closed list.**
A halt stops one Entity and is reported; nothing else stops. The list of causes, all local:
(a) a durable write fails (the Runtime cannot keep R3, so it stops instead of sending);
(b) the durable state does not load or does not verify at restart;
(c) an invariant of the Entity's own state breaks after a frame (a bug: a balance below its bound, a lock that cannot be resolved);
(d) the two replicas of one board disagree on the state hash of a frame they both applied (a fork of our own doing);
(e) the chain event sequence has a gap the watcher cannot fill (R2).
Everything a peer can cause is a refusal: a malformed or badly signed frame, a stale or future nonce, an unknown Account, a full
batch (R-J3), a command over a limit. A refusal is a value: counted, no state change, optionally answered, never a halt
(`halt-on-refusal` in entity.qnt kills the opposite). The og engine has 8 halts that a peer can trigger; none of them is on this list.

**R7. Every kind of chain event is read. CLOSED.**
The watcher does not choose which events to read: the cursor moves over every event of the Depository log for the Entity's Accounts,
DisputeOpSkipped (J2) included. A watcher that reads only the kinds it thinks the Entity waits for leaves a node whose start was
skipped waiting for a DisputeStarted that never comes (`watcher-skips-the-skip-event`, `skipEventIsReadInOrderTest`). The event is
applied in order with the others, exactly once, across crashes (R2), and the frame that applies it moves the cursor.

**R6. Not modelled here.** Several Entities in one Runtime (they share nothing but the process: the properties are per Entity),
the board's own consensus (v2: boards), the network beyond "a peer resends until acked", storage cost, and the offline Entity: a
Runtime that is down misses windows, which chain.qnt models as `offline` (the honest party can lose).
