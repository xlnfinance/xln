# The node's dispute duties

Status: the statement slice 2 follows. It does not release a later slice by itself, and it does not decide an open question in `spec/QUESTIONS.md` or `spec/quint/QUESTIONS.md`.

The contract judges a reveal by seconds. `DeltaTransformer.applyPayment` counts `hashToTimestamp[hash]` only when that stamp is not zero and is at most the payment's `revealedUntilTimestamp` (`contracts/contracts/DeltaTransformer.sol`). The signed body carries that second from `deadlineSeconds` (`pure/account/proof/deadline.ts`): one line through the deployment's anchor, plus `slackSeconds` once. No other formula adds slack again.

A height is not a second. A missing reading is not a decision. An unknown finalization is not a loss and not a retry.

## 1. Read-wait

The node reads the chain at a view and commits one watcher delivery as `j_observation`. A decision that needs a reading waits until that observation carries it. A replay of the observation decides the same way, because the reading is on the row.

A registry reading is `{ hashlock, at, seconds }`, where `seconds` is `hashToTimestamp`, the second the secret was recorded, not the second of the view block. The view block's second is a different field, `seconds` on the observation, and it is absent until the watcher has copied `watch.applied.timestamp`. Storing `0` in its place is a known second and is forbidden. Until the field exists, the head second is unknown.

## 2. Admission

`paid` compares the registry reading's own `seconds` with `terms.secondsOf(deadline)`, which is `deadlineSeconds`. Slack is already inside that function. The comparison is `revealedAt != 0 && revealedAt <= secondsOf(deadline)`.

Three representations, and no fourth:

- `Setup.registry` off: the observation has no `registry` field. The gate is off. A lock is admitted without a registry lookup.
- Setup on and nothing is wanted: the field is `[]`. The gate is on. There is nothing to look up. This is not the gate being off.
- Setup on and a wanted hashlock was not read, or the read failed or was pruned: the field is present and that hashlock is absent from it. A forward waits. A lock or an expiry of that hashlock is `registry_unknown` and is not admitted.

`no_registry` is the boot fault of a value-holding node that has no registry port. It is not the name of an empty list. A failed read is the third case, including on replay, and is not stored as `[]`.

A hashlock the registry already shows as paid refuses a new lock (`paid_on_chain`) and refuses an expiry (`revealed_on_chain`).

## 3. Forwarding

A hub forwards a lock only when the claim fits in chain seconds. The outbound deadline, shortened to what the chain's own time allows, must still leave the hub enough time to learn the secret and claim upstream. The shortening never lengthens the deadline.

`forwardable` has three arms. With no pace, the height gap is the only check. With a pace and no head second, the hub forwards nothing. With a pace and a head second, the effective outbound deadline is `view + min(deadline - view, blocksLeft)`, and `blocksLeft` is how many blocks the known second still allows, reduced by missed slots. `MISSED` shortens that forward gap only. It does not move `regShows`, `claimLandable`, or `expirable`, which stay on the upstream second and the upstream height.

The reaction bound is `depth + pollDelay + missed + 1` heights. `reserve` is at least that. `pollDelay` is at least `pollDelayOf(tickMs, slot)`, which is `ceil(tickMs / (slot * 1000)) + 1`, in `pure/host/shell/node/daemon.ts`. A node that polls later than that bound blinds its forwards (`poll_late`).

`slackSeconds >= depth * blockSeconds` is the configuration check that the single slack addend covers the depth. It is not a second addition of slack onto `secondsOf`.

## 4. Expiry

An expiry is admitted only when the registry does not already show the secret inside `secondsOf(deadline)`. A backstop that looks only at height, with no admission read, is not safe: the model records that case as a violation (`hlkback`). Skipping the transition, or expecting `route_safe` to hold, is not evidence.

The on-chain give-up, when the hub stops waiting to claim upstream, is `secondsOf(deadline) - (lag + depth) * blockSeconds`. The comment that wrote `deadlineSeconds + slack` is not copied.

## 5. Finalization reconciliation

While a dispute is open, `quiet` is true: the node proposes nothing and refuses the peer's frames with `frozen`. Commands that take on value are refused with `account_disputed`.

When a finalize moves the epoch, the node names the proof by `finalBodyHash` from the log (`finalBodyOf`). A hash it can name supplies the nonce. A hash it cannot name leaves the nonce unknown.

Unknown is not `lost`. Affected intents stay unresolved. The account stays quiet after `inDispute` has cleared: no propose, no peer frame, no `pay`, `lock`, `offer`, `fill`, `settle`, `c2r`, or `withdraw`, and an ack does not refill the mempool. The owner is told `finalization_unknown` and that notice is durable. Spending resumes only when a later observation carries the same `finalBodyHash` the log already had, including when no local proof had that hash at the first hearing. The record survives restart because it is account state, rebuilt from the journal.

A named proof follows the existing rule. A pending frame the proof holds is `paid_on_chain` and is not sealed again. A pending frame above a known nonce is `resent_in_new_epoch`. The register row `R-DISPUTE-FREEZE` stops saying that an unknown nonce is sent again. That sentence moves to `R-FINALIZATION-UNKNOWN`.

## 6. Recovery

Deliveries commit effects, pending reads, and height together. A pruned read is not a reading. Unidentified legacy waits fail before anything is published. The old WAL is not rewritten in place.

`R-HOLD-DISSOLVE` stays the dissolve rule. A finalize dissolves the holds of its proof. S9 rechecks that behavior. It does not add a second dissolve.

A secret the chain reveals is heard as `j_secret` at the configured depth, including on a frozen account, so a hub can claim upstream without a frame the dispute would refuse.

## 7. Account-local faults

`registry_unknown` faults that decision only and may be retried when the reading arrives. `registry_unread` is the notice of a failed or pruned read. `no_registry` refuses to start a value-holding node. `poll_late` blinds forwards until the poll is inside the bound. `finalization_unknown` freezes the account until the log hash matches. None of these is a global halt of other accounts.

## 8. Evidence

A decision at a view uses the readings on the observation of that view. Missing evidence delays the decision. It does not admit the lock and it does not forward. The model admits a late lock only by a step that sets the hub's hold when the admission read allows it. `ADM = 0` leaves the hold false. `hlkback` remains a `route_safe` violation.

The seconds forward gate is a step, `forwardLock`. Its killer is a scheduled race (`lateRevealRaceTest` on `htlc_hmiss`), not a random search of `route_safe`. On that cell both holds start false. The honest action leaves them false. A mutant that drops the seconds arm sets them and loses the race. The other runs of that module do not call `askStart` while the holds are still false.

## 9. Timing assumptions

`lag` is the most two views differ by. `depth` is how far behind the head the node reads. `missed` is the slot margin. `pollDelay` is the bound above. Inclusion of a J transaction within `lag` is not enforced here. The duties document checks configuration against the reaction bound. It does not add an inclusion enforcer.

Live measurements of `lag` and depth are the Sepolia milestone. This statement uses the configured bounds.

## 10. What the owner is told

`offdelta_rebased` when a committed head is above a named proof. `pending_rebased` with `paid_on_chain` or `resent_in_new_epoch` for a named proof. `finalization_unknown` when the nonce cannot be named, and the same notice still present after restart. `registry_unknown` and `registry_unread` for one decision. `poll_late` when forwards are blind. A command refused during a freeze carries `command_refused` and `account_disputed`.

A restart after a failed batch that was then resent submits one deposit, not a second. A chain action the host cannot submit is noticed. It does not vanish.

## 11. S9

A dispute on an account that still has an open HTLC in the signed proof. The chain waits out the reveal window, then pays by the proof. Both runtimes dissolve the holds (`R-HOLD-DISSOLVE`, the tests already on development). No new dissolve module. The step is not left `Blocked`.

## 12. S9b

Runs only on a head that already admits by the registry and forwards by seconds. A hostile relayed finalization. The hub claims upstream inside `secondsOf(deadline)`. Setup fails when `slackSeconds < depth * blockSeconds`. The give-up is `secondsOf(deadline) - (lag + depth) * blockSeconds`. The hub is not out the routed amount. An expiry co-signed from a height rule, while `hashToTimestamp` is already inside `secondsOf(deadline)`, does not succeed.

## 13. Not settled here

Acceptance of a voided dispute. A voided-notice row. A lag inclusion enforcer. Live Sepolia numbers. Loans, cross-jurisdiction work, watchtower coordination, new bytecode, and redeployment.
