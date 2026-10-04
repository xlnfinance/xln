# DESIGN: the Entity reads the registry at the decision (D1, D2, D3 of the 176 spec compare)

Author: builder, 10-03. Coordinator ruling 04:11: one rule closes the slack (D1), the reserve-by-accident (D2) and the late
lock (D3): the node reads `hashToTimestamp(hashlock)` on the DeltaTransformer at the view block it decides on and compares
it with the lock's signed second, as the contract does (DeltaTransformer.sol 289-299: paid iff `r != 0 && r <= revealedUntilTimestamp`,
and `terms.secondsOf(deadline)` already carries the slack: it is the second the body signs). Never heights.

## 1. What is decided on the registry, and what a reading is

A reading is `{hashlock, at, seconds}`: the registry's value for the hashlock in the state of J block `at` (0 = not revealed
as of `at`). `paid(reading, hold) = seconds != 0 && seconds <= terms.secondsOf(hold.deadline)`.

Three decisions (a gate on each; the watcher's `shown` stays the fast path that claims upstream, the read is the rule):

| decision | where | paid reading | no reading |
|---|---|---|---|
| accept a lock (my peer's frame, my own lock) | `entityRules.apply`, tx `lock` | refused `paid_on_chain`, for good | refused `registry_unknown`, retryable |
| co-sign or propose an expiry | `entityRules.apply`, tx `expire` | refused `revealed_on_chain`, for good | refused `registry_unknown`, retryable |
| forward a lock | `paybook.forwardOf` | the lock is not forwarded (the inbound lock is given up as for any refusal; the secret, if the watcher heard it, claims upstream through `revealed` as today) | the entry waits: no intent, no refusal |

A forward that waits must not become a `fail`: a missing reading is not a refusal of the door. So `forwardOf` asks the
reading before it makes the lock command; the door never sees a lock it would refuse for want of a reading.

## 2. Where a reading comes from: the frame that decides carries it

The Entity is pure and the read is a chain read, so the Host brings it with the frame, on the Runtime input
(`EntityBatch.registry` and `NewHeight.registry`, `Reading {hashlock, at, seconds}`), never in Entity state. The row holds
the input, so a replay decides what the first run did.

`entity/paybook/registry.ts` (pure): `wantsOf(state, inputs)` = the hashlocks the frame may decide on, sorted and unique: the
locks and expiries of a peer's frame in the inputs (an expiry names a hold; its hashlock is read off the Account), the hashlocks of
`lock`, `forward` and `expire` commands, the txs queued in any Account's mempool (judged again when it proposes) and the
paybook `forward` entries that wait. A set the frame's own work bounds, never the secrets strangers show.

`host.upcoming(host)` says which frame comes next and the view it decides at: the waiting height (every hosted Entity,
at that height) or the inputs of the Entity first in line (at the Runtime's view). `drive.readings` asks `wantsOf` for each
hosted Entity concerned, reads each hashlock at that view through `Shell.registry` and begins the frame with the readings.

A reading is **current** iff `at === view` of the frame (`registryOf`): a reading of another block is no reading, because a
secret shown between the two blocks would be missed. With `Setup.registry` on and no reading for a hashlock a lock or expiry
decides on, the Entity refuses it `registry_unknown` (retryable: the proposer takes the frame back and tries the next view);
`proposing` holds an Account whose queued tx has no reading, and `forwardOf` waits.

## 3. The gate is opt-in

`Setup.registry`: off, every Entity decides as before. On, the gates apply, the Runtime hands every frame a (possibly empty)
list of readings, and the drive refuses to start without a port (`no_registry`). The daemon refuses a node that may hold
value when its setup does not decide on the registry (`registry_off`). The e2e cluster sets it.

## 4. Reads at the view block follow the read-wait rules

- A failed read, or one the node no longer serves (the pruned wording, the same list as the Account reading), is no reading
  and a `registry_unread` notice, told once for each hashlock and reason. The decision stays a retryable refusal or a waiting
  forward. Nothing else is affected: the Account's other frames, the other Accounts and the watcher go on, and the node
  is never halted by it.
- A pending read delays only the frame that wants it (the Host reads before it begins).

## 5. `shown` is bounded

Entries are dropped at each frame once no hold, queued lock or paybook entry names the hashlock. A reveal heard for a
hashlock named later is covered by the reading, which is the point, so the map is the named set at most, and no longer
grows with every secret ever shown.

## 6. Tests

Forge vector (contracts/test/vm/fork-rules/h5-registry-second.test.ts): the real DeltaTransformer in BrowserVM: a secret shown at
the exact signed second pays, one second past pays nothing, before the lock existed pays; `paid` in TS agrees at each.
Entity (entity/paybook/registry.test.ts): lock refused or accepted by the reading, expiry, forward waits then goes or is
given up, a reading of another block, a queued tx, replay. Runtime, Host, drive, evm, daemon tests for the plumbing. Fork
e2e steps `late-lock` (a lock of a hashlock revealed before it existed is refused, nothing is lost: D3) and `late-expiry` (a
reveal past the deadline height and inside the signed seconds refuses the expiry: D1; the old height rule would have let it stand).
