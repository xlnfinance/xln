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

The Entity is pure and the read is a chain read, so the Host brings it, as an Entity input ahead of what needs it:
`j_registry {hashlock, at, seconds}`. It is in the WAL row with the rest of the frame's inputs, so a replay decides the same.

`entity/registry.ts` (pure): `wantsOf(state, view, inputs)` = the hashlocks the next frame will decide on:
the lock and expire txs of the peer frames in `inputs` (an expire names a hold; its hashlock is read off the Account), the
hashlocks of `lock` and `forward` commands, the hashlocks of holds the Entity proposes to expire at `view` (expirable),
and the forward entries that have an inbound lock and no outbound one yet. A bounded set: at most the holds of the Entity.

`drive.ts` `frame` (shell): before `begin`, ask `wantsOf` for the frame's inputs (the next `perFrame` queue items, or the
waiting height, read at that height's block), read each at the block, and `submit` the `j_registry` inputs ahead of the
queue. A height frame is preceded by an Entity frame holding readings at the *new* height (`at > view`); the height row
makes them current. A failed read is a fault of that Account only (below); a read the node no longer serves is told.

State: `EntityState.registry: Map<hashlock, {at, seconds}>`. A reading is **current** iff `at === view` at the decision.
At the start of each frame readings with `at < view` are dropped, so the map holds only the readings of one block.
No height can be skipped: if the view moved between the read and the frame, the reading is stale, treated as missing,
and read again for the next frame (a retryable refusal or a waiting forward, never a wrong accept).

Why exact view and not "any reading since": a reveal at block b in (reading.at, view] was heard before the lock was named
and dropped by `shown`'s naming rule (R-REVEAL-BACKSTOP); only a reading at the view itself leaves no such gap.

## 3. The gate is opt-in

`Setup.registry` (a node that may hold value, the same nodes the call-trace probe covers): off, every Entity decides as
before (the whole existing suite is unchanged). On, the gates above apply. The daemon sets it for `watch.value` nodes and
refuses to start such a node whose port has no `registry` read. The e2e cluster sets it.

## 4. Reads at the view block follow the read-wait rules

- A read the node answers "no longer served" (pruned wording, the same list as the Account reading) is told:
  the Entity gets no reading, so the decision stays a retryable refusal or a waiting forward, and the Host tells a loud
  notice once (`registry_unread`). Nothing else is affected: other Accounts, the other frames and the watcher go on.
- Any other failure (503, timeout) is a fault of the port: the frame is not begun; the next tick tries again (the queue keeps its inputs).
- A pending read freezes only the decision (the frame waits for its reads; no other Entity work exists in this Host's frame).

## 5. `shown` is bounded

Entries are dropped at each frame once no hold, queued lock or paybook entry names the hashlock. A reveal heard for a
hashlock named later is covered by the reading, which is the point, so the map is the named set at most, and no longer
grows with every secret ever shown.

## 6. Tests

Forge vector: the real DeltaTransformer on the fork: reveal at a block whose timestamp is `r`; evaluate a payment with
`revealedUntilTimestamp = r` (pays) and `r - 1` (does not): `paid` in TS agrees at both. Entity: lock refused/accepted by
reading; expire; forward waits then forwards or is dropped; stale reading; replay. Host: `wantsOf` over inputs/commands/
height; `frame` reads before begin; fault classes. Fork e2e: a lock of a hashlock revealed before the lock existed is
refused and nothing is lost (D3); a reveal past the deadline height and within the slack seconds refuses the expiry (D1).
