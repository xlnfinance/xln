# Spec questions

Every point where the sources leave a choice open, and the reading the spec took. The spec does
not wait for an answer: the comparison with the independent Quint spec, and Arthur, resolve
these. One entry per point: what is unclear, the options, the choice made, the source.

Ids are `Q-<layer>-<n>`. Lessons ids (`R-`, `Q-`, `B-`) refer to `plan/lessons.md`.

## Account (`account/frames.scm`)

**Q-A-1. What does a refusal cost the sender?**
Options: (a) the receiver stays silent and the sender learns nothing; (b) the receiver answers
with a reject message.
Choice: (a). A stale, future or invalid frame changes nothing at the receiver and is never fatal.
The sender's resend and the peer's re-ack are what make progress; a reject message would add a
third message kind for no safety gain. Refusal cost in general is lessons Q-X1, still open.
Source: lessons R-X1 (no peer input halts a Runtime), og issues 1, 3, 4, 6, 7, 8.

**Q-A-2. A duplicate of the frame at my head.**
Options: (a) ignore it; (b) answer with the same ack again.
Choice: (b). With (a), one lost ack wedges the proposer: the planted bug `no-reack` fails the
liveness check "can always still finish" after a single loss.
Source: design/account-model.md P4 (loss and duplication), lessons Q-A2.

**Q-A-3. Who resends, and when?**
Options: (a) only the proposer of the pending frame, at any time (a timeout abstracted away);
(b) also the receiver of an unanswered ack.
Choice: (a). A duplicate frame makes the receiver re-ack, which covers a lost ack; a lost frame
is covered by the proposer resending. Timeout length and backoff are implementation policy, not
protocol. The model lets a resend happen at any moment, so it covers every timeout.
Source: lessons Q-A2; design/account-model.md P4, P5.

**Q-A-4. A tx that no longer holds after a rollback.**
Options: (a) drop it silently; (b) keep it in the mempool forever; (c) refuse it with notice.
Choice: (c). On rollback the loser's txs are checked again against the new head when they are
proposed; one that fails goes to `:refused` and the owner learns it. Property: every submitted tx
is committed, held, or refused. The `conflicts` relation stands in for "the tx is invalid against
the new state" (credit consumed, lock gone). The real predicate is the ledger's, which this page
does not have yet.
Source: lessons R-A1 (Right re-proposes its txs at the next height), Q-X1.

**Q-A-5. Does the receiver validate frame content?**
Choice: yes, with the same function the proposer uses. For an honest proposer the verdict is the
same (equal head means equal state), so this never fires; it is the path a Byzantine or buggy
proposer hits, and it is the same path as a stale frame.
Source: design/account-model.md section 5 (P4: no two proofs per nonce).

**Q-A-6. The link.**
Choice: FIFO with bounded loss and duplication (`max-losses`, `max-dups`, default 1 and 1).
Reordering is not modelled: the `prev` hash makes a frame from the future refusable, so
reordering can only add stale copies, which duplication already covers. A full reordering model
is a later widening.
Source: design/account-model.md P4 ("loss, duplication and simultaneous proposals").

**Q-A-7. Frame protocol shape (lessons Q-A4).**
Choice: kept propose-then-ack. The property set (agree, order, no loss, liveness) does not
depend on the shape; a "proposal carries the counter-signature of the last one" variant removes
the re-ack case and is a variant of this page, not a different spec.
Source: design/account-model.md section 7.

**Q-A-8. Which side is Left?**
Choice: the lower entity id, as in the contract's `acct_key`. The page names sides `:left` and
`:right`; the rule "Left wins on an equal height" is the contract's equal-nonce rule.
Source: Types.sol:150, Account.sol:361, Account.sol:732.

## Money (`money/ledger.scm`)

**Q-L-1. Which way does "credit-left" point?**
Options: (a) `credit-left` = credit EXTENDED TO Left (Left may owe up to it; xln.ts `leftCreditLimit`);
(b) `credit-left` = the credit Left extends to Right (the wording of design/account-model.md section 4,
"the side's own credit toward the other").
Choice: (a), because the RCPAN formula in the same document, `-leftCredit <= Δ`, only reads correctly
that way, and it is what xln.ts does. The document's table row for `setCredit` should be reworded.
Source: xln.ts leftCreditLimit / rightCreditLimit; design/account-model.md sections 3 and 4.

**Q-L-2. Must `setCredit` respect RCPAN?**
Options: (a) refuse a credit change that leaves the current Δ outside the bounds; (b) allow it and let
the next payment fail.
Choice: (a). xln.ts `setCreditLimit` does not check it; the account-model document says it should.
With (b) a side can lower its credit below what is drawn and the committed state breaks P2: the
planted bug `credit-below-usage` is exactly that.
Source: design/account-model.md section 4 (setCredit refused when it would break RCPAN); xln.ts setCreditLimit.

**Q-L-3. Worst case over clauses.**
Choice: a locked amount counts against its payer at the payer's side of the bound: the payer's
allocation may fall by every open amount at once (`worst-low`), the payee's rise by every amount owed
to it (`worst-high`). Only HTLC-like clauses are in this page; swaps and pulls add clause kinds, not
rules. The property is written from the formula, not from the guard, so a wrong guard cannot mask
itself.
Source: design/account-model.md section 3 (RCPAN, "in the worst case over the outcomes of every open clause").

**Q-L-4. Deposit and withdraw share one function.**
Choice: r2c and c2r move the same amount between a reserve and the collateral and move ondelta the
same way (a Left deposit raises ondelta and collateral by the amount, so Left's allocation grows by what it
put in; a Right deposit raises collateral only, so Right's share, collateral minus Δ, grows). Conservation is "reserves + collateral never change" for a single Account.
Source: Account.sol cooperative update (leftDiff + rightDiff + collateralDiff = 0, line 1559).

## Dispute (`dispute/dispute.scm`)

Contract refs: A = Account.sol, D = Depository.sol, X = DeltaTransformer.sol on branch
claude/project-thread-xkty13 (fixed contracts, PR #40 head 77df511).

**Q-D-1. Who is assumed to act inside its window?**
Choice: the NON-starter. The clock may not reach T while the non-starter holds a proof that
outranks the selected one and has not answered; it also never closes on a proof worse than its best.
Every safety property is conditional on that, and the planted bug `no-floor` (windows of zero)
shows what happens without it. The starter's honesty is the other assumption: a starter that starts
with a stale proof is not protected (see Q-D-2).
Source: A:1466 (counter only before T), A:1476 (only the non-starter), design/account-model.md P5.

**Q-D-2. A proposal that lost a cross-open stays presentable (finding).**
When both sides propose at one height, Left's frame wins (R-A1), but Right has already signed its
own, and Left holds that signature: the chain accepts it as a proof. The tie-break at equal nonce
(Left-proposed outranks Right-proposed, A:1478-1483) is what protects the committed state. The
checker finds the consequence: if Right starts a dispute with an OLDER proof, Left can close at
once (5b) on the losing proposal and be paid more than the committed state gives it (trace:
propose n1, ack, collide n2, start n1R, finalize with n2R'). Options: (a) accept it, since the
starter chose a stale proof; (b) make a proof carry the proposer's own commitment that the
committed state supersedes it. Choice: (a) for now, stated as the property "an honest starter never
ends on a losing proposal". Runtime rule that follows: a starter starts with the NEWEST proof it
holds, always; and a party that loses a cross-open keeps its own losing signature in mind.
Source: A:1478-1483, Types.sol:150, lessons R-A1.

**Q-D-3. Late ack: the proposer's newest proof can be one behind (finding).**
A frame commits when the receiver signs, so the proposer holds the receiver's signature one message
later. A counterparty that starts a dispute with the previous state in that gap leaves the proposer
holding only the older proof; if the ack arrives after T it is of no use. The safety properties
freeze the responder's holdings at T (a late ack is not one it could have used). This is a real
exposure bounded by the response window against message delay, not a contract defect: the window
floor (H2, 60 s on testnet) has to be far above the worst message delay, and a proposer should
treat its unacked frame as enforceable by the peer only.
Source: A:1466, design/account-model.md P5.

**Q-D-4. Epoch advance and the pre-signed baseline (coordinator N1, revised 17:21).**
Parties sign proofs only for the current ondeltaEpoch (A:1315, A:872), with one exception: every frame
is co-signed together with a baseline proof for epoch + 1 (offdelta 0, no clauses). Without it the
honest side has no valid proof between the epoch advancing and a new baseline being co-signed, and
the counterparty can stretch that gap by refusing to sign. The baseline nonce must be above the chain
nonce after ANY event that opens the next epoch (the settlement update, or a timeout finalize, which
leaves the chain nonce at n0 + 1). Proof nonce and frame height are separate counters.
Choice: baseline nonce = frame nonce + 3. A proposer is at most one frame behind (its ack is in
flight) and a timeout finalize on the newest initial proof leaves the chain nonce one above it; +2
is not enough (planted bug `baseline-too-low`: the proposer holds no valid proof after finalize).
The offset depends on the frame protocol allowing one unacked frame: pipelining k frames needs +2+k.
A cooperative settlement (not in this page) carries the same baseline in its Lock frame and folds
offdelta into ondeltaDiff; v1 requires no open clauses for it.
Source: coordinator decision, A:872, A:1315, D:843-856.

**Q-D-5. Response windows (coordinator N3, floor H2).**
The windows are constants of the Account, fixed at open; every proof carries the same values (A:1471-1474,
GAP-5). The model has one pair of values and the floor check `window-floor-ok?`. The contract uses
the windows only as a sum T = S + left + right (GAP-4): there is no per-side sub-window, and the
non-starter may counter anywhere in [S, T). Options: (a) keep the sum; (b) give each side its own
interval. Choice: (a), it is what the fixed contracts do.
Source: A:1802-1805, A:1466, GAP-4, GAP-5.

**Q-D-6. Time.**
An abstract integer clock, `tick` by one, bounded by `max-time` (default 3). A dispute may only
start if T fits in the horizon, so the liveness goal is "a dispute settles, or the clock ran out".
Real windows are seconds; only the order of S, T, deadlines and reveal times matters.

**Q-D-7. What finalize pays, and in what order.**
Choice: Δ = ondelta + offdelta, then the HTLC (paid if the secret was public by its deadline);
payout by the three-way rule; a shortfall from the debtor's reserve first, the rest as debt. No
credit check on chain (D:960-967): "credit holds" is checked as "what a side owes after finalize
never exceeds the credit extended to it".
Source: D:949-991, A:1085-1130, X:260-298.

**Q-D-8. The three finalize paths (A:751-822).**
5a (counter selected, at or after T), 5c (initial state: at or after T anyone, before T only the
non-starter), 5b (no counter, the non-starter brings a higher-ranking proof and closes at once).
GAP-2: the non-starter can close a stale start immediately, so the "response window" is not a
guaranteed wait; it only ever hurts the non-starter, and the model lets an honest one close only
on its best proof. Rank = nonce, then Left's proposal over Right's at an equal nonce.

**Q-D-9. HTLC deadline, H1 (coordinator decision).**
An unrevealed HTLC blocks finalize until its deadline, unless the secret is public; a secret
public after the deadline does not pay. Planted bug `no-h1`. Coordinator N2 (one open deadline
reverts a whole batch, so finalize is submitted per Account) belongs to the J page.
Source: X:292, D coordinator decision H1.

**Q-D-10. Contract gaps the spec does not model (recorded, not chosen).**
GAP-3 ondeltaDiff in a settlement is unconstrained; GAP-6 R2C is allowed during a dispute and
changes collateral and Left's ondelta between start and finalize; GAP-7 finalize settles only the
tokens listed in the proof body; GAP-9 a zero-amount C2R is a signed no-op that bumps nonce and
epoch; GAP-11 a near-max signed nonce blocks counters. The page is one token and no cooperative
settlement, so 6 and 7 need the multi-token widening.
Source: scratchpad contracts-disputes.md section 8.

**Q-D-12. R2C during a dispute (H4, coordinator: accepted, stated not forbidden).**
Account.sol processR2C has no dispute check (GAP-6), so a deposit made while a dispute is open changes
collateral (and Left's ondelta) between start and finalize, hence the payout. Accepted because each
deposit only raises its beneficiary's share; the receiving entity need not be the funder. The page
models one deposit of 1 by either side for either side, and checks "no side loses more than it funded"
against the payout without the deposit. It holds.
Source: coordinator decision H4, A:1216-1275, D:757-768.

**Q-D-11. Not in the page.**
Pull clauses (5b and 5c must wait for T when one is present), swaps, the watchtower (it can only
register a counter before T or run an already selected finalize, GAP-10), forgiving debts, several
tokens. Model bounds: 3 script states, one rival, one HTLC, two windows of 1, `max-disputes` 1,
`max-time` 2 (a dispute must start at the first tick). Capacity: 4029 states, 7686 transitions, about
100 seconds. With H4 deposits and the baseline proofs, max-time 3 exceeded the 300 s default budget;
before them, max-time 3 was 5220 states and max-time 4 was 9814 states (300+ s).

## Entity consensus (`entity/consensus.scm`)

**Q-E-1. An own uncommitted proposal meets a different certified frame (R-E3, lessons B-E1).**
Options: (a) refuse it and keep the proposal (xln.ts today, `commit_conflict`, pure/xln.ts:28705);
(b) drop the proposal, install the certified frame, keep the txs in the mempool (R-E3).
Choice: (b). With (a) the replica is stranded at the old height while the others move on: the planted
bug `commit-conflict` fails "can always still finish" in the trace propose A, timeout B, propose B.
Half of (b), dropping the proposal but forgetting its txs, loses them (`drop-txs-on-conflict`).
Source: lessons R-E3/B-E1, xln.ts 28693-28705 and 29137.

**Q-E-2. View change.**
xln.ts: a `proposed` replica KEEPS its proposal on a view change (29137). Choice: kept. The page lets
one validator (B) move to view 1 alone, with no timeout certificate, so that two leaders are live at
once (A in view 0, B in view 1): the case R-E3 is about. With every validator free to time out, the
page has no leader in some worlds and exceeds the budget (12186 states at height 2, 524 s, before
the checker speed-up). A real view change with certificates is a widening, not modelled.
Source: xln.ts 28935-29051.

**Q-E-3. Signatures and quorum.**
Three validators, quorum two of three by share. A validator signs at most one frame per height (the
leader's proposal is its precommit); leader + one follower is a quorum, so the follower commits at
once and tells the rest. Property: "a validator signs one frame per height"; planted bug `double-sign`
breaks agreement.
Source: xln.ts 28453-28895.

**Q-E-4. Mempool forwarding.**
A validator that is not the leader sends its retained txs to the leader (xln.ts 27625, 29100). Modelled
as the `forward` rule; committed txs leave the mempool at install.

**Q-E-5. Not in this page.**
Message loss and reordering beyond "delivered in any order" (the Account page covers loss), hashes and
Hanko bytes, `heldQuorum` (signatures before the frame), J-prefix rounds inside consensus (27865-28300,
see j/batch.scm), handover, the four-phase frame pipeline (entity/frame.scm). Bounds: one height, one
tx each for A and B. Capacity: 778 states, 2565 transitions, about 15 seconds.

## J batch (`j/batch.scm`)

**Q-J-1. Partial application (open question 4 of the xln.ts review).**
The chain is atomic: every op applies or none does, and a failure emits nothing but the revert
(Depository.sol processBatch, D:329-575; no per-op result). Choice: the entity treats per-op effect
events as the truth: the event names the ops it applied and they are DONE. An op is never judged by
whether its batch "succeeded". Planted bug `partial-apply` (the chain keeps the ops before a failing
one) breaks the property "every applied op came from a batch that succeeded".
Source: D:329-575, xln.ts 2953-2972.

**Q-J-2. A quarantined batch (open question 3).**
A batch aborted and re-sealed can land after its replacement was sealed at the same nonce; the event
carries a different hash at a nonce >= the pending one, so the pending batch can never land.
xln.ts: `quarantined`, message only; recovery is a manual abort or clear, and the hub-only stale timer
(17961) does not cover other Entities. Choice: automatic `recover`: requeue the pending batch minus the
ops already done. Planted bug `no-recovery` (og today for a non-hub) fails "can always still finish".
Source: xln.ts 2953-2972, 3036, 17961.

**Q-J-3. Abort and then the batch lands (finding).**
`j_abort_sent_batch` requeues the ops. If the aborted batch lands afterwards, the requeued ops are
drafted again and the next batch applies them a second time (a deposit twice). Choice: an event clears
the ops it applied from the draft, whatever batch requeued them. Planted bug `trust-the-draft`.
Source: xln.ts 3036-3062.

**Q-J-4. A full batch is a refusal (lessons R-J3).**
xln.ts: `batchRoom` overflow is `j_batch`, then `batchThrew`, then `entity_invariant`: a halt (2714).
Choice: the op is refused with notice and listed in `refused`. Planted bug `full-halts`. The same
applies to an insufficient reserve for r2r/r2e (2628-2704).
Source: lessons R-J3, R-X1; xln.ts 2714.

**Q-J-5. A finalize goes alone (coordinator N2).**
One open HTLC deadline reverts the whole batch at finalize (H1), so a dispute finalize is never bundled
with other ops: `pick-ops` returns the finalize alone. The contracts already allow one finalization per
batch (B:16). Planted bug `bundle-finalize`: a deposit is held up by another Account's deadline.
Source: coordinator decision N2, X:292, xln.ts 2854.

**Q-J-6. Retry and nonce.**
`retry` resends the sent batch at its own nonce (xln.ts `j_rebroadcast`); the chain refuses any batch
whose nonce is not stored + 1, so a stale copy is harmless. The batch hash is per seal.

**Q-J-7. Not in the page.**
Reorg below finalized height (`J_HISTORY_FINALIZED_REORG` is a Runtime halt today; policy open), the
J-prefix attestation round, Hanko bytes, size and gas limits, several tokens, debt enforcement, watchers.
Bounds: three ops (deposit, finalize on an Account with an open HTLC deadline, deposit), draft cap 2,
one abort, time 0..2, deadline 1, no chain faults (`faults` 0). With one fault (the chain drops or
reverts a batch) the page exceeds the 300 s budget. Capacity: 5262 states, 17049 transitions, about
85 seconds.

## Checker (`lib/check.scm`)

**Q-C-1. What does "live" mean?**
Choice: no fairness model. The check is "from every reachable world, a goal world is still
reachable" (nothing can wedge the protocol), with unbounded resends. It does not prove that a
schedule that never delivers still finishes; nothing can.

**Q-C-2. State identity.**
Choice: a world is identified by a string built from its dicts in insertion order. Worlds must be
built from `init` by updating existing keys, so a page declares every key in `init`.

## Decided by the coordinator (rules the spec carries; not open)

Relayed 2026-09-29 15:19 from the review of the contracts PR (#40).

- **N1. Epoch.** A party signs a proof only for the CURRENT on-chain `ondeltaEpoch`. Signing for
  epoch+1 in advance is unsafe: a dispute finalize can reach that epoch with no settlement. After
  any event that advances the epoch (settlement, C2R, dispute finalize) off-chain payments on
  that Account pause until the new baseline proof is co-signed. Belongs in the Account state machine.
- **N2. Deadlines.** One open HTLC deadline reverts a whole batch at finalize, so the runtime
  submits finalizes per Account, never bundled. A party refuses to sign an HTLC whose deadline is
  beyond its own tolerance (a named policy parameter, not a protocol constant).
- **N3. Windows.** The response windows are fixed per Account at open; every proof of that Account
  carries the same values. Both are at least MIN_RESPONSE_SECONDS (60 on testnet; contracts H2).
- **H1.** Finalize waits until an unrevealed HTLC's deadline unless the secret is public.
- **H3.** Retired-board evidence is capped at collateral.
