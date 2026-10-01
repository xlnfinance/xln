# Spec questions

Every point where the sources leave a choice open, and the reading the spec took. The spec does
not wait for an answer: the comparison with the independent Quint spec, and Arthur, resolve
these. One entry per point: what is unclear, the options, the choice made, the source.

Ids are `Q-<layer>-<n>`. Lessons ids (`R-`, `Q-`, `B-`) refer to `plan/lessons.md`.

## Account (`account/frames.scm`)

**Q-A-1. What does a refusal cost the sender?**
Options: (a) the receiver stays silent and the sender learns nothing; (b) the receiver answers
with a refusal message.
Choice: (b) since R-FRAME-REFUSAL (Q-A-11). The first version of the page took (a): a stale, future or invalid
frame changed nothing at the receiver and the sender's resend and the peer's re-ack made progress. That held only
while nothing could make an honest frame unappliable. With a clock (a deadline that passes while the frame is in
flight) the silent refusal wedges the Account for good: the proposer's frame stays pending, the receiver refuses
its resend again, and a stuck Left frame blocks Right too. A frame that is not the next one and a frame the replica
authored itself stay silent (a stale or reflected frame costs nothing and no honest proposer sends one), a frame already
at my head is re-acked (Q-A-2); what a replica judges and refuses on content or on the clock is answered. Refusal cost in
general is lessons Q-X1, still open.
Source: lessons R-X1 (no peer input halts a Runtime), og issues 1, 3, 4, 6, 7, 8; R-FRAME-REFUSAL.

**Q-A-2. A duplicate of the frame at my head.**
Options: (a) ignore it; (b) answer with the same ack again.
Choice: (b), in ANY state (R-REACK, coordinator 09-30, Account comparison D-AC-1): a repeat of the frame I last
committed is re-acked whether I am Open or hold my own pending frame. With (a), one lost ack wedges the proposer:
the planted bug `no-reack` fails the liveness check "can always still finish" after a single loss. Quint's first
rule re-acked only while Open: a replica that had already proposed its next frame refused the repeat, so the lost
ack was never re-sent (both sides wedged). Planted bug `reack-open-only` is that rule and fails the same check;
Quint took this page's rule and added the mutant, the scenario test and the liveness check.
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
Choice: yes, with the same predicate the proposer uses (`tx-fault`: the conflicts, then the clock). For an honest
proposer the verdict on content is the same (equal head means equal state), so the conflict check never fires; it
is the path a Byzantine or buggy proposer hits. The clock check can fire for an honest one (the receiver's view
differs from the proposer's), and the answer is a refusal (Q-A-11). Since the refusal path exists the proposer's
own re-validation (Q-A-4) is defence in depth: with `skip-revalidation` the peer refuses the tx with `tx_conflict`
and the proposer drops it with notice, so the bug no longer wedges (the case stays in test.mjs as a clean run).
Source: design/account-model.md section 5 (P4: no two proofs per nonce).

**Q-A-6. The link.**
Choice: FIFO with bounded loss and duplication (`max-losses`, `max-dups`; the first page's bound is the config
`account/configs/lossy.scm`: 1 and 1, 3651 states; the default clock world has 1 loss and no repeat, and the config
`repeats` has 1 repeat: with the clock the two together are an order of magnitude larger).
Reordering is not in the base page: the `prev` hash makes a frame from the future refusable, so
reordering can only add stale copies, which duplication already covers. Evidence (R-NET, D-AC-8): the config
`account/configs/reorder.scm` lets the receiver take any of the first three messages of its inbox (Quint's
network is a set and delivers any message in flight) and the page still checks clean (on the first page's world,
the clock off): 7312 states, 33183 transitions, 16 goals, unchanged by R-FRAME-REFUSAL. The base stays FIFO; Quint records its set network as an explicit choice (its A14).
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

**Q-A-9. Time in the Account layer: R-CLOCK and R-HTLC-CLOCK (coordinator 21:56 09-29 and 09-30, Account comparison D-AC-2..4).**
R-CLOCK: no frame is refused for its age or its future date, because a signed frame refused without an exit
deadlocks the Account (the proposer holds the frame, resends the same signed copy, and it is refused again), and a
frame's stamp is never the time (a future-dated stamp let a payer expire a lock before the payee's own deadline).
R-HTLC-CLOCK (09-30): every HTLC time judgment is in J HEIGHT, never by an Account clock or a frame stamp. Each party
judges by its own view, the `max(host.finalizedJHeight, ctx.jHeight)` door of R-CLOCK (`:view` on the page); a view
lags the chain by at most LAG, so two views differ by at most LAG (R-DRIFT; `max-drift`).
(a) A lock is live through its deadline height. The payer accepts a resolve while its own view is <= deadline,
whatever the stamp and the chain height. (Closes the xln.ts `htlc_timeout` hole: at jHeight == revealBeforeHeight the
lock is still live.)
(b) An expiry needs own view > deadline + reserve, strict; the payer when it proposes, the payee when it accepts.
The reserve is in J heights and at least LAG (`clock-reserve`), so a party past deadline + reserve has a counterparty
within LAG of it, which is past the deadline.
(c) A payee whose resolve is still unacked when its own view reaches deadline - LAG reveals on-chain (C11 already
makes the dispute window larger than LAG). Assumption (diligence, as on the other pages): a payee that owes the
reveal does it before the chain moves on and before it decides an expire frame (`payee-duty?`).
The page `account/clock.scm`: the chain height, two views that only catch up (bounded by LAG behind the chain), one
lock with a deadline, a pay frame, an expire frame (the payer may propose it at any time, so the payee's check alone
must hold), a resolve frame with any stamp, any delay. Properties: no frame refused for its age or date; an expiry
commits only when both parties' views are strictly past the deadline; a resolve is refused only when the payer's own
view is past the deadline; a payee holding the secret has revealed on-chain before an expiry commits.
Planted bugs: `refuse-late`, `refuse-future`, `expire-by-frame-stamp`, `expire-at-deadline` (>= instead of >),
`expire-no-reserve`, `resolve-late-by-stamp`, `resolve-by-chain-height`, `payee-idle`. Config `no-secret`: the payee
holds no secret, the lock can only expire. Capacity: 2730 states, 10546 transitions, 260 goals.
Quint: the same rule, its receiver reads a J-height view, never a proposer-written field; its bounded drift and its
`expiredEarly` oracle stand (D-AC-4); this page carries `max-drift` and the both-views property as the oracle.
Consequence for the other pages: the dispute page's clock is the chain's (Q-D-20); the J batch page's deadlines are
the chain's. An early expire is refused on CONTENT (a nack); a signed frame that is valid but early is not refused.
Not modelled: several locks, the on-chain dispute itself (the dispute page has it), a view that stalls.
Source: coordinator R-CLOCK (21:56), #57 (01:11), R-HTLC-CLOCK (09-30).

**Q-A-10. A refused tx stays refused when its predecessor is rolled back (a6 of the round-2 review).**
A validator refuses a tx that conflicts with the history before it, including the txs ahead of it in the SAME
frame (bug `frame-order` checks a frame's txs against the committed history only, so a frame holding two
conflicting txs slips through). The refusal is final with notice. If the predecessor is then rolled back (a
cross-open that Left wins), the refused tx would have been valid: the sender resubmits it. Choice: no
re-admission (a refusal is an event, not a state), stated as the property "a refused tx has a conflicting
predecessor among the submitted txs": it checks the pair, not the state at the time of the check.
Bound: `account/configs/same-side-conflict.scm` (Right's own txs "x" then "y" conflict; 5650 states since the refusal and the proof slots
messages and the mark, Q-A-11, Q-A-12) and a
Byzantine frame rule (`byz-frame`: a proposer sends its whole mempool as one invalid frame), so the receiver's
validation is the only thing between the frame and the history. Planted bug `frame-order`.
Source: review of PR #41 round 2, a6.

**Q-A-11. R-FRAME-REFUSAL: a frame the receiver cannot apply (coordinator 10-01 01:03, kernel handoff A4a).**
The page has a coarse J clock (`:clock`, 0..`max-clock` = 2, a rule ticks it, so it can move between a frame's proposal
and its receipt) and each side reads it when it proposes and when it receives, the read lagging it by 0..`view-lag` (= 1,
LAG; the lag is not remembered between reads). Two clock-dependent tx kinds: a LOCK (`lock-txs`) is applicable while
view < deadline <= view + horizon (`lock-deadline` = 1, `lock-horizon` = 1), an EXPIRE (`expire-txs`) only when the view is
past the deadline. The faults: `tx_conflict`, `deadline_passed` (a lock whose deadline is now too near), `not_expired` (an
expire the receiver's view does not yet allow), `deadline_too_far`; the last two are RETRYABLE (they pass with the peer's
view moving). A receiver that cannot apply a frame answers with a refusal naming the frame hash, the index of the first tx it
refused, the fault and its mark (Q-A-12). The proposer commits only on an ack, so on a refusal that names its pending frame
it rolls the frame back and re-proposes: a retryable fault puts EVERY tx back with no notice, up to the budget
(`max-attempt` = 2; MAX_ATTEMPTS is 8 in the kernel); any other fault, or a spent budget, drops the named tx WITH NOTICE
(R-NOTICE, `:refused`; it releases the payer, except a lock in a signed proof, R-SIGNED-IS-LIVE, Q-A-14) and puts the rest back ahead of the mempool. A refusal that does not name the
pending frame (it committed, or was rolled back already), or whose index names no tx of it (kernel F3), is ignored. The
proposer judges its own mempool by its own view at proposal: a tx with a non-retryable fault is refused with notice, one with
a retryable fault WAITS and holds back the txs behind it (submission order). Left wins (R-A1) still decides simultaneous
proposals, and the mark is checked before it (a refusal is answered even while Left holds its own frame out).
Properties: the existing ones, and "can always still finish" now WITH the clock moving (default world: Left's lock and expire,
Right's x; `lock` and `x` conflict, no lost message; 4563 states, 18600 transitions, 44 goals with the proof slots of Q-A-14). Planted bug `ignores-refusal` (the proposer
ignores the refusal: the frame stays pending, the receiver refuses its resend again, the Account wedges): red on "can always
still finish". Config `far-lock`: the other retryable fault (a lock beyond the horizon), 9135 states (the clock runs to 3 there, so that a lock held for a signed proof can lapse past deadline 2, Q-A-14). Config `lossy-clock`: the default world with one lost message (the old default).
Not modelled: signed refusals and the signature-before-memory order (A4b, R-FRAME-HASH-SIGNED), pacing of retries by the Runtime
(a retry is cheap only if the Runtime waits for the peer's view to move), the attempt cap on the receiver (attempts keep counting
past `max-attempt`).
Source: contracts-decisions.md R-FRAME-REFUSAL; handoff-a4.md (A4a, rounds 1-3).

**Q-A-12. Attempt number (kernel A4a, rounds 2 and 3).**
A frame carries `attempt`: the refusals its proposer has handled on this head (0..MAX, bounded here by `max-attempt` for the
retry budget; the number itself keeps counting). The attempt is part of the frame's content and of its hash (the head is the list
of (txs, attempt, author) entries). The receiver keeps ONE mark per head: the highest attempt it refused, with the fault
(`:mark` = attempt, index, fault). A frame at or below the mark is not judged: an equal attempt is refused again with the same
refusal (index and fault of the mark); a lower one is answered with a refusal of fault `stale_attempt`, index 0, carrying the mark.
A frame above the mark is judged afresh. The mark is forgotten whenever the head moves (a commit, either way); a repeat of the
frame at my head (the re-ack) does not touch it. The proposer sets its next attempt to max(own, mark) + 1; a stale answer costs
no tx and no retry budget. Why: an honest proposer never sends two different frames at one attempt, so a forged frame refused at
attempt 0 also refuses a genuine frame at attempt 0 on that head; and the mark makes a refusal final for its head, so a
receiver whose view moves later cannot commit a frame whose proposer already took it back (it would fork from it).
Property "R-FRAME-REFUSAL: a frame the proposer took back is never committed by the peer (a refusal is final)": when the peer's
history is ahead of a replica's by a frame, that frame is the replica's pending one (the peer acked it and the ack is on its way);
a frame the proposer no longer has out and the peer holds is the failure the mark exists to prevent. Planted bugs:
`refusal-forgotten` (the receiver keeps no mark: it commits the frame it refused after its proposer took it back) and
`below-mark-judged` (config `repeats`: a late copy of an earlier attempt is judged afresh and commits), both red on that property;
`attempt-not-bumped` (the proposer re-proposes at the same attempt, the very frame refused: refused again for ever, red on "can
always still finish"). Before the proof slots (Q-A-14) the first two forked the replicas, red on "committed histories agree": with
the slots the fork is closed by another rule (the proposer's abandoned proof blocks acking the winner's lower frame, `stale_slot`), so
what is left of the bug is the wedge, and the property that names it is the one above (the old ones went red on "at rest"). The property sits after "no committed tx is invalid" in the list on purpose: the checker reports the first violated property at the shallowest state, and a Byzantine frame a planted validator commits (`frame-order`) is also a frame its named author never had out, so the property that names that bug has to come first.
Replay against the kernel thread's count: the kernel's same-side-conflict replay of the attempt rule is 3167 states / 9603
transitions / 22 goals against the first page's 3423 / 10383 / 24. This page's same-side-conflict config
(`account/configs/same-side-conflict.scm`, which is the first page's world with the clock off) is 5650 / 17489 / 26 (4694 / 14434 / 26 before the proof slots, Q-A-14): it does NOT
match, and the difference is known. (1) This page DELIVERS refusals (the proposer must handle them), so a refusal message is
a state of the link; the kernel's replay filters refusal messages out of the link. With the refusals filtered out the page
explores 3507 states / 10570 transitions / 22 goals (the goal count matches) and the liveness check FAILS: a genuine frame
refused at the forged frame's attempt is never answered and Right's frame stays pending (so the replay's 22 goals count the
`done` worlds, not liveness). (2) Leaving the mark out of the world key (what the replay seems to do, though it changes
behaviour) gives 3164 / 9595 / 22, three states and eight transitions short of the replay's count: not an exact match,
and the remaining difference is not explained from this side.
R-RETRY-NEW-NONCE (coordinator, A18): a retry at attempt a signs its proof at a FRESH proof nonce, pnonce + 1 + a, never two
different proofs at one nonce by one proposer: the receiver already holds the proposer's signature on the refused attempt's
proof, and with a reused nonce it could present whichever of two same-nonce proofs suits it, which the chain cannot order. The
page models it since the proof notion of Q-A-14 (the slot in the frame and in its hash, planted bug `retry-reuses-the-nonce`).
Gaps in the proof-nonce counter cost nothing: they appear after a refused attempt and between the two sides' lanes (a first slot of Left is the committed slot + 2, Q-A-14).
Source: handoff-a4.md rounds 2 and 3 (F1, F4, N1, N2); review of PR 85 (Review B round 2); coordinator A18 (R-RETRY-NEW-NONCE, Q-A-14).

**Q-A-13. Frame author (kernel `refused_own`, Quint `f.author != self`).**
Arrival's frames carried no author, so the page could not see a replica commit its OWN frame when it is handed back as the
peer's (the pending frame accepted as received): under one head a state fork that flips the credit direction. The frame now
carries `:author` and the author is in its hash (the head's entries are (txs, attempt, author)). A replica refuses (silently:
nothing honest sends it) a frame whose author is itself. To make it reachable the link has a `reflect` rule: it hands a replica
its own pending frame back (`max-reflect`, 0 in the default world, 1 in the config `reflect`). Property "a replica commits its
own frame only after the peer did (frame author)": every entry of a replica's history that it authored is already in the peer's
history (the author commits on the peer's ack, and the peer acks after it committed). Planted bug `accepts-own-frame`
(config `reflect`): red on that property. (The page has no ledger, so the flipped credit is not shown; the fork is the author
holding the frame before its peer did.)
Source: kernel `refused_own`; Quint account_core.qnt (`f.author != self`).

**Q-A-14. Proofs on the frames page: R-RETRY-NEW-NONCE, R-PROOF-NONCE-ABOVE-SIGNED, R-SIGNED-IS-LIVE (coordinator 10-01; kernel PR 97 round 2, evidence review/a4b/reviewer-a-pr97 and reviewer-b-pr97).**
The page had no proof, so none of the three rules could be stated. It now has the smallest notion that states them: every
PROPOSAL signs a proof at a SLOT (the proof nonce), and a proof exists once it is signed, whether or not its frame ever commits.
The shape follows the kernel's (pure/account/frame/frame.ts at 2f81bd4), not the first version of this page (a nonce computed from
the attempt, which could not carry the rule across the two sides: Review B of PR 97, finding 1).
- **The slot is carried in the frame** (`:slot`, in its hash with the attempt and the author). `used` is the slot of the newest
  committed frame (0 on the empty head). A slot is in its author's LANE: Left's is an even distance above `used`, Right's an odd
  one, so the two sides never share a slot, and at the first collision on a head Left's is the higher (Left 2, Right 1, then 4 and
  3). A proposer takes the lowest slot in its lane above its FLOOR, the highest slot either side is known to have signed (its own:
  `:dead`, the frame out, `used`; the peer's: `:peer-high`). A retry therefore signs a fresh slot above the refused one
  (R-RETRY-NEW-NONCE), and the nonce of a proof is no longer a function of the attempt (the attempt stays a label for the receiver's
  mark). Gaps in the proof-nonce counter cost nothing: they appear after a refused attempt and between the two lanes (Left's first slot is `used` + 2, Right's `used` + 1).
- **R-PROOF-NONCE-ABOVE-SIGNED.** Every committed frame is strictly above every proof either side has signed, the yielded and
  refused attempts included, and no two different proofs of one signer share a nonce. Each replica records at its own commit
  whether the frame it commits is above the proofs it signed and took back (`:dead`; the frame it commits as its own is the one
  proof it may equal): `:above`, read by the property "R-PROOF-NONCE-ABOVE-SIGNED: a committed frame's proof is above every proof
  signed before it, yielded and refused ones included". The head moving resets `:dead` and `:peer-high` (the proofs of the
  earlier head are below the new frame). The rules that keep it:
  (1) THE DOOR: a receiver believes a slot only if an honest peer could have taken it: in the author's lane, above `used`, at
  most one lane step above what the receiver knows either side signed; otherwise it refuses with `bad_slot`. A frame heard at an
  honest slot is NOTED (`:peer-high`): the peer signed it, so what I propose next goes above it, whatever else happens to the frame
  (without the note the page loses liveness: a proposer that does not know what the peer signed keeps colliding below it).
  Property "..., the door: a committed slot is at most one lane step above what its receiver knew either side signed" (the receiver
  records it at commit with the reach it computed before noting the frame). A Byzantine peer's one frame must not move the nonce
  space (kernel finding 3): rule `jump`, bound `max-jumps`, config `slot-jump`.
  (2) THE COLLISION: the frame with the HIGHER slot wins, whoever it is: a replica with a frame out ignores a peer's frame of a lower
  slot and rolls its own back for a higher one. R-A1 (Left wins) is the special case of the first collision on a head.
  (3) THE STALE SLOT: a replica with no frame out acks no slot at or below a proof it signed and left behind (its taken-back
  frames): it refuses with `stale_slot`, which costs the proposer no tx and no retry budget, like `stale_attempt`.
  (4) THE FLOOR: every refusal carries the refuser's floor, the highest slot it signed. The proposer adopts it (its next frame goes
  above it) only if an honest peer could have signed it (the same reach), else the refusal is ignored. Property "..., the floor: a
  stale_slot refusal names a floor at or above the slot it refuses": the floor is the slot that clears the refusal.
  Planted bugs, each red on its property: `yield-below-own-proof` (the collision decided by side, not by slot: Right signs a retry at
  slot 3 and yields to Left's first frame at slot 2; config `right-expire`; it is also "a collision won by the lower slot"),
  `stale-slot-unchecked` (no `stale_slot`: a frame commits below a proof the receiver signed and left behind),
  `retry-reuses-the-nonce` (R-RETRY-NEW-NONCE: the retry takes the slot above what the PEER signed and not above its own abandoned
  proof, so it commits at a slot it already signed another proof at), `slots-shared-lane` (one lane for both sides: both propose at
  the same slot, and the yielder signs two proofs at one nonce, Review B finding 1), `refusal-without-floor` (the floor property),
  `slot-beyond-reach-accepted` (no limit on the jump: config `slot-jump`, the door property). The first four are red on "R-PROOF-NONCE-ABOVE-SIGNED:
  a committed frame's proof ..."; `no-tie-break` now is as well (both sides yield: the first yield already commits below the
  yielder's own proof, the fork is one step later). `attempt-not-bumped` is a retry that is the very frame refused (same attempt,
  same slot), so its state space stays finite: red on "can always still finish". `commit-any-frame` (a duplicate of a committed frame is
  taken for the next one) is now refused at the door and its proposer drops the tx of a frame the peer holds: red on "R-FRAME-REFUSAL: a
  frame the proposer took back is never committed by the peer" (it was "no tx is both committed and refused" before the slots).
- **R-SIGNED-IS-LIVE.** Anything a side has signed stays enforceable against it until a higher-nonce frame commits, so a refusal
  or a yield does not release the payer (the upstream hold) of a lock that sits in a signed, unsuperseded proof. Release only
  on supersession or after deadline + reserve. This changes R-NOTICE for a lock: its notice (`:refused`, the release) is no
  longer given at the refusal when the lock is in a proof the proposer signed (the refused frame, or an earlier attempt that
  was taken back; `:signed`); the lock is PARKED (`:parked`, still held) and released when a frame commits (the next frame has
  a higher slot, so every proof it supersedes is dead) or by the rule `lapse` when the chain clock is past
  `lock-deadline + lock-reserve` (`lock-reserve` is 0 here: the page's clock is the chain's own height and the lag is in the
  views; the real reserve is at least LAG, R-HTLC-CLOCK b). A tx that was never signed (the proposer refused it at its own
  proposal) is released at once. Property "R-SIGNED-IS-LIVE: a lock in a signed, unsuperseded proof is not released by a
  refusal": no lock in `:refused` is in a proof still signed and live (`:signed` or the frame out). Planted bug
  `refusal-releases-signed-lock`: the refusal releases the hold at once while the peer still holds the proof with the lock, and
  the lock is enforceable on chain: red on that property. The page models the payer-side hop; the upstream account and the
  peer's on-chain presentation are the property's reading of `:refused` and `:signed`, not separate rules.
- **OPEN: R-FRAME-SIGNATURE-NAMES-ACCOUNT (kernel PR 97 round 2).** The bytes of a signed frame and of a signed refusal name
  the chain, the depository, the Account and the epoch, so a signature does not replay across them: a frame or a refusal signed
  for another Account or epoch is refused. NOT modelled: the page has one Account and one epoch, its frames carry no scope
  (account id, epoch) and there is no signature, so a replay across Accounts or epochs cannot be stated, let alone planted. What
  the page would need: a scope in the frame and in its hash, a replica that knows its own scope, a rule that hands a replica a
  frame signed for another scope (a replay), the property "no committed frame carries another scope" and one planted bug (the
  scope not checked). The epoch half belongs with the dispute page (epochs, Q-D-21) rather than here.
Not modelled: the chain nonce and the presenter, the peer's copy of the proof (a proof the peer never received is the
proposer's own and still counts as signed), the nonce ceiling (the kernel refuses a frame it cannot sign at the contract's limit;
here slots are unbounded integers, finite only because every run is), a restarted proposer that lost its floor.
Source: coordinator 10-01 (A18 R-RETRY-NEW-NONCE; R-PROOF-NONCE-ABOVE-SIGNED, round 2: slot in the frame, floor in the refusal, reach
bound, collision by slot; R-SIGNED-IS-LIVE); kernel PR 97 (577a6d7, 2f81bd4) pure/account/frame/frame.ts and slot/*.test.ts;
review/a4b/reviewer-a-pr97 and reviewer-b-pr97.

**Q-A-15. R-COSIGN-FREEZE: a co-signed settlement or C2R freezes both sides (coordinator 10-01).**
After a side co-signs a settlement or a C2R, it proposes no frames and refuses every peer frame with a RETRYABLE `frozen`
refusal until the operation lands, is superseded, or the host reports it lapsed. The rule runs both ways: both sides
co-sign, so both are frozen. The refusal follows the attempt and mark rules of R-FRAME-REFUSAL (Q-A-11, Q-A-12): `frozen` is in
`retryable?`, so the proposer rolls the frame back and requeues every tx with no notice, within the budget, and the receiver
remembers the refusal in its mark like any other. Why it is needed: the settlement folds offdelta (R-C2R-FOLD, Q-D-26) at the
value it was signed over; a frame accepted afterwards moves offdelta away from that value, and the operation that lands folds a
number the Account no longer has.
The page: a world counter `:settles` and a bound `max-settles` (0 in the default world, 1 in the config `freeze`); the txs in
`pay-txs` move offdelta by one unit each (`offdelta` is read off the committed history, no ledger); the rule `cosign` is enabled
when the two replicas share a head and signs the fold = the offdelta of that head into both (`:fold`; #f when nothing is signed,
so `frozen?` is "`:fold` is set"); `can-propose?` is false while frozen; `on-next-frame` refuses a peer frame as `frozen`
(index 0, mark = the frame's attempt) after the mark check and before Left keeps its own; the rule `unfreeze` ("the settlement
lands or lapses") frees both. The three exits of the operation (lands, superseded, lapsed) are one rule: the page has no chain, so
what the fold does when it lands is not modelled, only that the freeze ends and that no frame moved the head while it stood.
Property "R-COSIGN-FREEZE: while a settlement is signed, its fold equals the off-chain offdelta of the head", stated on the signed
fold and the off-chain state and NOT through the freeze guard (`refuses-frozen?`). Planted bug `frozen-accepts` (the guard is
off: the frozen side accepts a peer frame that moves offdelta after the fold was signed), config `freeze` (Left's p and Right's x
move offdelta, no clock): red on that property. The config's clean run: 2392 states, 6982 transitions, 16 goals.
Not modelled: the fold's landing, a settlement that also carries a C2R amount, the host's report as a separate event, and a
frozen replica's own frame already out when it co-signed (it stays out; the frozen peer refuses it and the proposer retries it
after the unfreeze).
Source: coordinator 10-01 (R-COSIGN-FREEZE); R-C2R-FOLD (Q-D-26).

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

**Q-L-5. What each rule DID (step properties, review of PR #41).**
A property of a world cannot see a rule that moves the wrong amount in the wrong direction and still
lands on a world with RCPAN (the guard and the invariant are one formula). The checker now takes
`:steps`, properties over (world, rule, side, next world), and the ledger states what each rule does
from the formula: a payment moves the payer's allocation by exactly its amount; a resolved clause
moves Δ against its payer; a lapsed clause moves nothing; R2C/C2R move one unit between reserve and
collateral and a Left deposit is Left's allocation; a credit change changes only the limit. Planted
bugs: `pay-wrong-way`, `resolve-wrong-side`, `expire-pays`, `deposit-no-ondelta`.

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

**Q-D-3. Late ack: a dispute pays what both sides had committed only if the ack beats the window.**
A frame commits when the receiver signs, so the proposer holds the receiver's signature one message
later. A counterparty that starts a dispute with the previous state in that gap leaves the proposer
holding only the older proof; if the ack arrives after T it is of no use. This is a real exposure,
not a contract defect. It is now a stated assumption and a property, not a finding inside a
question: ASSUMPTION `ack-in-window?` (the ack delay is shorter than the response window; the tick
is blocked while an ack is pending and the next tick would reach T), and PROPERTY "a dispute pays
what both sides had committed: the final proof ranks at least the newest frame proposed by T".
Planted bug `late-ack` drops the assumption and the property fails (propose n1, ack, propose n2,
start n1R, two ticks, finalize on n1R). The window floor (H2, 60 s on testnet) has to be far above
the worst message delay, and a proposer treats its unacked frame as enforceable by the peer only.
Source: A:1466, design/account-model.md P5; review of PR #41 (the literal form fails).
Round 2, B2: the carve-out has a floor now. "A hasty close still pays at least the newest frame both sides acked"
is its own property (a responder that closes before T while the ack of its own frame is in flight may lose that
frame, never an acked one). The killer needs a config without a cross-open (`dispute/configs/no-rival.scm`):
with a rival on the table a shallower state trips "the responder is never worse off" first (that property is
implied by this one and sits after it). Planted bug `hasty-stale`.
Round 2, B6 (clock assumption, decision for the coordinator): `ack-in-window?` is `#t` on every page; the only
killer is `late-ack`, which drops it. It is a CLIENT obligation, not a contract rule: the contract cannot see the
ack, and the only contract-side lever is the window floor (H2, R-C11: the window is above LAG). Recommendation:
keep it a client obligation and document it as a deployment requirement: window >= worst ack delay + LAG. If the
coordinator prefers a contract rule, the candidate is "a counter may be registered until T + one message
delay", which weakens the finalize timing for everyone; not recommended.

**Q-D-4. Epoch advance: no proof is pre-signed, the implicit proof takes its place (coordinator N1, revised 17:21; CLOSED by decision D2, R-IMPLICIT-BASELINE).**
Parties sign proofs only for the current ondeltaEpoch (A:1315, A:872). The N1 revision of 17:21 co-signed a baseline
proof for epoch + 1 with every frame (nonce = frame nonce + 3), so that an epoch advance never left an honest side
without a valid proof. That machinery is gone. Decision D2 (Q-D-21, contracts-decisions.md "R-IMPLICIT-BASELINE"):
from ondelta epoch 1 a dispute may start from the IMPLICIT proof, which nobody signs because every field of it is on
chain. The page carries it as `implicit-proofs`, the base of every epoch after the first (see Q-D-21 for the rule and
the Right author). Nothing is co-signed ahead any more, so the nonce arithmetic it needed (frame + 3, the settlement
baseline, the post-frame nonce above every baseline) is retired with its three planted bugs (`baseline-too-low`,
`settle-nonce-high`, `settle-no-baseline`). What replaces the post-frame rule is the stored + 2 rule (Q-D-21).
A cooperative settlement folds offdelta into ondeltaDiff; v1 requires no open clauses for it (in the page since
21:35, see Q-D-19).
Source: coordinator decision, A:872, A:1315, D:843-856; decision D2.

**Q-D-5. Response windows (coordinator N3, floor H2; revised by decision D2).**
Each proof carries its own windows (the policy it was signed under); the floor is MIN_RESPONSE_SECONDS (60 s testnet, 6 h
mainnet), and the implicit proof of an epoch names the floor. Inside an epoch the windows may LENGTHEN and never SHORTEN:
a counter or a final body whose windows are below the started ones is refused (E9), so a policy that lowers its windows
makes a newer frame uncounterable against a stale start with longer windows (review B, risk 5). The page: a proof is
(nonce proposer off clause rival? epoch wl wr implicit?), `frame-extra` is the policy (the base signs at the floor, the
config `window-policy` lengthens the later frames), `windows-keep-ok?` is the signing rule (neither side signs a frame
that shortens the newest committed windows), `windows-ok?` the contract's E9 check on a counter and on the immediate
close, and two properties cover the two halves: "windows never shorten inside an epoch: a later co-signed proof carries at
least the windows of an earlier one (the signing guard)" and "a counter or final body carries at least the started windows:
the chain's E9 check, whoever signed it" (Q-D-25); planted bugs `counter-shortens-window` (with `window-policy`, the signing
guard) and `e9-dropped` (with `byz-window`, the chain's check). Windows take two values at most (floor, floor + 1). The contract uses the windows only as a sum
T = S + left + right (GAP-4): there is no per-side sub-window, and the non-starter may counter anywhere in [S, T).
Options: (a) keep the sum; (b) give each side its own interval. Choice: (a), it is what the fixed contracts do. The floor
is the real response guarantee: a Runtime must land its counter inside it (a Runtime duty to watch its own disputes
within the floor window; watchtowers stay out of v1, D5).
Source: A:1802-1805, A:1466, GAP-4, GAP-5; review B of PR 76 (finding 5); decision D2.

**Q-D-6. Time.**
An abstract integer clock, `tick` by one, bounded by `max-time` (default 2). A dispute may only
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
tokens. Model bounds: 5 scripted frames (one refused by RCPAN), one rival, one HTLC, two windows of 1,
`max-disputes` 1, `max-time` 2 (a dispute must start at the first tick). Capacity: 5397 states,
9946 transitions, 2486 goals, about 4 minutes alone (round 2: settlement, the post frame and the horizon are
in; it was 9771 states before the payee's dispute ops carried the secret; 5571 states before the implicit proof
replaced the co-signed baselines, D2). The implicit-proof page adds `two-disputes` (5432 states, 7179 transitions,
5333 goals, about 3 minutes: the second dispute starts from the implicit proof, a deposit of the new epoch is
explored between the two) and `window-policy` (`max-time` 3, 12577 states, 23004 transitions, 5868 goals, about 11
minutes). Second bounds, all in
`dispute/configs/`: `far-deadline` (N2), `no-rival` (B2), `retired-left` and `retired-right` (H3),
`right-reserve`, `two-disputes` (Q-D-21) and `window-policy` (N3). The review measured
`max-time 3` with the HTLC deadline at 2 on the 3-frame script (10120 states, 331 s). Not modelled yet:
N2 tolerance (H3 is in, Q-D-22; a second dispute after a dispute is in, `two-disputes`). Secrets in calldata (Q-D-18)
and the settlement branch with nonce continuity (Q-D-19) are in.

**Q-D-13. The proofs are built by the frame rules, not listed (review of PR #41).**
Before, proofs were ids into a table of states the author chose: "both sides sign the same proof"
was a tautology and "credit holds" held because of the chosen numbers. Now a frame is a tx (`pay`,
`lock`, `unlock-pay`) that each side applies to ITS OWN committed proof; the proposer signs its
body, the receiver recomputes and signs only if the bodies are equal and RCPAN holds on it
(`receiver-accepts?`, `rcpan-ok?`). The last tx of the script (Left pays 3 more) breaks RCPAN and
is refused. Planted bugs: `blind-sign` (the receiver signs a body that differs from the
proposer's: "both sides sign the same proof" fails right after the ack) and `no-rcpan` (nobody
checks: the payment goes through and a dispute books debt 3 against a credit of 1: "credit holds"
fails). The full composition with the Account frames page (lost messages, refusals) is still open:
this page has one FIFO stream of frames and a fixed script.
Source: review of PR #41 (properties 2 and 3 of the done list).

**Q-D-14. The honest responder waits for its own ack.**
An honest non-starter closes a dispute early (5b, 5c) only if no ack of a frame it proposed is on
its way: that ack brings it a better proof. Without this guard the responder ends the dispute on
the starter's stale proof while the newest frame, which both sides committed, is unacked, and the
literal property of Q-D-3 fails. Same family as the assumption of Q-D-1.

**Q-D-15. Properties restated from the contract's rule (review of PR #41).**
Five properties are written from the contract text and not through the page's own helpers, so a
wrong Δ or a wrong nonce cannot hide: no reserve, collateral or debt is negative (`shortfall-uncapped`);
Δ = ondelta + offdelta, less the clause if it paid (`delta-drops-ondelta`, `htlc-sign-flipped`); a
clause pays exactly when its secret was public by the deadline (`secret-strict`, `secret-any-time`);
a counter is registered strictly before T; a timeout finalize consumes one nonce and an adopted
proof sets it (`chain-nonce-stale`). The counter-at-T mutant of the review is EQUIVALENT under the
assumption of Q-D-1: the clock cannot reach T while the responder holds a better proof, so a counter
at T never arises; the property stays, and no planted bug is kept for it. To make it bite, weaken
the assumption (a responder that may be late), which is what `no-floor` does.

**Q-D-16. A hasty close is the responder's own harm.**
The contract lets the non-starter close before T (5b, 5c) while an ack of a frame it proposed is
still on its way. Then it ends on the starter's older proof. The record marks it `:hasty` and the
"pays what both sides had committed" property skips it; "after an epoch advance each side still
holds a valid proof of the new epoch" covers it (the implicit proof is always there; planted bug
`implicit-nonce-stale`: it carries the stored nonce itself, so it is not above it).

**Q-D-17. Every dispute window is greater than LAG (R-C11, coordinator 18:57).**
LAG is the time to read a J event and get an op included. The responder sees a start at S + LAG and
its counter lands LAG later, so a window at or below LAG leaves it no time. The floor is
window > LAG on every proof (testnet: 60 s, far above LAG), stated next to H2. The page has `lag`
(0: LAG is below one model tick, the tick being the smallest window) and a counter that must LAND
before T (now + LAG < T). Planted bug `window-below-lag` (LAG one tick, no floor): the responder
cannot answer a stale start and "the responder is never worse off than the newest proof it held"
fails. With LAG at a tick and correct windows of 2 the page would need `max-time` 4: not run.

**Q-D-18. The payee's dispute ops carry the secret (lesson #37, R3, coordinator 21:35).**
Before: the page had a separate `reveal` (the payee publishes the secret at any time) and a dispute
never carried one, so a payee that started or countered without revealing lost the clause at the deadline
and nothing said it should have known better. Now: every dispute op by the payee (start, counter,
finalize) carries the secret it knows for the frozen Account's locks, whichever proof it presents (the
calldata IS the reveal, so the chain sees it at the op's time). The payee knows the secret once the lock
frame exists. The separate `reveal` stays (a reveal op in a batch of its own, R-SPLIT). Property: "a
payee that acted before the deadline knowing the secret is never left with the clause unpaid". Planted
bug `omits-secret` (the op leaves it out): start on the older proof, the counterparty counters with the
clause proof, the deadline passes, the clause is unpaid. The routing page has the same rule one level up
(R3, `dispute-omits-secret`). Contract side: `starterArguments`/`otherArguments` are the carrier (Account.sol
dispute args, committed by hash); whether they carry EVERY known secret or only those of the presented
proof is the open point for the contracts.
Source: lessons #37, relay 18:10 R3; A: dispute argument commitments.

**Q-D-19. The settlement branch and nonce continuity after an epoch advance (N1, coordinator 21:35).**
The contract (Account.sol processSettlement, processC2R): a cooperative update is signed at a nonce
strictly above the stored nonce, the stored nonce is SET to it, offdelta is folded through
`ondeltaDiff`, and the epoch advances. The page adds `settle` (v1: no open clause; heights 1 and 2 of the
script are offered), `post frame` (the first frame of the new epoch) and a dispute in the new epoch.
Rules the page carries, each with a planted bug:
- The settlement nonce is above the chain nonce (frame height + 1). It no longer has to stay below baselines: none is
  co-signed (decision D2, Q-D-21).
- A settlement moves no allocation: Δ and the money are the same before and after; offdelta folds into
  ondelta (`settle-drops-off`). It carries no open clause in v1 (`settle-with-clause`).
- Proof nonce and frame height are separate counters. The settlement leaves the chain nonce at its own nonce, and the
  first SIGNED proof of the new epoch takes nonce >= stored + 2 (Q-D-21): the page's `post-nonce` is chain + 2. At
  chain + 1 a Right-authored frame only ties the implicit proof and a dispute pays the empty state, so Left's frame
  is lost (planted bug `post-nonce-low`, the spec's killer for review B finding 3). The proof nonce is NOT required to be
  gapless (R-PROOF-NONCE loosened, coordinator A18 and the kernel thread A4b): the contract never needs stored + 1 for a
  SIGNED proof (a start needs a nonce above stored, a counter one at or above the opening nonce, a finalize one at or above
  stored; only the unsigned implicit baseline uses stored + 1), so a signed proof may skip nonces: an honest proposer
  leaves gaps after a refused attempt (a retry signs a fresh slot, R-RETRY-NEW-NONCE) and between the two sides' lanes (Left's first
  slot on a head is the committed one + 2, Right's + 1; Q-A-12, Q-A-14).
  The page's `post-nonce` (chain + 2) is a floor, not a counter.
Not modelled: several frames after a settlement, a settlement with open clauses (v2), several tokens, the
finalize-then-continue path (the implicit proof covers it, the frame after it is not walked).
Source: Account.sol 1590-1690, 1354; coordinator N1 (revised), relay 21:35.

**Q-D-20. MAX_LOCK_HORIZON (N2, coordinator 21:50).**
A named policy parameter (default 7 days on the real system, never below the 24 h async window). A party
refuses a lock whose deadline, in time or J height, is beyond it (`deadline_too_far`), and a hub refuses
to forward one. Reason: under H1 a finalize waits for an open lock's deadline unless the secret is public,
so a lock years out blocks cooperative and dispute close until the secret appears. In the page:
`max-lock-horizon` (model units, default 1) and `horizon-ok?`, applied in `frame-ok?`, so BOTH sides
recompute it and a lock frame beyond the horizon is never signed. Property: every held clause is within
the horizon of the clock (the clock only grows, so it holds for as long as the proof is held). Config
`dispute/configs/far-deadline.scm` (deadline 3): the lock is refused while it is far, the page settles.
Planted bug `no-horizon` (with that config): the far lock is signed. Choice to confirm: the horizon is a
LOCAL policy (each party's own tolerance), not a value both sides must agree on; a party that accepts a
farther lock than its peer does simply gets refused by the peer at signing.
Source: coordinator N2 (21:50); H1.

**Q-D-21. Two disputes in a row, and the implicit proof (finding of `max-disputes` 2, round 2; CLOSED by decision D2, R-IMPLICIT-BASELINE; the author is RIGHT).**
Finding (round 2). The page used to co-sign a baseline with every frame. With `max-disputes` 2
(`dispute/configs/two-disputes.scm`) the property "after an epoch advance each side still holds a valid proof of the
new epoch" failed in five steps: the second advance happens before any frame of epoch 1 exists, so nothing was
co-signed for epoch 2, and a unilateral deposit into epoch 2 (R2C needs no signature) had no proof to dispute with.
Decision D2 (coordinator, contracts-decisions.md "R-IMPLICIT-BASELINE"; contract PR 76; Review A and Review B): from
ondelta epoch 1 a dispute may start from the IMPLICIT proof: empty signature, and the body is the empty state of
the Account, every field of it known on chain: offdelta 0, no clause, floor windows, nonce = stored + 1, authored by
RIGHT, watchSeed 0, no starter arguments. It settles at Delta = ondelta. Any signed frame of the epoch outranks it through
a counter. Epoch 0 is excluded (a fresh Account's first frames are its proofs). The spec's earlier draft wrote it
with `:left`; that is superseded: at one nonce a Left-authored proof outranks a Right-authored one (A12; rank =
2 * nonce + (Left ? 1 : 0)), so the Right-authored implicit proof has the lowest rank at stored + 1 and a signed Left
proof of that nonce outranks it.
Page: `implicit-proofs` is the base of epoch > 0 (nonce chain + 1, Right-authored, offdelta 0, no clause, the floor
windows); the co-signed baselines are deleted. `two-disputes` is a plain pass (the second dispute starts from the
implicit proof and is presented). Rules the page now carries, each with a planted bug:
- **The first signed proof of an epoch takes nonce >= stored + 2** (review B finding 3, the trap). A Right-authored
  signed proof at stored + 1 only TIES the implicit proof (same rank), a tie is a refused counter, and the dispute pays
  the empty state: after a settlement (stored 5) Right signs the first frame at 6 with offdelta +40, opens the implicit
  dispute at 6, Left's counter is skipped and at the timeout Delta = ondelta, so Left's 40 is lost. `post-nonce` is
  chain + 2; planted bug `post-nonce-low` (chain + 1) is caught by "in the new epoch a dispute pays the newest committed
  frame, never the implicit proof that ties it". `stored` is the value READ FROM THE CHAIN, never derived: a timeout
  finalize leaves stored = initial + 1, a counter or signed branch leaves the proof's own nonce (R-IMPLICIT-NONCE-FROM-CHAIN,
  a Runtime rule; the page's `chain-nonce` is that value and the property "a timeout finalize consumes exactly one nonce;
  an adopted proof sets it" pins it).
- **Windows may lengthen, never shorten, inside an epoch** (N3, E9; Q-D-5). The counter and the final body carry windows
  at least the started ones; a body that shortens them is refused. Each proof carries its own windows; planted bug
  `counter-shortens-window`.
- **Floor windows are the real response guarantee.** The implicit proof names the floor (60 s on testnet, 6 h on mainnet),
  so a side that starts from it gives its counterparty only the floor window to answer with a signed frame. Honest parties
  are safe only if a Runtime lands the counter inside it: a Runtime duty to watch its own disputes within the floor
  window (watchtowers stay out of v1, D5). Accepted risk, not a contract change.
- **Deposits keep the epoch** (review B finding 2). Reserve-to-collateral does NOT advance the epoch: the epoch advances
  only on a dispute finalize, a collateral-to-reserve withdrawal (co-signed) and a settlement. A deposit inside an epoch
  keeps every signed frame valid, and an implicit dispute started afterwards settles at the NEW ondelta (a Left deposit
  raises it by one). Page: the deposit rule is open inside an epoch after an advance (as well as during a dispute), the
  step property "a deposit does not advance the epoch" and the property "a dispute from the implicit proof settles at the
  chain's ondelta now"; planted bugs `deposit-advances-epoch` and `implicit-stale-ondelta`.
- The implicit proof must carry a nonce above the stored one (planted bug `implicit-nonce-stale`, caught by "after an epoch
  advance each side still holds a valid proof of the new epoch").
Not modelled: the starter naming the tokens (one token), the seven contract reasons for refusing a non-canonical implicit
proof (the page only builds the canonical one). A withdrawal (collateral-to-reserve) as an advance is modelled since
review round 3: Q-D-26 (R-C2R-FOLD). The Right author is pinned at contract level only (review round 3, m2: authored by Left
the model's runs are identical, because the Runtime rule never signs at stored + 1, which is the only place the author
shows).
Source: review of PR #41 round 2 (item 6); coordinator N1; decision D2; Review A and B of PR 76.

**Q-D-22. H3: retired-board evidence is capped at collateral, in one direction only (coordinator H3, modelled).**
The page has a rotating side (`rotating-side`, `rotations`, `rotation-at`): its board rotates once at an
off-chain height, and every proof it signed up to then is retired-grade evidence (the implicit proof is unsigned,
so never retired-grade; a proof after the rotation is current). The proof that settles carries the grade, whoever starts
(a counter replaces it). Finalization clamps only what the retired side would pay from reserves: retired Left
settles at Delta >= 0, retired Right at Delta <= collateral. What the retired side is owed is never clamped.
Properties, written from the decision text and not through the clamp: "retired-board evidence never draws on the
retired side's reserve" and "what the retired side is owed is paid as signed, whoever starts". Bounds:
`dispute/configs/retired-left.scm`, `retired-right.scm` (8340 states each; the board rotates after frame 4, so
frame 4 (Delta -1) and frame 3 (Delta 3 over a collateral of 2) are retired). Planted bugs: `h3-no-clamp` (the
contracts before H3) and `h3-symmetric` (the first, symmetric clamp of PR #42: a debtor erases what it owes a
rotating entity). Not modelled: the seven-day grace window itself, the grade upgrade by re-registering the same
body (self-inflicted and harmless), and re-signing every Account after a rotation (Option C, v2).
Source: coordinator H3 (contracts-decisions.md, "Done: H3").

**Q-D-23. Composition of the money pages (round 2).**
The ledger page and the dispute page used to be two models of one arithmetic joined by the script. They now share
`money/core.scm`: `ledger-pay` (a payment moves Delta against its payer), `ledger-rcpan-ok?` (the worst-case credit
bound) and `ledger-deposit-ondelta` (a Left deposit raises ondelta, a Right one does not). The dispute page's
frames are built from them and two step properties check what each frame and deposit DID against the ledger
page's formulas written out again ("a frame moves Delta as the ledger does"; "a deposit moves one unit ..."); the
receiver-side credit check is restated from the formula too. A wrong function in the core is killed on both pages
(`core-pay-flipped`, `core-rcpan-no-floor`). What is still a script: the frame sequence itself (the dispute page
plays five scripted txs; the frames page plays arbitrary submissions), because letting the dispute page draw its
frames from the frames page multiplies both state spaces.
Right's reserve: `dispute/configs/right-reserve.scm` gives Right a reserve of 1, so a Right-funded deposit (H4) and
a shortfall paid from Right's reserve first can occur.

**Q-D-24. The implicit-tie property (review round 3 of PR 41, m4).**
The implicit proof exists from epoch 1 on. Offered at epoch 0 (m4, planted bug `implicit-at-epoch-0`) it is the same trap
as `post-nonce-low`, one epoch earlier: Right pays Left (n1R, Right-authored, rank 2), the implicit proof at nonce 1 is
Right-authored too and ties it, Left's counter with n1R is refused as a tie, and a start from the empty state erases the
payment (trace `propose :right`, `start I1 :left`, `finalize initial :right`). Nothing noticed it: "the responder is never
worse off than the newest proof it held" compares ranks and a tie is not worse, and the `post-nonce-low` property only looks
at the frame after a settlement. The property: "a dispute that settles on the implicit proof leaves no signed proof of its
epoch at or above it". It holds on the page (the counts of the base and every config are unchanged), kills `implicit-at-epoch-0`
in three steps, and pins both "epoch >= 1" and the first signed proof at stored + 2 for every epoch and every holder.
Source: review of PR #41 round 3 (`x-implicit-tie`).

**Q-D-25. E9 against a Byzantine signer (review round 3 of PR 41, w1 and w2).**
`counter-shortens-window` died at the SIGNING guard (`windows-keep-ok?`): the first frame an honest party signed with shorter
windows broke the property, and no counter was ever involved. With only the guard dropped the bug is the same; with only E9
dropped (`windows-ok?`) the run was identical to the clean one: no honest proof ever has shorter windows than the proof it
counters, so the chain's check never fired, and E9 (Account.sol: windows may lengthen, never shorten) was dead code in the model.
The page now has a Byzantine signer: `byz-window` (bound `max-byz-windows`, 0 in the base, 1 in the config `byz-window`) lets
Right sign a proof ALONE, with the floor windows, on top of the newest committed state, and hand it to Left. Nobody co-signed
it, so no signing guard ever saw it; Left holds a proof signed by its counterparty, which is all the chain asks. The two
conjuncts of the old property are now two properties: the signing guard's one ranges over the CO-SIGNED proofs (the lone
signature is recorded in `:alone`), and "a counter or final body carries at least the started windows: the chain's E9 check,
whoever signed it" ranges over the dispute results. `counterable?` (the proof is usable and E9 lets it counter) replaces the
rank of the best proof held when the page asks whether the responder must act, or what it could have answered with: a
responder holding a proof E9 refuses is not a responder that has to answer, so the clock is not held for it. Config
`byz-window` (two Right frames, the second on windows one longer than the floor, clock 4, no rival, no settlement): 7812
states, 11503 transitions, 4818 goals, clean. Planted bug `e9-dropped` (E9 removed on the chain side only, loaded after
`byz-window`) goes red on the E9 property: Right starts from the long-window frame and Left closes at once on the lone
floor-window proof (`finalize with n3R`). Both `counter-shortens-window` (signing guard) and `e9-dropped` (chain) are kept.
Source: review of PR #41 round 3 (`w1-e9-dropped`, `w2-sign-guard-dropped`, section 2).

**Q-D-26. R-C2R-FOLD: a collateral-to-reserve withdrawal does not fold offdelta (decided; review round 3 of PR 41, item 4).**
In Account.sol `processC2R` the signed diff of a withdrawal is only the withdrawn amount (`ondeltaDiff = isLeft ? -amount : 0`),
the nonce is the C2R's own and the epoch advances (`_advanceOndeltaEpoch`). Nothing folds the off-chain offdelta: after the
advance the epoch's offdelta is gone and a dispute from the implicit proof settles at Δ = ondelta. A settlement carries an
`ondeltaDiff` that can fold offdelta (the page's `settle` does); the C2R shortcut cannot. C2R is co-signed, so the approver is
the only guard (the shape of R-SETTLE-CREDIT, Q-X-3). The rule (coordinator): **a C2R is co-signed only while offdelta is zero;
otherwise the withdrawal goes as a settlement that folds offdelta into ondelta.** Page: the rule `withdraw` (Left withdraws one
unit of collateral to its reserve at a quiescent height with no open clause and no dispute; bound `max-withdrawals`, 0 in the
base, 1 in the config `withdraw`), whose ondelta update goes through `withdraw-fold` (the folded offdelta: a plain C2R when it is
zero, a settlement otherwise), and the property "R-C2R-FOLD: a withdrawal lowers Left's position by exactly the amount withdrawn
and moves nothing else: Δ after = Δ before - 1, money unchanged". Config `withdraw`: 5460 states, 10033 transitions, 2528
goals, clean. Planted bug `c2r-unfolded` (the shortcut co-signed with a nonzero offdelta, nothing folded) goes red on that
property in three steps: Right's payment to Left is erased (`propose :right`, `ack :right`, `withdraw :left`). Not modelled:
the stale co-signed op that lands after more frames (review item 4.2, a question for the Runtime owner), a C2R during a dispute
(E6 on chain: `disputeHash != 0` reverts; the page forbids it too), more than one withdrawal.
Source: review of PR #41 round 3 (`x-c2r-advance`, `x-c2r-advance-folded`); Account.sol processC2R.

## Entity consensus (`entity/consensus.scm`)

**Q-E-1. An own uncommitted proposal meets a different certified frame (R-E3, lessons B-E1).**
Options: (a) refuse it and keep the proposal (xln.ts today, `commit_conflict`, pure/xln.ts:28705);
(b) drop the proposal, install the certified frame, keep the txs in the mempool (R-E3).
Choice: (b). With (a) the replica is stranded at the old height while the others move on: the planted
bug `commit-conflict` fails "can always still finish" in the trace propose A, timeout B, propose B.
Half of (b), dropping the proposal but forgetting its txs, loses them (`drop-txs-on-conflict`).
"Its txs ride in a later frame" is now CHECKED: the page runs two heights with the goal "every
submitted tx is committed everywhere" (before, one height could only show the tx stayed in a
mempool). That check needed the two rules of Q-E-6 and Q-E-7.
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
see j/batch.scm), handover, the four-phase frame pipeline (entity/frame.scm), the view-change
certificate and `notSuperseded` (leader votes; Q-E-2, Q-E-8). The `locked` phase is modelled at quorum 3 of 3
(Q-E-8). Bounds: two heights, one tx each for A and B, one view change. Capacity:
9330 states, 37603 transitions, 3072 goals (the log of signatures and the signature sets are part of the state).

**Q-E-8. The locked phase, quorum 3 of 3 (round 2): safety holds, liveness does not (finding).**
Under quorum 2 the second signer always commits, so xln.ts's `locked` phase (28773) never shows. With `quorum` 3
(configs `entity/configs/quorum-3.scm`, one height, three validators) it does. A validator that signs a proposal
without reaching quorum LOCKS on it, sends its precommit to every other validator and waits; a precommit waits
(parked) until the replica holds the same frame; the frame commits where three precommits are held and the
committer tells the rest. A locked replica ignores a different proposal (`resendPrecommit`: `unlikeHeld`), keeps
its lock across a view change and, in the model as in og, a proposer keeps its proposal (29137). Properties added:
"a locked replica holds its own signature on the frame it locked on", "a locked replica never meets a certified
frame other than the one it signed" (with all three signatures needed it cannot: the replica's own is one of them),
and "a frame is committed only with quorum distinct validators having signed it" (read from a log of signatures;
planted bug `early-commit` commits one short and fails it). `quorum-3-safety.scm` drops the goal: every safety
property holds.
FINDING (liveness): with the goal, "can always still finish" fails in TWO steps: propose A, timeout B. B moves to
view 1 before it has signed, so it will not sign A's view-0 proposal (it voted past that view: `notSuperseded`,
28817), A keeps and cannot drop its signed proposal, and B's own view-1 proposal cannot get A's signature.
Neither frame can collect three. Under quorum 2 this is R-E3 (a conflict resolved by one more signature); under
3 of 3 there is no spare signature. In og the view-change certificate is what should resolve it: it needs all
three votes at 3 of 3, drops a sub-quorum lock (`certifiedUnprepared`, 28979) and lets the new leader relay a
prepared frame; but `applyLeaderVote` on a `proposed` replica keeps the proposal, so the proposer still cannot sign
the new leader's frame. Not modelled here (the certificate; see Q-E-2). Recommendation (for the coordinator):
v1 testnet runs quorum 2 of 3 (or single-signer boards); a 3-of-3 board needs the certificate rule "a proposer that
records a certificate for a higher view drops its proposal and signature at that height", to be modelled with the
certificate before any 3-of-3 board is allowed. The finding is checked as a finding (the case expects the failure).
Bound: one height (the two-height quorum-3 run did not finish in 36 CPU-minutes).
Source: review of PR #41 round 2 (item 6); xln.ts 28757-28780, 28817-28839, 28975-29050, 29137.

**Q-E-6. View sync after R-E3 (found at two heights).**
The replica that dropped its proposal installs the other leader's frame but stays in the old view;
its next frame is refused by the others, who are in the new view, and nobody sends its txs to the
new leader (trace: propose A, timeout B, propose B, C signs B's frame, A installs and is stranded).
Options: (a) the certified frame carries its view and installing it moves the replica to at least
that view; (b) the replica resends to every leader it has seen. Choice: (a). Planted bug
`no-view-sync`. xln.ts: not checked whether a certified proposal moves the replica's view; ask.
Source: review of PR #41.

**Q-E-7. A proposal for a height not yet reached.**
Second wedge at two heights: B proposes height 2 while A and C have not yet installed height 1; they
consume and ignore it, B stays `proposed` and nothing resends. Options: (a) park the message until
the replica reaches that height (the `proposal_wait` of xln.ts, 28797); (b) the proposer resends on
a timer. Choice: (a), for proposals and certified frames alike. Planted bug `drop-future`. Whether
xln.ts parks or drops depends on the runtime's handling of `proposal_wait`; not traced.
Source: review of PR #41.

## Entity frame (`entity/frame.scm`)

**Q-F-1. Phases and the one view (lessons R-E1, Q-E1).**
The frame is four phases: arrivals, hooks, txs, proposals. lessons R-E1 lists three; xln.ts splits the
third (post-tx work, then Account proposals). Choice: four, and ONE view: a tx is admitted against an
Account that already holds every tx staged earlier in the frame (xln.ts `enqueueTo` 25835 does this
today, but no rule states it). Planted bug `two-views`: two payments that each fit are both admitted.
Source: lessons R-E1, Q-E1; xln.ts 26673-26746, 25835, 17273.

**Q-F-2. Arrivals are applied first, wherever they sit in the input (finding about xln.ts).**
xln.ts applies arrivals up front only to build the proposal worklist; the tx loop starts from the ORIGINAL
replicas and each accountInput tx applies at its own position (26641, 26595), so R-E1 is only partly
literal. Choice: arrivals first, always, and the property is that moving arrivals among the txs does not
change the frame. Planted bug `arrivals-in-place` breaks it.
Source: xln.ts 26595-26641, lessons R-E1.

**Q-F-3. Hooks before the frame's own txs (R-E2).**
A wake's returned Account txs are queued before the frame's own txs, so they win contested room.
Planted bug `txs-before-hooks`.
Source: lessons R-E2; xln.ts 18098, 23421.

**Q-F-4. Proposal order (R-E4).**
Accounts touched in this frame propose in first-touch order; the rest (staged earlier, waiting for an
ack) follow in ascending id (xln.ts 26717-26719). Planted bug `sorted-proposals`.
Source: lessons R-E4; xln.ts 26622, 26717.

**Q-F-5. Refusal.**
A tx that does not fit is refused with notice and the frame goes on (xln.ts `foldEvicting` 26595); the
fatal errors that refuse the whole input (openAccount, lending_entity, entity_invariant) are the Runtime
page's halt classes. The property "no tx is lost" is: every admitted tx is sent, in flight or staged.

**Q-F-6. Not in the page.**
The book phase (cancels, then matcher: v2), settlements materialised after the txs, several tokens,
holds for HTLC locks and swaps (they are clauses of money/ledger.scm), an Account with a pending frame
that receives a new frame the same height (account/frames.scm). Bounds: two Accounts, payments of 1,
cap 1, at most two frames, four inputs in any order. Capacity: 1770 states, 2228 transitions, about
30 seconds.

## J batch (`j/batch.scm`)

**Q-J-1. Partial application (open question 4 of the xln.ts review).**
The chain is atomic: every op applies or none does, and a failure emits nothing but the revert
(Depository.sol processBatch, D:329-575; no per-op result). Choice: the entity treats per-op effect
events as the truth: the event names the ops it applied and they are DONE. An op is never judged by
whether its batch "succeeded". Planted bug `partial-apply` (the chain keeps the ops before a failing
one) breaks the property "every applied op came from a batch that succeeded".
Source: D:329-575, xln.ts 2953-2972.

**Q-J-2. A quarantined batch (open question 3): gone by construction (F1).**
A batch aborted and re-sealed can land after its replacement was sealed at the same nonce; the event
carries a different hash at a nonce >= the pending one, so the pending batch can never land.
xln.ts: `quarantined`, message only; recovery is a manual abort or clear, and the hub-only stale timer
(17961) does not cover other Entities. Choice (20:14, F1): the case cannot arise. A signed batch is
final at its nonce and a replacement is always signed at a fresh nonce (Q-J-9), so two different hashes
never meet at one nonce, and the quarantine and its recovery are not needed. Planted bug `no-recovery`
is removed with them; its replacement is `resign-at-nonce` (Q-J-9).
Source: xln.ts 2953-2972, 3036, 17961.

**Q-J-3. Abort and then the batch lands (finding).**
`j_abort_sent_batch` requeues the ops. If the aborted batch lands afterwards, the requeued ops are
drafted again and the next batch applies them a second time (a deposit twice). Choice (F1): an aborted
batch is ABANDONED, not forgotten, and only its dispute ops are requeued: they are idempotent under
J2 (a second copy is skipped as already applied). A deposit is not idempotent, so it is NOT requeued;
it stays with the abandoned batch, which anyone can push. An event clears the ops it applied, whatever
batch carried them. Planted bugs: `requeue-deposit` (an aborted batch requeues a deposit too: "no op is
applied twice on chain" fails); `trust-the-draft` is removed, F1 plus J2 rule it out.
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
Round 2 (j8): the H1 boundary is checked one tick either side of the deadline, with and without a public
secret. A finalize before the deadline and AT the deadline second reverts (the payee has until the deadline,
inclusive); one tick after lands; a public secret ends the wait at any time. The base page never reveals the
secret, so the with-secret cases live in `j/configs/public-secret.scm` (`secret-reveals` 1, no abort).
Properties: "a finalize lands only after the deadline or with the secret public" and "a finalize reverts only
while the deadline is open and the secret is not public". Planted bugs `h1-at-deadline` (an off-by-one: a
finalize lands at the deadline second) and `h1-ignores-secret` (the chain waits although the secret is public).

**Q-J-6. Retry and nonce.**
`retry` resends the sent batch at its own nonce (xln.ts `j_rebroadcast`); the chain refuses any batch
whose nonce is not stored + 1, so a stale copy is harmless. The batch hash is per seal.

**Q-J-7. Not in the page.**
Reorg below finalized height (`J_HISTORY_FINALIZED_REORG` is a Runtime halt today; policy open), the
J-prefix attestation round, Hanko bytes, size and gas limits, several tokens, debt enforcement, watchers.
Bounds: three ops (deposit, finalize on an Account with an open HTLC deadline, deposit), draft cap 2,
one abort, time 0..2, deadline 1, no chain faults (`faults` 0). With one fault (the chain drops or
reverts a batch) the page exceeds the 300 s budget. Capacity (after the 01:16 rules; the signed batch
now records its clock and secret, so states are finer): 12147 states, 38298 transitions, 11.5 minutes alone; the
R-J5 bound (one payment batch fails, no abort) is a second config, `j/configs/payment-failure.scm`: 9810 states,
30151 transitions (not timed alone).

**Q-J-8. A stale or already applied dispute op is skipped, not a revert (J2, coordinator 18:57).**
Before: any op that could not apply reverted the whole batch (Depository.processBatch is atomic and
has no per-op failure). Now: a dispute op that is stale (its Account's dispute was finalized) or
already applied is SKIPPED with an event and the other ops of the batch land. The H1 wait (a
finalize whose HTLC deadline is open) is not covered by this rule: it still reverts, so N2 stands
(a finalize goes alone). The page has a dispute op `cnt-a` that goes stale once `fin-a` applied; the
event names applied and skipped ops, and the entity treats both as done. Planted bug `stale-reverts`
(the contracts today): a batch of a stale op and a deposit reverts and the deposit is held up. The
contracts have to change to match; this page is the statement of what they must do.
Addition (19:52, built in the contracts): a skipped op emits its own event,
`DisputeOpSkipped(sender, counterentity, op, reason, nonce)`, and the Runtime reads it as a J fact.
The page's batch event names the ops applied and, apart, each op skipped with its reason
(`stale`, `already-applied`); the Entity marks both done and never redrafts them. Planted bug
`ignores-skip`: the Entity does not read the skip event, the skipped op is neither done nor
requeued, and the node waits for an effect that never comes ("can always still finish" fails). Two
more skips the coordinator named are in the dispute page as guards, not as events: a start beside an
open dispute (at most one per Account: the `start` rule is off while a dispute is open, and the node
counters the open one) and a counter after the window closed (the counter must land before T, see
Q-D-17). The Runtime page treats every J fact, this one included, as a good input; a Runtime input
kind for the skip fact is not modelled.
Source: coordinator J2 and its addition; contracts D:329-575.

**Q-J-9. A signed batch is final at its nonce (R-NONCE, widened by the coordinator at 20:14, F1): modelled.**
Rule: `processBatch` is permissionless and a signed batch never expires, so anyone can land an
abandoned batch later; with J2 an abandoned batch whose ops are all stale lands as a no-op and still
takes its entity nonce. The Entity therefore never signs different content at a nonce it already
signed, and always sends a replacement at a fresh nonce (above every nonce it ever signed).
In the page: `:signed-max`, `:signed` (nonce and hash of every signature), `fresh-nonce`, `:abandoned`,
and `push` (anyone lands an abandoned batch; the chain then accepts the next nonce). The chain still
needs nonce + 1, so a replacement lands after the abandoned batches below it. A hole is not possible
because the Entity only signs fresh nonces above everything it signed, and abandoned ones are pushed
first. Properties: "a signed batch is final at its nonce: no nonce is signed twice"; the lost-op
property counts abandoned batches' ops as held. Planted bug `resign-at-nonce` (the replacement reuses
the abandoned nonce) fails the first.
Finding: requeueing a deposit after an abort is unsafe under F1 (the abandoned batch can still land), so
only dispute ops are requeued (Q-J-3). Open for the contracts: nothing beyond J2's skip; a nonce
gap (accept any nonce above the current one) would make a replacement independent of pushing the
abandoned batch and is worth deciding.

**Q-J-10. A failed payment batch takes its nonce and says so (R-J5, coordinator 20:29) and dispute ops are split off (R-SPLIT, 21:01): modelled.**
Rule R-J5: an authenticated batch with NO dispute ops whose payment, settlement or reserve ops fail
applies none of them, still consumes its entity nonce and emits `BatchFailed(entity, nonce, reason)`.
The Runtime reads it as a J fact; the Entity re-queues the batch's work at a fresh nonce. Bad
authentication still reverts and takes no nonce (not modelled: the Entity signs everything it sends).
Rule R-SPLIT: dispute, reveal and hash-ladder ops never share a batch with payment, settlement or
reserve ops. A batch WITH dispute ops that fails (the H1 deadline wait is that case) reverts whole and
takes no nonce, so a mixed batch would re-open the stall: with R-NONCE a signed batch is final at its
nonce, and one that reverted without taking it would block every batch signed above it.
In the page: `fail-batch` (a payment batch: nonce advances and `BatchFailed` is queued; a dispute batch:
recorded, plain revert), `observe-failure` (the sent or an abandoned batch is dead; its ops go back to
the draft, deposits included, since a dead nonce can never land), `pick-ops` (a finalize alone, else
dispute ops together, else payment ops). A dispute batch that reverts stays signed and is retried at its
nonce once the deadline passed. Properties: "a failed batch takes its nonce" (payment batches);
"dispute ops never share a batch with payment ops (R-SPLIT)", checked on every signature; liveness covers
the re-queue. Planted bugs: `failure-no-nonce` (revert, no nonce, no event), `ignores-batch-failed`
(the Entity never re-queues; "can always still finish" fails), `mixed-batch` (R-SPLIT broken);
`bundle-finalize` (N2) now bundles a finalize with a counter, both dispute ops.
Refinement (coordinator relay, 22:31, from the #54 review), modelled with ops `x1` (a deposit leg,
externalTokenToReserve) and `stl-a` (a settlement whose counterparty signature is over account epoch 0):
(1) a batch that carries a deposit leg reverts whole and takes no nonce, like a dispute batch; it never
soft-fails, so a relayer that makes the token pull fail cannot burn the Entity's nonce. (2) A bad
counterparty signature inside a batch (a settlement or C2R signed at an old account epoch) is a soft fail:
`BatchFailed` with reason `signature`, the bad ops named, nonce consumed. Only a failure of the batch's
own hanko authorisation reverts without taking the nonce. The class is "hard" (dispute ops, deposit legs)
versus "soft" (payment, settlement, reserve); R-SPLIT is now about the two classes.
What the Entity does with a bad-signature op (my choice, open): the op is RETURNED to its Account with
notice instead of re-drafted, because a resend of the same signature fails again; the batch's other ops
go back to the draft. A fresh signature is the Account's business (a new settlement at the new epoch).
Properties: "a failed batch of payment, settlement and reserve ops takes its nonce", "a failed batch with a
deposit leg or a dispute op reverts whole and takes no nonce", "deposit legs and dispute ops never share
a batch with payment or settlement ops". Bounded run `j/configs/legs-and-signatures.scm` (a deposit leg, a
reserve deposit, a settlement, one fault, the counterparty moves the epoch once); planted bugs `leg-soft`
(a deposit-leg batch takes its nonce) and `bad-sig-hard` (a bad signature reverts without the nonce, what
the contracts do today). Not modelled: a Runtime input kind for `BatchFailed` (the Runtime page treats every J fact as a good
input); a reason code per failing op (the page has two: `reserve`, `signature`); reveal ops.
Source: coordinator R-J5, R-SPLIT.

**Q-J-11. Three more J rules (coordinator, 23:42, from the second #54 review): modelled.**
(1) J2 extended: any dispute, reveal or ladder op whose precondition can never hold again is skipped with
`DisputeOpSkipped` and the batch consumes its nonce. The page now also skips a finalize after a counter landed
(the finalize was prepared for the initial proof; the counter path needs another op). A TRANSIENT failure (the H1
deadline wait) still reverts whole, without the nonce.
(2) R-COSIGN: a batch that carries a co-signed op (a settlement or C2R, `stl-a`) carries only ops of that one
Account, because a counterparty's state change or a relayer's gas choice can fail it. `pick-ops` sends the
co-signed op with the ops of its own Account only; the property "a batch with a co-signed op carries ops of that
one Account only" reads every signed batch. Planted bug `cosign-bundle` (a settlement bundled with another
Account's reserve deposit).
(3) Gas (signed budget, coordinator 01:16): the batch carries a signed gas budget. A call that gets less gas than
the budget is a plain revert: no nonce, no `BatchFailed`, whatever the batch carries. An ERC-1271 member gets a
fixed gas stipend and the tx hard-reverts if it cannot be given. Once the budget is given, every failure of a
soft batch is `BatchFailed` with the nonce spent. Property "gas below the signed budget is a plain revert: no
nonce, no BatchFailed, whatever the batch carries"; the "failed payment batch takes its nonce" property and
the H1 revert property skip gas reverts. Planted bug `gas-soft` (a gas revert takes the nonce). Bound:
`j/configs/gas-starvation.scm` (one gas revert, a settlement whose signature can go bad).
Question for the coordinator: does "every failure is BatchFailed once the budget is given" also cover a HARD batch
(dispute ops, deposit legs)? The page keeps the earlier rule: a hard batch reverts whole, without the nonce.
(4) A dispute start carries the Account epoch it was signed for (01:16, `ondeltaEpoch`). At another epoch it is
skipped with `DisputeOpSkipped` and the nonce is consumed (J2 extended: the precondition can never hold again).
Property "a dispute start lands only at the account epoch it was signed for; on a mismatch it is skipped".
Planted bug `start-ignores-epoch`. Bound: `j/configs/epoch-start.scm` (an epoch move can land between the
signing and the batch); 646 states. Also `j/configs/start-then-finalize.scm` (a start and a finalize in one
batch, so a batch can fail half way); planted bug `partial-apply` uses it.
(5) Runtime rules the page checks on the Entity's side of the batch (01:16): simulate before signing (a batch
the chain would refuse is not signed), never sign a time-gated op early (a finalize is signed only after its gate
opened), and split above the gas cap (`draft-cap`). Config `j/configs/simulate-first.scm` (317 states); planted
bug `signs-before-gate`: property "a finalize is signed only after its gate opened when the Entity simulates
first (Runtime rule)". Not checked: the estimator itself (a simulation on a stale head can still fail; that
failure is the soft path above).
CLOSED 10-01 (coordinator): the question whether "every failure is BatchFailed once the gas budget is given" covers hard batches is
answered by the deployed contract and the page matches it: a dispute or deposit batch reverts whole on out-of-gas
and keeps its nonce (the contract does the same for a reveal and a hash-ladder batch; the page has no such batch op); only a money-only batch has the soft path (Q-J-14 (1)). Evidence: the contract tests under register row F16
(`test_gasSweep_erc20Deposit_depthTwo`, `test_F16_gasSweep_erc721Deposit_depthThree`, `F16 V revert-whole batches ignore the
budget but keep the minimum`) and the Arrival bugs `gas-soft`, `starved-silent`, `hard-starved-event`, `starved-at-floor`.
Source: coordinator 23:42.

**Q-J-12. A deposit leg travels alone (J6, coordinator 00:49): modelled.**
`pick-ops` puts one deposit leg (`x1`, `x2`, one per token) in a batch of its own, and the Runtime signs a deposit
batch only after it simulated it successfully. A token paused between the simulation and the landing makes the
batch revert (a hard revert, no nonce: Q-J-10), and the entity's nonce stalls until the batch lands; that residual
risk is ACCEPTED by the coordinator. The page's fault on a deposit batch is exactly this case and the batch is
retried at its nonce. Property "a deposit leg travels alone in its batch (J6)"; bound `j/configs/two-legs.scm`
(two legs, one fault, 327 states); planted bug `legs-bundled` (two legs in one batch: a paused token reverts the
other token's deposit too). Not modelled: the simulation itself (a batch the Runtime never signs).
Source: coordinator J6 (00:49).

## Runtime (`runtime/tick.scm`)

**Q-J-13. Deposits, funded payments and debt enforcement (coordinator, 09-30 13:50): modelled.**
(1) A deposit leg that cannot be signed is skipped. The token of a deposit can be paused (`pauses` times); a deposit leg
against a paused token hard-reverts. The Entity simulates at the head, so it does not sign that deposit: the leg waits in
the draft. Of the payments (r2c ops) only those the CURRENT spendable reserve already covers go out, in order; the rest
wait with the deposit. Why: an unfunded payment soft-fails (R-J5) and burns a nonce, and the Entity would do it again
every round. Properties: "a deposit whose token is paused is not signed: it is skipped and waits with the payments it
funds" and (the payment half) the one named after the debt rule below. Planted bugs `signs-paused-deposit` (the deposit
is signed anyway; it reverts and stalls the nonce) and `unfunded-payments` (every payment is signed whatever the
reserve). Bound: `j/configs/paused-deposit.scm` (reserve 0, deposit then payment, one pause); 983 states.
(2) Debt enforcement. The J page keeps an entity's debts as a queue; a reserve credit (a deposit leg) and the
permissionless `enforceDebts` call pay them first in, first out, at most `enforce-cap` debts cleared per call (32 in the
contract; the bounds use 1). Properties: "debts are cleared oldest first", "one enforcement call visits at most the cap of
claims", "a debt leaves the queue only when paid" and "the reserve is conserved". The property the coordinator named is
"the spendable reserve nets all outstanding debt": the reserve a payment may spend is the reserve minus EVERY outstanding
debt, the ones beyond the cap included, so a payment is signed only against that net and none spends owed money. The chain
applies a reserve op only against the net reserve; an Entity that counts the raw reserve signs a payment that fails and
burns its nonce. Planted bugs `spends-owed-reserve`, `debts-lifo`, `debts-uncapped`, `debts-cleared-unpaid`. Bounds:
`j/configs/debts.scm` (two debts of 1, cap 1, a deposit of 2: one debt stays owed behind a reserve of 1, so the payment
waits; 117 states) and `j/configs/debts-funded.scm` (a deposit of 3: the net reserve is 1, so the payment lands whether or
not the second enforcement call ran first; 317 states).
Open for the coordinator: (a) the page pays a debt in full or leaves a partial payment at the head of the queue (the
contract's partial-payment rule is not written down here); (b) which call enforces debts besides the deposit credit
(here any caller, any time); (c) the DISPUTE page books at most one debt per side at a finalize and never enforces
it, and its R2C during a dispute checks the raw reserve. The queue and its cap live in the J page only, because a dispute
finalize is the only place a debt is created and the payout ledger keeps one number per side. Not modelled: gas of
the enforcement call, debts in several tokens, forgiving a debt (Q-X-4).
Source: coordinator 09-30 13:50.
(3) R-FUNDED and R2C-DEBT-FIRST (coordinator, 09-30 15:23, decided from the Quint review; pinned against contracts/ at
f996ff5). R-FUNDED generalizes (1): the planner signs a reserve payment only if the spendable reserve covers it at signing,
in every situation, not only behind a paused deposit; oldest first, skipping one that does not fit (a payment now has a cost:
`r1` costs 1, `r2` costs 2). Property "no signed batch carries an unfunded payment: each payment fits the spendable reserve,
which nets all outstanding debt (R-FUNDED)" (the sentence the coordinator asked for: the spendable reserve nets all outstanding
debt). Bounds: `j/configs/unfunded-alone.scm` (no deposit in play: nothing may be signed; 6 states) and
`j/configs/funded-order.scm` (reserve 1, r2 does not fit, r1 does: r1 goes out, r2 waits; 39 states). Planted bugs
`unfunded-payments` (killed in both `paused-deposit` and `unfunded-alone`) and `funding-blocks-behind-misfit` (stops at the
first misfit: r1 waits for ever, "can always still finish"). Witness: `funded-order-witness.scm` adds an invariant that the
skipping case never happens; the check must fail on it, so the case is reachable and the property is not vacuous.
R2C-DEBT-FIRST: a reserve-to-collateral op enforces the outstanding debt BEFORE the reserve is used, in as many internal calls
as it takes (each visits at most the cap, `enforce-cap`; 32 in the contract). Property "after a reserve-to-collateral op, the
debt queue is empty or the spendable reserve is zero". Bound `j/configs/r2c-debt-first.scm` (reserve 4, two debts of 1, cap 1:
the payment enforces in two internal calls, then spends; 108 states) with witness `r2c-debt-first-witness.scm` (a payment that
enforces in two internal calls). Planted bug `r2c-skips-enforcement`. Part-paid claim: it stays at the head of the queue,
reduced in place, and the cursor does not advance; property "a part-paid claim stays at the head of the queue, reduced in
place", bound `j/configs/debts-partial.scm` (debts 2 and 1, a deposit of 1: the oldest is part-paid; 36 states), witness
`debts-partial-witness.scm`, planted bug `partial-moves-back` (re-queued at the back). The cap property now counts claims
VISITED, cleared or part-paid, per internal call. The spendable reserve nets the WHOLE outstanding debt (as asked).
Not modelled: the exact visit order inside an internal call beyond FIFO with the head kept, a payment whose cost is not a whole
unit, and what the chain does with a reserve op that arrives with less than its cost (it fails soft, R-J5).
Source: coordinator 09-30 15:23.
DECIDED 10-01 (coordinator, following the deployed contracts), the three open items above: (a) closed: the contract pays a part-paid
claim in place at the head (`Account.enforceDebts`), as the page does. (b) the calls that enforce debts are listed in register row
R2C-DEBT-FIRST: the permissionless `enforceDebts`, and inside a batch a reserve-to-external-token transfer, a reserve-to-reserve
transfer, a reserve-to-collateral deposit, a settlement outflow and a dispute payout; the Arrival pages hold the deposit and the
dispute payout. (c) accepted as a gap and closed: the dispute payout (the dispute page, where the payout is; the J page has no
payout) enforces the debtor's older debts first, from its reserve, then pays the peer out of the SPENDABLE reserve (reserve less
what is still owed), then books the rest as debt (`Depository._settleShortfall`). `older-left0` and `older-right0` give a side
older debts to third parties; the shortfall records what the peer got; properties "a shortfall pays the peer no more than the
debtor's spendable reserve" and "a shortfall enforces the debtor's older debts first" (both R2C-DEBT-FIRST); money is conserved
counting what enforcement paid third parties. Bound `dispute/configs/older-debt.scm` with witness `older-debt-witness.scm`;
planted bugs `shortfall-ahead-of-debt` (the raw reserve) and `shortfall-skips-enforcement`. The J page's R2C already checks the
spendable reserve (`spends-owed-reserve` is its bug).

**Q-J-14. Gas by batch kind and settlement debt forgiveness (coordinator, 09-30 16:12, pinned against the contracts in #54): modelled.**
(1) Gas failure is split by batch kind. A money-only batch (payments, settlements, no deposit leg) takes the soft path: given
less gas than `budget*64/63 + 30,000` it emits `BatchGasStarved`, the transaction succeeds, NO nonce is spent, the signed
batch can be sent again. From the floor up any failure is `BatchFailed` and consumes the nonce. A batch that carries a
dispute (start, counter, finalize) or deposit op runs in processBatch's own frame (reveal and hash-ladder batches: contract only): out of gas reverts the whole transaction, nothing
is emitted, the nonce stays unspent. Rules `gas-nth` (level 0: one below the floor; level 1: the floor itself, which runs).
Properties: "gas below the floor spends no nonce, whatever the batch carries", "a money-only batch starved of gas emits
BatchGasStarved; a batch with a dispute or deposit op reverts whole and emits nothing" and "a batch given at
least the floor is never gas-starved". The Entity reads BatchGasStarved as a J fact: the batch did not run, so it stays sent
and is resent at its own nonce. Planted bugs `gas-soft` (a gas revert takes the nonce), `starved-silent`,
`hard-starved-event`, `starved-at-floor`. Bound `j/configs/gas-kinds.scm` (a deposit and a payment, two gas events;
2365 states) with a witness. This replaces the 01:16 wording "a gas revert is plain, whatever the batch carries" for money-only
batches: the nonce is still unspent, but the chain now says so. It answers the Q-J-11 question about hard batches (they revert
whole and keep the nonce).
(2) Settlement debt forgiveness, as the deployed contract reads it (10-01, coordinator: follow the contract; `Depository.sol`
`_forgiveDebtsBetweenEntities` and the settlement loop, `Account.sol` `MAX_SETTLEMENT_FORGIVENESS_IDS`). A settlement (`stl-a`)
lists TOKEN ids (`forgive`). For each listed token it looks at the current head debt of each side toward the other, the entity's
debt to the counterparty (`:debts`) and the counterparty's debt to the entity (`:cp-debts`): a head owed to the other side of the
Account is deleted (the amount is deleted and the debtor's outstanding debt reduced; nobody is credited; a part-paid head is
forgiven for what is left), a head owed to a third party is left. The whole settlement reverts (E2, a soft failure: BatchFailed,
reason "forgiveness", the settlement goes back to its Account) only when NOTHING was forgiven for a listed token and a debt
exists there; so one direction blocked by a third party and the other forgiven still lands. More than `forgive-cap` ids revert it
(E10, 32 in the contract) and so does a token listed twice (E2). One token (`debt-token`) carries debts; a listed token without
debts changes nothing. Properties: "a settlement deletes only the head claim of a listed token's queue, and only when it is owed to
the other side of the Account", "a settlement that lists a token forgives each side's head claim that is owed to the other side of
the Account", "a settlement that lists a token with debts and forgives nothing never lands", "a settlement that lands lists at most
the cap of token ids and none twice" and "a settlement reverts on forgiveness only for a list over the cap, a repeated token, or a
listed token whose heads cannot be forgiven"; all restated from queue snapshots, not through `forgive-plan`. Planted bugs
`forgives-third-party`, `forgives-one-direction`, `forgives-past-head`, `forgive-blocked-lands`, `reverts-on-either-block`,
`forgive-uncapped`, `forgive-repeat-ok`. Bounds and witnesses: `j/configs/forgive-head.scm` (+ witness), `forgive-both.scm`,
`forgive-one-blocked.scm` (+ witness), `forgive-third-head.scm` (+ witness), `forgive-cap.scm`, `forgive-repeat.scm`,
`forgive-past-head.scm`. The first version of this page (09-30) took claim ids and one queue; the contract differs in four places
(token ids, both directions, revert only when nothing was forgiven, E10 and E2), and the coordinator ruled that the contract wins.
Not modelled: gas amounts beyond the floor, the size of the debt queue beyond the bound, debts in more than one token (so the per-token revert across two listed tokens, one forgiven and one blocked, is not modelled: with one debt-bearing token a revert on "nothing forgiven across the list" looks the same).
Source: coordinator 09-30 16:12.

**Q-R-1. When does an output leave (lessons R-X2 area, AGENTS.md).**
Choice: only after the frame's WAL row is committed (xln.ts `commitRuntimeFrame` 42045, outputs leave
after the row). A crash between apply and commit must not leave a peer with an output of a frame
that no longer exists. Planted bug `send-before-commit`.

**Q-R-2. Which errors halt (R-X1, open question 11).**
xln.ts halts on `entity_invariant` or `accountThrew` (`haltsRuntime` 40293), but many `invariant(...)`
sites are peer-reachable (J-range `j_event` rejections, `runtimeOutputTx` authority errors, fatal
openAccount, `lending_entity`, SETTLEMENT_* checks), so a peer can halt a Runtime. Choice: halt only on
local corruption; every peer-reachable failure is rejected in place with a rejection to the peer.
The closed list of halting errors (lessons Q-R1) does not exist in xln.ts; the spec's rule is a
property, not a list. Planted bug `bad-halts`.
Source: lessons R-X1, Q-R1; xln.ts 40293, 40449, 20933.

**Q-R-3. Recovery is replay, with the row's own clock.**
`recoverRuntime` (42158) replays each row with `replay: true` at the row's timestamp and checks the
frame hash and the outbox. Choice: the recovered state must equal the committed state, and outputs of
committed rows that never left are sent again (peers deduplicate: the Account page re-acks a duplicate).
Planted bug `replay-wall-clock`.

**Q-R-4. The frame timestamp.**
max(runtime timestamp, input timestamp) (`frameTimestamp` 40777); never back. Planted bug
`raw-input-timestamp`. Which clock judges timeouts (lessons R-X2, open question 15) is not decided
here: disputes use chain time, HTLC expiry uses the Account frame time plus the J height (see
entity/routing.scm).

**Q-R-5. An input the crash caught before its commit.**
It comes back from the network (peers resend; Account page). Planted bug `drop-uncommitted-input`.

**Q-R-7. A frame is persisted before any of its outputs leave (R-DURABLE, coordinator 18:57).**
A crash between send and persist would equivocate: the peer holds an output of a frame that the
recovered Runtime no longer has, and may build a different one. Adopted; the page already states it
as "outputs leave only after their WAL row is committed" (planted bug `send-before-commit`). What it
does not check is equivocation itself: the abstract output is a function of the input, so a
re-applied input reproduces the same output. Making the state and the timestamp part of the output
would make that visible. Not done.
Round 2 (t1/t2): two properties on what the peer holds. "Outputs are received in row order": the peer's copy
is always a prefix of the WAL's outputs (bug `flush-out-of-order` sends row 2 before row 1). "No committed
output is forgotten": after a recovery every output of a committed row is still owed to the peer (bug
`recover-forgets-outputs`). The goal now also requires every WAL output to be received. `:sent` is cleared at a
crash (what was in flight is lost; only the WAL is durable).

**Q-R-6. Not in the page.**
The entity-height durability barrier, atomic cross-j pairs, the bounded drain of local commands (cycle
detection), ingress limits (mempool_full, frame_timestamp_invalid), Runtime txs (`observeJRange` etc.),
several Entities. Bounds: four inputs (good, bad, good, fatal), one crash. Capacity: 162 states.

## Routing (`entity/routing.scm`)

Rules R1..R3 were decided by the coordinator (2026-09-29 18:10). The page models one hub H between a
payer A and a payee B, one lock each way. Each rule has a planted bug.

**Q-RT-1. HOP and LAG.**
LAG is the time for a chain fact to be seen and acted on; a chain fact is visible `lag` after it
lands, and H's own on-chain action is effective `lag` after H takes it. HOP = 2 x LAG. Choice: HOP is
a named policy parameter of the Entity (a rule that a peer can check at signing, like N2's deadline
tolerance), not a protocol constant. The value of LAG on a real chain (blocks, reorg depth, the
runtime's polling period) is not decided here. Planted bug `no-hop-margin`. Source: relay 18:10 R1;
lessons R-P1.

**Q-RT-2. Fail-back wait (R2).**
H fails the route back to A no earlier than one LAG after the onward deadline, and never while a
reveal by B is visible: the reveal may be in flight on chain. Choice: the page keeps `failback-wait`
at one LAG. Planted bug `early-failback`. Source: relay 18:10 R2.

**Q-RT-3. A dispute publishes the secrets (R3).**
A dispute H starts on the inbound Account carries every secret H knows for the payee locks of the
proof it presents (lesson from #37). Choice: the start action publishes them all; a start that leaves
one out is a spec violation. Planted bug `dispute-omits-secret`. Source: relay 18:10 R3; lessons #37.
Round 2 (B4): the loss property, "H never pays B without being paid by A: a diligent hub cannot lose", kills the
omission by itself (config `entity/configs/no-r3-property.scm` drops the R3 property and the bug still fails
it). The hub starts a dispute only when a secret it knows is visible on the outbound side, and it waits
`reveal-delay` = 2 x LAG after the start before it may treat the reveal as late (a reveal needs one LAG to
arrive), so the property is not defeated by a reveal in flight.

**Q-RT-7. MAX_LOCK_HORIZON at the hub (N2, coordinator 21:50).**
The hub refuses to forward a lock whose inbound or onward deadline is beyond `max-lock-horizon`
(`deadline_too_far`), so a hub never carries a lock that H1 could keep open for years. Page:
`horizon-ok?` in the forward guard; property "no lock is forwarded whose deadline is beyond
MAX_LOCK_HORIZON". Config `entity/configs/far-inbound.scm` (inbound deadline one beyond the horizon):
nothing is forwarded and nothing can be lost; planted bug `no-horizon` forwards it anyway. The onward
deadline is at most the inbound one minus HOP (R1), so the inbound check is the binding one.
Source: coordinator N2 (21:50).

**Q-RT-4. The diligent hub.**
A hub that does not act in the tick where it first sees the secret can always lose (the payee reveals
at the last moment and the hub misses the inbound deadline). Choice: the page ASSUMES a diligent hub
(the clock does not advance while H has that duty) and states as an invariant that a diligent hub
cannot lose. Option: model the duty as a bounded latency of its own (a second parameter). Not done:
the runtime's tick period would be that bound, and it is not in this page.

**Q-RT-5. xln.ts constants.**
xln.ts has the HTLC deltas (`HTLC_TIMELOCK_DELTA_MS` and neighbours) but nothing ties them to LAG or
to the dispute response windows. Open: a hub's onward lock must also end early enough that a dispute
on the inbound Account can still be answered (window floor H2 and window N3), which this page does
not model together with dispute/dispute.scm. Suggested reading: dIn - dOut >= HOP + the inbound
Account's response window.

**Q-RT-6. Not in the page.**
More than one hop, several locks, amounts other than 1, a fee, a reserve margin for the hub, the
payer's own fail-back, the onward Account also in dispute. Bounds: one hop, amounts 1, dIn 5, LAG 1,
time 7. Capacity: 4698 states.

## Transport (`transport/link.scm`, slice T0, decision D12)

The node-to-node link, written before the Runtime slice starts. The page names the interface and the assumptions; it picks no
product (WebSocket, relay, gossip and libp2p are all implementations of it). It does not read spec/quint/. Every planted bug is in
`transport/bugs/`, and three witnesses in `transport/configs/` show that each refusal path is reachable.

**Q-T-1. What is a message?**
Choice: one of two things, both addressed to an ENTITY, not to a socket. (a) An Account input, `AccountPeerInput` (ack, ack_frame,
dispute, board_hanko_refresh; a propose travels as the output of the proposing frame), carried as the Entity output
`{to, tx: accountInput}`. (b) An Entity input for one validator replica, `{to, signerId, input}`: proposal, precommit,
leaderTimeoutVote, jPrefixAttestations. A message is always an output of a COMMITTED Runtime frame (Q-T-7), and its body is
self-authenticating: a frame carries its Hanko, a precommit its signatures. J events are not messages: they come from the watcher, not from a peer.
Source: pure/xln.ts `EntityOutput` (11967), `EntityInput` (11975), `AccountPeerInput` (9617), `RoutedEntityInput` (29188).

**Q-T-2. The assumed channel.**
Choice: the weakest channel there is. It may lose a message, deliver it any number of times, deliver in any order, delay without
bound, misroute, and carry messages a stranger wrote. The page has no budget of losses or duplicates: a delivery leaves the
message on the link, so it can be delivered again, and a drop is a separate move. This replaces the FIFO link with bounded loss of the
Account page (Q-A-6) as the stated assumption; the Account page stays correct under the weaker one because a frame from the future
is refused (its `prev` hash). Evidence: the Account page with a link that may deliver any of the first three queued messages, `account/configs/reorder.scm` (Q-A-6), checks clean
(7,312 states, 33,183 transitions, 16 goals; the base page has 3,651 states).
Entity consensus already keeps its network as a set. The page's own coverage of "liveness": "can always still finish" means no reachable dead end,
not progress under fairness; under unbounded loss that is the most one can say.
Source: lessons R-X1; design/account-model.md P4; og core/network/p2p/ws-protocol.ts header ("best-effort", "dumb pipe").

**Q-T-3. No receipts and no rejections at the transport.**
Choice: none. The transport refuses silently (Q-A-1); the no-silent-refusal rule belongs to the Account and J layers, not here. The only receipt is the Account ack, which is a consensus message, never
a transport one. A second acknowledgement layer would hold a second liveness state that can disagree with the first (og says the
same in `ws-protocol.ts`: "Do not add entity-input delivery receipts or rejections here"). Cost: a sender whose message is refused
keeps resending; the resend policy (backoff, a cap per peer) is the Host's, not the protocol's. Planted bug `assume-delivered`: a
sender that counts a frame as held once it left never resends a lost one and believes more than the peer applied.

**Q-T-4. Addressing, and how a node finds a peer.**
Choice: a message is addressed to an EntityId, and for the validator lane to a (EntityId, signerId). A node turns that into a network
address with a directory. The directory is a HINT, never an authority: a stale entry costs the sender resends and nothing else, because a node
that receives a message for an entity it does not host refuses it (refusal `misrouted`, planted bug `misrouted-halts`), and the sender
re-resolves when no ack comes (rule `refresh`; planted bug `no-refresh` leaves the stale entry for good and nothing ever arrives). An Account
message goes to the peer Entity's current leader, so a view change makes the entry stale too.
**Q-T-4 CLOSED (coordinator, 09-30 18:41): how a node FIRST learns a peer.** v1 uses a static peer table in the node's configuration (entity
id, runtime id, endpoint), shipped with the deployment manifest. A signed profile published to a registry or relay (og gossip) and an address kept
on chain with the entity registration are v2 items, because they add a trust question (who may publish a profile for an entity). The page holds under
any of the three.
Source: pure/xln.ts 11966 ("an Account message for a peer entity's leader"); og core/network/p2p/gossip, core/runtime/delivery.

**Q-T-5. Authentication of a sender.**
Choice: two layers, only the second carries safety. (1) The LINK authenticates its peer: a Runtime key (a runtime id is an address) proves who is
speaking, so a refusal is charged to someone and a reply goes to the authenticated source, never to an address written in the body. (og:
hello auth with a single-use challenge, a session MAC after it.) (2) The CONTENT authenticates itself: Hanko and signatures are verified by the
Runtime's input handler against the entity boards it already knows. A forged sender field on genuine content is a duplicate and harmless; a forged body
fails (2). The page abstracts both to one flag (`ok` or `forged`) on each message and checks that a message that fails it is refused and changes nothing:
planted bugs `trust-frame-sender` (a stranger's frame is applied) and `trust-ack-sender` (a stranger's ack moves the sender's belief).
Requirement on the Host, not on the page: layer (1) must exist (spam, charging), and a replayed link frame must be harmless (it is, by Q-T-6).

**Q-T-6. What a receiver does with a refused or a duplicate message (R-X1).**
Choice: take the next frame and ack it once its row is committed (Q-T-7); answer a duplicate with the ack of the head (Q-A-2; planted bug `no-reack`); refuse a frame from the future
(Q-A-1; planted bug `halt-on-future` is the pattern of og's peer-reachable halts, whose real triggers are content races, see review/og-issues-halts-2026-09-28.md); refuse what fails the sender check (`forged-halts`); refuse what is addressed to another
entity (`misrouted-halts`). A message that does not decode, or breaks a size or count cap, is refused before the Runtime sees it. NO peer message
halts a node; only a local invariant does. On the page a halted node takes no further step, so each halt bug is a dead end that liveness sees even with the
flag property removed (`transport/configs/no-halt-property.scm`). Planted bugs `apply-duplicate` (an exactly-once assumption) and `apply-future` (an ordering
assumption) are the two promises the link must not be trusted for.

**Q-T-7. Persistence before send (R-DURABLE) is the boundary with the Runtime, on both sides.**
Choice: the Host sends only the outputs of a committed WAL row, and after a crash it sends again the outputs of every committed row whose receipt it
does not hold (Runtime page Q-R-7, `recover-forgets-outputs`). This page makes the equivocation visible, which the Runtime page could not: the body of
a frame carries the sender's crash count, so a frame built again after a crash is another frame, and the safety claim is "the receiver's frames are never
contradicted by the sender's committed frames". Planted bug `send-before-persist`: the frame leaves before its row is committed, the sender crashes and
commits another frame at that height, and the peer holds one that contradicts it. The receiver has its own rule, stated and modelled: a frame it takes is held
(`:bstaged`) and is acked only after its row is committed (rule `b persist`); a receiver crash (`b crash`) loses a held frame. Planted bug `ack-before-persist`:
the ack leaves on arrival, the receiver crashes, and the sender believes the peer holds a frame it forgot and never resends it (the belief property fails; with that
property removed liveness still fails on the stuck sender).

**Q-T-8. What the transport must NOT promise.**
Order, exactly-once delivery, a receipt, a bound on delay. Consequences for the layers above: the Runtime never waits on a delivery; an input is admitted
in the order the Host hands it over (R-CLOCK: the Host stamps it with its own clock, and a message's claimed time has no authority); an offline peer and a slow link
look the same. v1 assumes diligent online parties (D5): safety does not need timely delivery, but the liveness of a payment and the dispute path do.
**Q-T-8 CLOSED (coordinator, 09-30 18:41): when does a sender stop resending and go to the chain?** A Runtime parameter, RESEND_GIVEUP, named in the
Runtime slice (R1), not a transport property. The bound is RESEND_GIVEUP + LAG < the dispute window (rule C11). For an HTLC, rule R-HTLC-CLOCK
(contracts-decisions.md) already fixes the point: a payee whose resolve is unacked reveals on chain when its own view reaches deadline - LAG.

**Q-T-9. Flooding and refusal cost.**
**CLOSED (coordinator, 09-30 18:41):** in v1 each peer gets a bounded inbound queue and anything over the bound is dropped. The page already models loss, so
no new property is needed. A refusal costs the receiver a decode and a verification and the sender nothing; per-source budgets beyond the queue bound are v2 (Q-X-9).

**Q-T-10. Not in the page (scope note).**
**CLOSED (coordinator, 09-30 18:41; bounds accepted 09-30 20:46):** the page does not model a second Account stream and the ordering between streams (none is promised,
none is needed); several validators of one entity (one directory entry per replica); encryption, session fences and message size caps (an implementation of layer 1, and
confidentiality, which is not a protocol property); the J watcher; a relay that stores and forwards (one more stranger on the link, a channel of the kind already assumed);
the bounded inbound queue (Q-T-9, it is loss); a directory that goes stale again after a refresh (liveness would hold, refresh is always enabled). A receiver crash IS modelled (Q-T-7).
Bounds, accepted: two frames, one crash of each node, one forgery in total (so no run has a forged frame and a forged ack, two crashes of one node or a third frame). A three-frame
pipeline, where cumulative acks cross over three heights, is where exhaustive search runs out (a three-frame run did not finish in about 30 minutes); it goes to Quint later.

## Swap (`account/swap.scm`, R-SWAP-*)

A two-party swap inside one Account: offer, partial fill, withdraw, lapse, and a dispute that honours what was filled. Sources:
plan/swap-onchain.md (what the stock DeltaTransformer swap clause does), plan/contracts-decisions.md "Swap inside an Account" (the
decisions), review/swap/handoff-swap.md (the kernel, PR #111: txs `offer`, `fill`, `retract` (here `withdraw`), `lapse`) and review/pr-91/review-a.md
(the 1500-for-1000 double fill that the contract cannot see). Capacity of the base page: 2,048 states, 2,840 transitions, 1,536 goals; the
wider bound `account/configs/swap-wide.scm` 7,524 / 10,649 / 5,643.

**Q-S-1. The world.**
Choice: two tokens (`:a` owned by Left, `:b` by Right, collateral 3 each, credit 1 each way), two offer slots (Left gives 3 of `:a` for 2 of `:b`,
Right gives 2 of `:b` for 1 of `:a`), a clock of 3 J heights, one payment of 1 (to put RCPAN against the reservations) and one dispute. Offers are made at height
0 with deadline 1, so a lapse (strictly past deadline + reserve 1) needs height 3. The two offers just fit together (Left's holds on `:a` are 3 + 1 against a balance of 3
and a credit of 1); `swap-no-credit.scm` removes the credit so they exclude each other. Amounts are 2 and 3 on purpose: a ratio of 32768 takes (1, 1) of (3, 2), floors
each leg and leaves (2, 1); ratio 1 and 21845 take nothing of a leg and are refused. The checker handles the page; the state of an offer is a record in `:book`.

**Q-S-2. Two descriptions of an offer: the book and the signed clause.**
Choice: `:book` is the Account's record (status, deadline, legs filled); `:clauses` is the swap clause of the signed body (what a dispute fills, with the allowance on each leg). Every
rule moves both, and the properties read them apart. This is what makes R-SWAP-CLAUSE-WITH-FILL a statement and not a definition: the contract keeps no memory of fills, so a frame
that moves the offdeltas and keeps the old clause lets a dispute fill the same amount again (plan/swap-onchain.md section 3; contract evidence
`test_R_SWAP_ONCHAIN_aClauseLeftInAStateThatAlreadyHoldsTheFillFillsAgain`, 1500 against 1000). Planted bug `swap-fill-leaves-clause`. It is killed twice: by the world property over any
order of offers, fills, withdrawals and lapses (the clause of an offer exists exactly while it is open and never fills what the offdeltas hold), and, with that property removed
(`account/configs/swap-no-clause-property.scm`), by the dispute path alone: the settlement must equal the payments, the legs filled and the taker's fill of the remainder.

**Q-S-3. The fill.**
Choice: only the other side, a ratio 1..65535 of what REMAINS, while the offer is open and now is not past its deadline (R-SWAP-FILL "live in the judge's view": the page has one
clock; the per-party views are the clock page's). Each leg is `floor(remainder * r / 65535)` on its own (DeltaTransformer's `WideMath.fill`), so the rounding loss stays with the leg that
rounded down; a fill that takes nothing of a leg is refused (`fill_too_small`); 65535 takes the rest and drops the offer. Between the deadline and deadline + reserve an offer is neither
fillable nor lapsable (only withdrawable): that gap is the reserve of R-HTLC-CLOCK. The fill moves the offdeltas by the legs, releases those legs from the reservations and shrinks the clause.
Planted bugs: `swap-fill-beyond-remainder` (the whole fill takes the amounts offered), `swap-fill-leg-rounds-up` (the want leg rounds up), `swap-fill-ratio-unchecked` (ratio 0 or 65536).

**Q-S-4. Reservations, RCPAN and conservation (R-SWAP-OFFER).**
Choice: the maker's give is held against the maker in its token, the taker's want against the taker in the other token (`Ledger.reserved`); RCPAN counts the holds as locked, so an offer is kept
only if RCPAN still holds with it and a fill never fails on funds. Three properties, each written from the open offers and not from the `:held` field the rules keep: the holds are exactly what
the open offers could still take; RCPAN holds in the worst case over the open offers; the offdeltas hold exactly the payments (a ghost the rules never read) and the legs filled, so nothing is created or
lost. A fourth is about payments: a payment is refused exactly when RCPAN, counting only the open offers as held, refuses it, for amounts 1 to 3. Planted bug
`swap-withdraw-keeps-reservation`: the reservation outlives the offer and RCPAN refuses a payment it has room for.

**Q-S-5. Withdraw and lapse (R-SWAP-WITHDRAW, R-SWAP-EXPIRE).**
Choice: withdraw by the maker at any time, a past deadline included; it returns the remainder's reservations, drops the clause, keeps what was filled, and a fill after it is refused. Lapse by anyone once now
is strictly past deadline + reserve. A withdrawn or a lapsed offer never changes again (a step property over every rule, so any rule that touches a closed offer is caught, not only `fill`). The chain has no expiry
(decision 03:11), so until the lapse frame commits the signed clause is live and a dispute fills it: the dispute property reads open offers whatever the clock says (M2, the free option, accepted).
Planted bugs: `swap-fill-after-withdraw`, `swap-fill-after-lapse`, `swap-withdraw-returns-too-much` (a step property: a withdraw returns at most the remainder), `swap-lapse-early`.

**Q-S-6. The dispute (R-SWAP-ONCHAIN, R-BOOK-DISPUTE-HONORS).**
Choice: one rule, `dispute r`, for a taker ratio r in {0, 32768, 65535}: the chain settles the body's offdeltas plus, for each clause, `floor(amount * r / 65535)` on each leg (0 is a missing argument: no fill).
A clause with no allowance on a leg reverts the whole finalize, which the page reads as a refused dispute (`finalize-reverts?`); R-SWAP-ALLOWANCES says the clause carries an allowance on both legs, in full, of what remains
(planted bug `swap-clause-no-allowance`). Properties: the legs the chain fills are floor on each leg of the clause (`swap-chain-leg-rounds-up`, `swap-chain-no-argument-fills`); each token settles at
the payments, the legs filled and the taker's fill of what the book says remains (`swap-dispute-drops-filled`: the chain starts from the offdeltas before the fills and a fill is lost); no side is past the credit the other extended after
a dispute. The page settles; it does not run the payout (collateral, reserves, debt), which is the dispute page. Not modelled: the allowance CLAMP (an allowance below the fill caps the delta; here the allowance is the remainder so it never bites),
the n-th ratio of several swaps in one clause, the starter's committed ratio (all three are contract tests of R-SWAP-ONCHAIN).

**Q-S-7. Not in the page (scope).**
Several tokens beyond one pair (the Account of the page has two); the hub book and its lots, prices and dust (PR #92; rows R-BOOK-*); loans; a clause among HTLC clauses (the only holds here are offers; R-HOLD-CAP's 32 is not counted); several offers in one slot;
a stale proof (a maker who starts a dispute on a state from before the fill is answered by the taker's counter, the dispute page). Runtime duties, none of them checkable on a page: WHEN to lapse (the lapse is a frame the Runtime must propose; the page shows only
that it is allowed from `deadline + reserve` on), retract before a dispute, the taker's choice of ratio, and R-SIGNED-IS-LIVE for the fill's frame: the proof signed before the fill (with the larger clause) stays enforceable on chain until the fill's frame
commits, so a fill is only as final as its frame; the page holds the frame that commits.

**Q-S-8. Register.**
The ids R-SWAP-OFFER, R-SWAP-FILL, R-SWAP-CLAUSE-WITH-FILL, R-SWAP-ALLOWANCES, R-SWAP-WITHDRAW and R-SWAP-EXPIRE appear in property names. Their rows are not on main (the kernel thread, PR #111, owns them), so this page adds none; the names wait for the rows.
Rows on main whose Arrival cell this page carries, narrowed in their statements: R-SWAP-ONCHAIN (floor legs and ratio 0; allowance clamp, n-th ratio and committed ratio on no page), R-BOOK-CLAUSE-LOCKSTEP and R-BOOK-DISPUTE-HONORS (the one-Account half; the hub book's
lots and prices on no page).

## Checker (`lib/check.scm`)

**Q-C-3. Step properties.**
`:steps` is an optional list of `step-property` (world, rule name, side, next world). A page states
what each rule did, from the formula (money/ledger.scm). Gotcha found on the way: a lambda parameter
named `rule` reads as nil (it shadows the macro), so step properties take `rname`.

**Q-C-1. What does "live" mean?**
Choice: no fairness model. The check is "from every reachable world, a goal world is still
reachable" (nothing can wedge the protocol), with unbounded resends. It does not prove that a
schedule that never delivers still finishes; nothing can.

**Q-C-2. State identity.**
Choice: a world is identified by a string built from its dicts in insertion order. Worlds must be
built from `init` by updating existing keys, so a page declares every key in `init`.

## Open in xln.ts (points the pages do not settle)

Found in the reading of xln.ts against the spec (line numbers are pure/xln.ts). Each is a point where
xln.ts has no defined behavior or disagrees with the reading taken. Recommendation first; where a
page already carries the rule, the page is named.

**R-HOLD-CAP (coordinator 09-30, owed).** R-HOLD-CAP is per Account across tokens (32, the contract's per-body cap). It is owed when the multi-token Account is modelled.

**Q-X-1. Hop deadlines against dispute windows.** xln.ts has constants (5085-5112) not tied to the
Account response windows (657); `onwardDeadlineSafe` (22787) is the only check. Recommendation: the
incoming deadline is at least the outgoing one plus the larger response window plus HOP, computed per
Account; refuse to forward otherwise. Page: entity/routing.scm carries HOP (Q-RT-5).

**Q-X-2. When may an HTLC expire?** `htlcExpired` (5786) mixes the Account frame time and the J
height. Recommendation: expire only after the deadline plus one LAG, on J height (chain time), never on
the frame clock. Page: the fail-back wait R2 in entity/routing.scm.

**Q-X-3. RCPAN at setCredit and at settlement holds.** `setCreditLimit` (4634) does not check the
credit bound; the account-model document says it must (Q-L, money page). Settlement holds
(`chargeSettlement` 4600) are stricter than the contract. Recommendation: refuse a setCredit that
leaves the bound; keep the settlement hold as stated local policy, not protocol.
DECIDED (coordinator 09-30, R-SETTLE-CREDIT): a party co-signs a settlement only if, after it, each side's position is still
within the credit the other side extended (the bound a payment respects), so a withdrawal of collateral beyond one's own claim is
refused. The test rig found it: a co-signed settlement left Left at delta -7,000,031 against credit 18,092
(review/rig-properties-2026-09-30/REPORT.md). Page: money/ledger.scm holds every collateral move (`r2c`, `c2r`) to RCPAN; planted bug
`settle-ignores-credit` (a C2R that skips the check) fails "credit holds".

**Q-X-4. Debt.** Does the Entity act on it (forgive, repay order, revoke credit)? Recommendation: pure
observation, and a forgiveness only inside a cooperative update. Page: dispute/dispute.scm keeps the
debt in the payout; the Entity side is not modelled.

**Q-X-5. The Account after a dispute finalize.** `external_finality` (159-178) yields `disputed` from
every phase; only preparing goes back to open. Recommendation: the Account closes to a fresh
generation (N1: from the new epoch a dispute may start from the implicit proof, D2) with clauses resolved by evidence. Page:
dispute/dispute.scm ends at the epoch advance; the Account state after it is not modelled.

**Q-X-6. entityCommand atomicity and nonce.** One command is all or nothing; the nonce is consumed on
a refusal too (not verified in xln.ts 21362).

**Q-X-7. openAccount.** It is fatal on error (20933) and a crossing open has no tie break.
Recommendation: existing open is a refusal, a crossing open resolves Left-wins like the frames.

**Q-X-8. Which clock judges timeouts.** Disputes: chain time. HTLC: J height. Entity frame time is
for scheduling only (`submitTiming` 15208 uses frame time).

**Q-X-9. Refusal cost and spam.** Which refusals are free? Recommendation: a bounded per-sender budget
and eviction (`foldEvicting` 26595), mempool_full first.

**Q-X-10. Reorg policy.** `rewindJHistory` (29438) exists; what a reorg does to a batch already
counted as sent, and to an HTLC whose reveal was on the orphaned block, is not decided. LAG in
entity/routing.scm is the only place time-to-see appears.

**Q-X-11. The closed list of halts.** R-X1 holds in the Runtime page (peer input never halts) but many
`invariant(...)` sites in xln.ts are peer-reachable (J-range rejections, runtimeOutputTx authority,
SETTLEMENT_* checks). Recommendation: halt only on local corruption; each peer-reachable invariant
becomes a refusal.

**Q-X-12. Contract GAPs.** The contracts review (plan/contracts-review.md) lists points the contracts
leave open; the ones the spec depends on are decided in "Decided by the coordinator" (N1-N3, H1-H4).
The rest stay in that document.

## v2 proposals for Arthur (not derived from og, not in any page)

Marked as proposals: og has no settled design for these, and the spec does not describe them yet.
Each line is what the first page would have to decide.

- **Order book / swaps.** Where the book lives (Entity state, hub-only), whether an order is a lock
  (a clause in the Account) or an Entity-side hold, and who settles a fill (a frame of both Accounts
  or a J batch). Property to state first: a fill moves both legs or neither, and credit holds for
  both. xln.ts has `swap_request_account_missing` and `ensureRoom` for swaps (5769), not a spec.
- **Lending.** A loan is a credit line plus a due time; what happens at the due time (repay vs
  default, Q-P4 in the lessons) and whether default is a dispute. Property: money conserved and the
  debt after default equals what the payout ledger shows.
- **Boards.** Entity boards (validators, threshold) exist in the consensus page as a fixed 2-of-3;
  board change (add, remove, rotate) needs a rule for which frame is signed by which board and how
  H3 (retired-board evidence capped at collateral) applies.
- **Cross-J.** Atomic pairs across two chains are not modelled; the entity-height durability barrier
  is listed in Q-R-6. Proposal: v1 has no cross-J move.

## Decided by the coordinator (rules the spec carries; not open)

The N1 below is the FIRST version (15:19). The revised N1 (17:21) replaced it with a baseline proof co-signed with
every frame; decision D2 (R-IMPLICIT-BASELINE) replaces that in turn: from epoch 1 a dispute may start from the
IMPLICIT proof (empty signature, Right-authored, nonce stored + 1), and the first signed proof of an epoch takes
nonce >= stored + 2. See Q-D-4 and Q-D-21.

Relayed 2026-09-29 15:19 from the review of the contracts PR (#40).

- **N1 (first version, replaced).** A party signs a proof only for the CURRENT on-chain
  `ondeltaEpoch`; after an epoch advance payments pause until the epoch event is observed, then the first proof takes
  nonce >= stored + 2 (decision D2, Q-D-21). Signed proofs need not be gapless: the contract asks only for a nonce above
  the stored one, and a gap appears after a refused attempt and between the two sides' lanes (R-RETRY-NEW-NONCE, Q-A-12, Q-A-14).
- **N2. Deadlines.** One open HTLC deadline reverts a whole batch at finalize, so the runtime
  submits finalizes per Account, never bundled. A party refuses to sign an HTLC whose deadline is
  beyond its own tolerance (a named policy parameter, not a protocol constant).
- **N3. Windows.** Both response windows of a proof are at least MIN_RESPONSE_SECONDS (60 on testnet, 6 h on mainnet;
  contracts H2). Each proof carries its own windows (D2 supersedes "every proof carries the same values"): they may
  LENGTHEN and never SHORTEN inside an epoch, and the counter's and the final body's windows are at least the started
  ones (E9). The floor is the real response guarantee (a Runtime duty to watch its own disputes within it). Page:
  `windows-ok?`, `frame-extra`, the properties "windows never shorten inside an epoch ... (the signing guard)" and "a counter or
  final body carries at least the started windows: the chain's E9 check", planted bugs `counter-shortens-window` and
  `e9-dropped` (a Byzantine signer, Q-D-25); Q-D-21.
- **J2, R-C11, R-NONCE, R-DURABLE** (18:57): see Q-J-8, Q-D-17, Q-J-9, Q-R-7.
- **R-J5** (20:29) and **R-SPLIT** (21:01): see Q-J-10.
- **R1-R3** (18:10): see Q-RT-1 to Q-RT-3.
- **N2 bound: MAX_LOCK_HORIZON** (21:50): see Q-D-20, Q-RT-7.
- **R-CLOCK** (21:56) and **R-HTLC-CLOCK** (09-30): see Q-A-9. **R-REACK**: Q-A-2. **R-SETTLE-CREDIT** (09-30): Q-X-3. **R-ONE-LOCK-PER-HASH** (09-30, coordinator): an Account holds at most one open clause per hashlock, whoever the payer; a second lock on an open hashlock is refused (`lock_exists`) and a clause is still addressed by its slot. Page: `money/ledger.scm` (the lock rule takes a hashlock `h`; property "at most one open clause per hashlock"; planted bug `duplicate-hashlock`; 1440 states, 12918 transitions). The frames and clock pages carry one lock, so the rule does not bite there. Follows og (xln.ts 7457-7458). **R-NET**: Q-A-6.
- **R-FRAME-REFUSAL, attempt number, frame author** (10-01, coordinator; kernel A4a rounds 1-3): a receiver that cannot apply a
  frame refuses it with the frame hash, the index of the first tx refused and a fault tag; the proposer rolls its pending frame
  back, requeues every tx on a retryable fault (`not_expired`, `deadline_too_far`) up to the budget or drops the named tx with
  notice on any other, and re-proposes at attempt max(own, mark) + 1; the receiver keeps one mark per head, judges only frames
  above it and forgets it when the head moves; a frame names its author, in its hash, and a replica refuses its own. Page:
  Q-A-11, Q-A-12, Q-A-13 (default world 4563 states, 18600 transitions, 44 goals; bounds: clock 0..2, lag 1, retry budget 2).
- **R-RETRY-NEW-NONCE, R-PROOF-NONCE-ABOVE-SIGNED, R-SIGNED-IS-LIVE** (10-01, coordinator; A4b review, kernel PR 97 round 2): a
  frame carries an explicit slot (its proof nonce), in its author's lane and above every proof nonce either side signed in the
  epoch, so a retry signs a fresh one; every refusal carries the refuser's signed floor; a slot or floor more than one lane step
  beyond what an honest peer could reach is refused; a collision is won by the higher slot (Left's at the first); a lock in a
  signed, unsuperseded proof is not released by a refusal, only on supersession or after deadline + reserve. Page: Q-A-14
  (`yield-below-own-proof`, `retry-reuses-the-nonce`, `stale-slot-unchecked`, `slots-shared-lane`, `refusal-without-floor`,
  `slot-beyond-reach-accepted`, `refusal-releases-signed-lock`). R-FRAME-SIGNATURE-NAMES-ACCOUNT (a signature names chain,
  depository, Account and epoch): an open point, the page's frame has no scope (Q-A-14).
- **R-COSIGN-FREEZE** (10-01, coordinator): after a side co-signs a settlement or a C2R it proposes no frames and refuses every
  peer frame with a retryable `frozen` refusal (the attempt and mark rules of R-FRAME-REFUSAL) until the operation lands, is
  superseded or lapses. Page: Q-A-15 (config `freeze`, planted bug `frozen-accepts`, the property stated on the signed fold).
- **R-C2R-FOLD** (10-01, coordinator; review round 3 of PR 41): a collateral-to-reserve withdrawal is co-signed only while
  offdelta is zero; otherwise it goes as a settlement that folds offdelta into ondelta. Page: Q-D-26 (`withdraw`, config
  `withdraw`, bug `c2r-unfolded`). The same review's other two follow-ups are Q-D-24 (the implicit-tie property) and Q-D-25 (E9
  against a Byzantine signer).
- **H1.** Finalize waits until an unrevealed HTLC's deadline unless the secret is public.
- **H3.** Retired-board evidence is capped at collateral.
- **A12** (00:49): two co-signed proofs can exist at one nonce only with opposite proposer flags, and the contract
  always lets LEFT's proposal win, whoever starts or counters. The dispute page has it as the property "two proofs of
  one nonce and epoch have opposite proposers, and Left's outranks Right's" (killed by the existing
  `tie-break-inverted`, now caught here before the older "an honest starter never ends on a losing proposal").
- **J6** (00:49): see Q-J-12. **J2 extended, R-COSIGN, gas starvation** (23:42): see Q-J-11. **J5 refined** (22:31): Q-J-10.
- **R-IMPLICIT-BASELINE** (decision D2; Review A and B of PR 76): the implicit proof, the Right author, the first signed
  proof of an epoch >= stored + 2, windows lengthen and never shorten, floor windows are the response guarantee, deposits
  keep the epoch. Page: Q-D-21 (closed). Quint #44 carries the same cells.
- **H3** modelled: Q-D-22. **Baselines and a second dispute**: Q-D-21 (closed by D2).
  **Locked phase, quorum 3 of 3**: Q-E-8 (liveness finding, recommendation given).
