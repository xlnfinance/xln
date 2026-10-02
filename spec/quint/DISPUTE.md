# The dispute lifecycle of one Account (`dispute.qnt`)

One model for what the slices of this spec only show apart: both Entities, the chain between them, and the frames in flight.
Sources read on development `10ced64d3` and PR 160 `d57ee8112` (10-02): `contracts/contracts/Account.sol` (`_disputeStart` 1834-1980,
`_registerCounterDispute` 1507-1623, `prepareDisputeFinalization` 721-910, settlement and C2R advance the epoch at 1385 and 1743 and
revert while a dispute is open), `pure/entity/chain.ts` and `frame.ts` (`disputed`, `counterOf`, `answering`, `finalFor`, `proposing`),
`pure/host/shell/drive/drive.ts` (`lapsedInputs`), `plan/freeze-design.md`, `plan/counter-design.md`, `review/pr-160/REVIEW-A.md`.

## What is in it

A proof is its nonce. A frame is a payment: a frame committed by a side is a payment that side counts. Time is in ticks.

| piece | in the model |
|---|---|
| Chain | epoch, stored nonce, one dispute record (starter, opening nonce, end of window, at most one counter), a log of events in order: dispute started, counter registered, window over, finalized-and-epoch-advanced |
| Entity (each side) | what `ChainFacts` holds on #160: `starting` (own start: nonce, window given, window over, counter heard), `against` (the dispute against me: nonce, window over), `answer` (my counter: nonce, registered, lapsed); the epoch it signs in and its base; up or down |
| Frames | one in flight at a time: sealed by a side in its epoch, committed by the receiver, committed by the sender on the ack; refused if the receiver is in another epoch (and taken back) |
| What the Entity asks | the operator's dispute command (from the newest proof it holds), the counter (once, restated until registered or lapsed), the finalize (`finalFor`), each as an ask that lands on the chain within LAG |
| Chain rules | a start is skipped (and told to nobody) when a dispute is open, the nonce is not above the stored one, or the epoch moved; a counter only by the non-starter, newer than the opening, inside the window, one newest; a finalize with the counter's proof from the end of the window by either side, or without a counter the non-starter at once and the starter from the end of the window; the finalize advances the epoch; a co-signed settlement advances it with no dispute |
| Host | its simulation drops a start or a counter it says would revert (`j_start_lapsed`, `j_counter_lapsed`); at most MAXDROP times a run |
| Environment | each side may go down (twice a run in all), a transient revert, an event is heard in the chain's order; time passes only when every up Entity has heard and run its duties and every landable ask has landed within LAG |

Phases of an Entity (`phase`): 0 none, 1 own start pending, 2 own start registered, 3 peer start seen, 4 counter pending, 5 counter registered,
6 counter lapsed, 7 window over; start lapsed is the Host's drop (`w_no_start_lapsed`), finalized is the epoch advance heard. Every one is a
witness that the search reaches.

## The properties

- `newest_wins`: the newest co-signed proof of the epoch is the one that pays, if a party that could put it on the chain stayed up (a non-starter that holds it, or the starter if it opened with it).
- `no_lock` (`no_lock_left`, `no_lock_right`): no Account stays locked if either side is live. Stated for a side alone: once it has heard everything, run its duties and sees the window over, it has a finalize asked or landed, whatever its peer does.
- `no_silent_zeroing`: a side that rebases with a frame committed beyond the proof that paid was told.

## Four switches

`FREEZE` (decided 10-02): an Entity with a dispute record seals nothing and refuses the peer's frames. `LIVE` (decided): a counter lapses only on a
permanent revert, so a transient one is retried while the window is open; and the starter finalizes with a registered counter. `ACCEPT` (not decided,
what this model says is missing): the non-starter that holds nothing newer than the dispute's proof finalizes with it. `NOTICE` (owed,
R-DISPUTE-VOIDED-NOTICE): a side that rebases with committed frames beyond the settled proof is told.

## Result (random search, 2500 traces of 70 steps, seed 0x5; `./check.sh` asserts each cell)

| code | newest_wins | no_lock | no_silent_zeroing |
|---|---|---|---|
| today (development + #160) | fails | fails | fails |
| FREEZE only | fails | fails | fails |
| LIVE only | fails | fails | fails |
| FREEZE + LIVE (the two decided fixes) | holds | **fails** | **fails** |
| + ACCEPT | holds | holds | **fails** |
| + NOTICE | holds | holds | holds |

"Holds" is no violation found over the samples, not a proof. "Fails" is a counterexample, and each has a scenario test that says what the code does
(`dispute_test.qnt`, 9 tests, run under every variant, 54 runs):

1. `frameAfterTheCounterTest` (today, LIVE only): the counterer keeps sealing after it countered; the frame commits on both sides and the chain pays the counter, one payment older. FREEZE refuses it.
2. `counterLapsesTest` (today, FREEZE only): a transient revert drops the counter, the Entity is told it lapsed and never asks again (REVIEW-A N1); the starter finalizes after the window with the older proof while the counterer is live. LIVE retries.
3. `starterNeverFinalizesTest` (today, FREEZE only): the counter registers and its author goes down; the starter heard the counter and asks for nothing (`finalFor`): locked as long as the peer is down (N2). LIVE finalizes with the counter.
4. `nothingNewerTest` (FREEZE + LIVE): the starter goes down; the non-starter holds nothing newer than the opening proof, so it has nothing to counter and `finalFor` asks nothing, though the contract lets the non-starter take the opening state at once (`Account.sol` 861-875). **Locked while the starter is down. Neither decided fix covers it.** ACCEPT does.
5. `finalizeGapTest` (today): the chain has finalized and a side has not heard; the frame it seals in the old epoch commits on the other side and is zeroed at the rebase, told to nobody. FREEZE closes it: the side is quiet from the moment it heard the dispute.
6. `sealedBeforeTheStartTest` (FREEZE + LIVE + ACCEPT): a frame sealed before the starter's own start commits on the peer, which goes down; the ack reaches the starter; the starter finalizes with the older proof after the window. Both sides committed the payment and it is zeroed with no notice. The newest-wins property excuses the chain here (the peer was down). **Only NOTICE tells it** (the "frame sealed before and acked after" item of `plan/freeze-design.md`, backlog R-DISPUTE-VOIDED-NOTICE).
7. `bothStartTest`: both start at once; the chain keeps one and skips the other, told to nobody; the loser's `starting` has no window until the epoch moves (PR 160 refuses a second start and waits on the window of the dispute against the node, so it does not wedge).
8. `startAfterTheEpochMovedTest`: a co-signed settlement moves the epoch while a start is on its way; the chain skips it; the record is forgotten when the Entity hears the epoch move.
9. `staleStartCounteredTest`: the baseline, the #159 audit case: the older proof starts, the newer one counters and pays. Holds everywhere.

## What it assumes and leaves out

- A proof is its nonce. The equal-nonce rule (Left's proof outranks Right's at the same nonce) is `chain.qnt`'s; here every nonce is distinct.
- No clause, no Pull, no HTLC: the third finalize path (the non-starter finalizes at once with a newer pull-free proof it holds, `Account.sol` 817-857) is not used by the Entity and not modelled. It is one more way a non-starter could close a dispute it cannot counter in time.
- ACCEPT assumes the non-starter can build the opening body: it holds the same proof, or it sealed the frame the starter acked. A start's calldata carries the body; the log carries its hash only.
- "Zeroed" is a frame a side committed whose nonce is above the proof that paid. Half-committed frames count (the receiver committed, the ack did not arrive): the receiver's ledger is rebased to zero too. If the proposer re-seals a refused frame in the new epoch the payment may land again; the model does not credit that.
- A co-signed settlement freezes both Entities from the moment it lands, a coarse form of R-COSIGN-FREEZE.
- Fairness is a bounded environment: two crashes, one transient revert, asks landing within LAG, events heard before time passes. A longer outage of the holder is excused by `newest_wins` (`wasDown`), by design.
- The Host's wedged draft (REVIEW-A N4: a reverting counter delaying a reveal in the same draft) is a Host property, not here.
- Debt, payout arithmetic, board rotation, windows of different lengths: `chain.qnt` and `entity.qnt`.

## HTLC holds across a dispute (`htlc.qnt`)

`dispute.qnt` has no money and no holds. `htlc.qnt` is the companion that has them, for the two money bugs the coordinator's audit of the freeze PR (#162) found
(`review/pr-162/REVIEW-A.md` F1 and F2): a route of two Accounts, the payer P with the hub H (U), and H with the payee Y (D); one payment of one unit; P's lock on U
expires at TU = TD + HOP, H's lock on D at TD. A dispute on D (either side starts it from a proof that carries the hold), the payee's release by frame or its reveal of the
secret on the chain, the finalize (a carried hold is paid to Y iff the secret was registered by TD, else refunded; it waits for TD: E6, H1), the epoch move, the hub's claim on U,
the payer's expiry of U. The code modelled is #162's (FREEZE on): an Entity with a dispute record seals nothing and refuses frames.

Properties: `paid_once` (what Y was paid, by frame or by the chain, is at most one unit) and `route_safe` (once U is closed, claimed or expired, the hub paid out at most what it collected).
Switches, the decided fixes: `SEE` (the secret on the chain is a chain fact at depth that the paybook uses like a received resolve, and the hub claims upstream) and `DISSOLVE` (holds carried by the finalized proof are dissolved at the epoch move, at both sides, never re-released).

| code | paid_once | route_safe |
|---|---|---|
| today (#162) | fails | fails |
| SEE only | **fails** (F2) | **fails** (F2) |
| DISSOLVE only | holds | **fails** (F1) |
| SEE + DISSOLVE | holds | holds |
| SEE + DISSOLVE, HOP = 0 (mutant) | holds | fails: the claim lands after the upstream deadline (E3 needs HOP >= REACT) |

Each failing cell has a schedule in `htlc_test.qnt` (8 tests, run on the four variants and the HOP = 0 mutant): `chainRevealUnheardTest` is F1 (hub out one unit), `releaseAfterFinalizeTest` is F2 (Y is paid by the chain and again by the release sealed after the epoch move),
`finalizeAfterTheUpstreamExpiryTest` shows `route_safe` must be checked after the finalize too (the window ends after TU, so the payout comes after the expiry and only SEE has claimed in time).
`claimNeedsRoomTest` is the HOP = 0 row (the claim lands after TU). The baselines (`releaseByFrameTest`, `refundWhenNotRevealedTest`, `lateRevealTest`, `committedReleaseThenDisputeTest`) are safe everywhere.

Assumes: one hold, one unit, one dispute; no crash, counter or stale proof (those are `dispute.qnt`); the starter's proof carries the hold iff it still saw it open; a committed frame the finalize outdates is zeroed (so a payee that did not reveal is robbed by a release committed during a start it has not heard, which is `dispute.qnt`'s `no_silent_zeroing`, the hub's side stays safe); a finalize or reveal ask lands within LAG; the hub's claim on U lands within LAG; the payer lets U expire as soon as TU passes. Not modelled: the symmetric double collection on U (a release queued on U and re-committed after a finalize charges the payer twice; the same DISSOLVE rule closes it), a co-signed settlement carrying holds through an epoch move (the chain does not settle those, so holds stay), several tokens.

