# DESIGN: the watcher's read-wait (PR 171, fourth round: one design, then one push)

Author: builder, 10-03. Replaces the patches of rounds 1-3. Everything below is the rule; the code and the register
(R-WATCH-STALL, R-WATCH-CALLDATA) are written from it, and each item has a probe-shaped test through the real poll
or the real daemon.

## 0. What waits, and why nothing else may

An event the Host tells the Entity comes from a log. Three things in a log's story come from elsewhere:

| need | where it comes from | what it is for |
|---|---|---|
| R: the Account's `(epoch, nonce)` at the event's block | `accountAt(blockHash, ..)` | the epoch the Entity files the event under (a `j_dispute` of another epoch is dropped, `epochAdvanced` ignores an older epoch) |
| S: the secrets in a finalize's arguments | calldata of the finalize tx (input, call scan, call trace) | a secret that paid a clause on chain without `SecretRevealed`; the hub claims upstream with it |
| B: the body of a start | calldata of the start tx | the Entity finalizes the peer's dispute with it |

Everything else (windows, nonces, proof hashes, a start's secrets, counters, collateral) is in the log. So:

**Rule 1: read what an event needs when the event is first seen. Only S and B (the trace) wait.**

## 1. R is read at first sight and carried

Every event of a hosted Account gets its reading in the poll that first sees it, held or not, and the readings of
held events travel with them in the carry (`Carry.readings`, by `readingKey`). A release never asks the node about an
old block, so a hold longer than the node's recent-state window (128 blocks on a node that is not an archive node) costs
nothing (P12: lastHeard 200, a SecretRevealed of another Account at block 300 was never told).

A reading the node answers "no longer served" (a pruned state: geth's `historical state ... is not available` and `missing trie node`, Erigon's `old data not available due to
pruning`, Nethermind's `No state available for block`, Reth's `state at block #N is pruned`; a block the node does not know, a
null answer, and every other error are faults) is not a fault of the poll: it faults **its own Account only**. The Account's events
from that one on are not told, now or at any later poll (the Host drops the events of an Account the Entity's chain
facts call `lost`; the cursor moves past them), the Entity is told `j_account_lost {peer, from}`: it files a
loud notice (`account_lost`), sets `behind = from` and `lost` (so the Account stays quiet for good, and `j_behind_over`
is no way out of it) and nothing else. Every other
Account and every `SecretRevealed` is told as usual. Any other failure of the read (a 503, a timeout) is a fault of the
port: the poll is tried again at the next tick, nothing was told, the cursor did not move. A lost Account stays lost
across a restart (the WAL holds `lost`; the restart drops its events without reading them), and its notice is told once.
Owed: resync of a lost Account (operator re-reads on an archive node); backlog.

## 2. S: the finalize alone is held (G1)

A finalize whose calldata the node will not give is held **alone**: its secrets, then its `j_dispute_over`. The epoch advance
it made (`j_epoch`, with `finalBodyHash`) is told at once, in its place, and so is every later event of the Account.
`j_dispute_over` is what makes `finalized` (entity/frame.ts) turn the Account's `locked` paybook entries into `fail` and cancel
the inbound locks upstream, and `revealed` acts only on `locked` entries: a secret told after the dissolve is lost. The rebase
(`j_epoch`) dissolves no hold, so it need not wait; and it must not: a start in the epoch after the finalize is dropped by
`disputeOpened` unless the Entity heard the advance first (chain.ts: a `j_dispute` of another epoch than the facts'), after
which the Entity signs in the new epoch with a dispute standing it never heard of and misses the counter window.

The two halves of `finalized` are therefore separable. `j_epoch` with a `finalBodyHash` pays the Account out (the held
collateral rows are zero: R-LEDGER-REBASE). A held finalize arrives `late` (the Host marks what a poll releases from its
carry): the Entity dissolves the Account's holds and fails the forwarded locks (`finalizedLate`) and leaves the facts alone,
which by then are the new epoch's (a dispute that started in it, a later collateral snapshot). A finalize told in order
(`finalized`) does both, as before. The finalize's secrets are told ahead of the advance it made when that advance is in the
delivery, and ahead of the finalize itself when it is not: either way before the dissolve.

**Rule 2 (the dissolve race): an entry whose secret read is pending stays `locked` through the finalize.** By construction:
the Entity is not told `j_dispute_over` until the read lands or the Account's give-up passes. A lock this Entity forwarded to
the Account's peer dissolves only then.

**Give-up of an Account's pending finalize read = tries and height:** `tries >= FEW_TRIES` (one try per head block, at
least FEW_TRIES blocks even past the height: P11, one fault at head 6 must not give up a lock whose secret is still
useful) **and** `to >= latest(peer)`, where `latest(peer)` is the **maximum** over the Entity's `locked` entries to the
peer of (the inbound hold's deadline - lag); no such entry: the height condition is empty. The secret in a finalize
may pay any clause of the Account, so it is useful as long as it is useful for any lock of it: the Account waits
until the latest (N1: the least, which a short lock gave, lost the long lock's secret).

Why `deadline - lag` and `>=`: the hub must answer upstream `lag` before the inbound deadline (R-HOLD gap), the
upstream's view runs at most `lag` ahead (R-HTLC-CLOCK), so a secret heard at a view up to `deadline - lag` is passed
up in time and one view later is not (the spec compare's model: heard at g is safe). The off-chain claim compares J
heights, never timestamps, so the contract's timestamp slack does not enter here (L1). The slack enters the on-chain
claim only (S9b: the hub's claim is given up at `deadline + slack - lag - depth`, which needs `slack >= depth`; a
row of the freeze-followups reserve bounds).

A later finalize of the same Account cannot dissolve its locks while an earlier finalize still awaits its secret.
Its readable payload stays carried until the earlier one is read or reaches its give-up bound. Other Accounts remain
independent. This ordering closes the same-Account two-finalize counterexample, including across restart.

The decision is per event, never from the tx's first event: a tx may carry the ops of several Accounts of the Entity
and a stranger's. Each hosted finalize event waits or is given up for its own Account at its own `latest(peer)`; a
stranger's is not read at all (`needsBytes`).

## 3. B: a start is never held

A start is told at once as its log has it (window, nonce, proof hash, secrets, no body), so the Entity hears a dispute
against it, and every event that opens or closes its response window, in time (B9; the model: the counter registers only
if hearing delay plus lag is under the window). Its body is told when the bytes come: the start is told again with the
body. G2: `disputeOpened` returns early on a repeat once `against` is set, so the repeat is a path of its own that fills a
missing body, and only when the body hashes to the hash already logged (`bodied`, entity/chain.ts; any other repeat is
ignored). Unchanged by this round: it already did, and its tests are in entity/chain.test.ts. It is told
`j_start_unread` once a delivery's last block is past the window's end (the chain's own second). A start of the
Entity's own is not read. A counter is never held.

## 4. While an Account is behind

`behind` is set while the Host owes the Entity events of the Account (a held finalize, a start's body pending, a lost
Account). The Account is **quiet**: no new frame signed, its peer's frames refused as frozen, no lock forwarded
to that peer (the inbound lock is given up), and the inbound hold of a hash forwarded to it is not expired
(`reveal_unknown`). Holding a finalize therefore costs nothing on its Account: it takes nothing new meanwhile, and a
start in the epoch after has no proof of the Entity's to be countered by (and the Entity heard the advance, so it hears the start).

## 5. The probe and the blind Entity (N2, M1)

A node that may hold value watches and defends always; what the probe decides is only whether it may **forward value**.

- Boot always proceeds. The Entity starts blind (`j_blind`: no forward, no expiry co-signed, nothing else) unless a
  trace was proven in this run.
- The probe asks the first transaction of the newest block for a `callTracer` tree at each new head block, until one
  traces (no chosen window of blocks: PROBE_BLOCKS is gone; a block with none waits for the next head); on the first
  tree the Entity is told `j_blind_over` and the probe stops. A node that answers "no method" keeps being asked at each
  block (one cheap call); no `debug_traceCall` stands in.
- A run-time "no method" for a transaction on a value node tells `j_blind` again and the probe restarts. The node is
  never ended: it keeps polling, draining, countering and finalizing.
- `isFrame` is strict (L2): `type` is a call kind (CALL, STATICCALL, DELEGATECALL, CALLCODE, CREATE, CREATE2,
  SELFDESTRUCT), `from` hex, `to` hex when the kind calls.
- A missing method is `-32601` or the texts of the clients that give none: geth, Erigon and Nethermind's `the method
  debug_traceTransaction does not exist/is not available`, and Nethermind's code -32600 answers when the namespace is
  off (`... is found but the namespace 'debug' is disabled for <url>`, `... is found in namespace 'debug' for <url>' but
  is disabled for <endpoint>`): a method the endpoint will not run is a missing method (coordinator ruling 01:32); a bare
  -32600 is not (L3).

## 6. A restart (L4)

The WAL holds the Entity's chain facts (`behind`, `lost`, `blind`), the view, and the exact unresolved payloads
(`readWaits`, written by `j_read_waits`). Each pending finalize retains its log identity and evidence hash; a pending
start also retains the epoch read at the original event, accounting for later advances in that same block.

Once the WAL holds the delivery height, ordinary events at or below that view are already applied. Recovery must not
read their Account state again, replay their collateral, or repeat their epoch advances. It restores only recorded
pending payloads, reads their calldata, and releases finalizes as late. Existing carried read results are preserved.
The cursor still starts at `min(view, min(behind) - 1)`; old logs do not become new Entity facts.

A watcher delivery is one Runtime `j_observation` input and one WAL record: bounded Entity frames at the old
view, including the payload effects, pending list and `j_behind_over`, followed by the height frame only if the view
rises. A torn or absent record applies none of these; a durable record applies all. There is no persisted prefix
where effects or cleared markers run ahead of their view. Commands already queued are drained before the delivery.

Outputs and chain actions retain frame order and leave only after that record is durable. The submitter then pumps
them and commits any lapse feedback before the observation move returns. This intentionally removes chain-feedback
interleaving between the delivery's subframes: a rejected counter is marked lapsed in the next frame, after height,
with its existing nonce guard; it cannot cause the opening proof to be accepted before that rejection is known.
Repeated counter/finalize asks still use the builder's normal deduplication. The read-depth/response-window budget
must cover poll, WAL sync and submission latency; this change creates no new timing allowance.

Upgrade boundary: a pre-observation WAL with `behind`, not `lost`, and no `readWaits` cannot identify which
finalizes remain owed. Replaying archive logs can clear a newer dispute; marking every old finalize late can still
dissolve newer holds. The shell therefore refuses that WAL with `read_wait_upgrade` naming its peers, before
resuming the submitter or publishing outputs. It leaves the files intact for explicit offline migration from an
authoritative record of pending payloads. No generic migration guesses those identities. Legacy WALs without an
unidentified read wait, including already-lost Accounts, retain their original replay semantics. New observations
require the new reader; downgrades fail loudly on the WAL tag.

Ownership and durability: `readWaits` belongs to Entity ChainFacts and is reconstructed from the same ordered Runtime
WAL inputs as those facts. It is not a second journal, checkpoint, or signed Account proof field. Its exact log
identities and event-time epoch cannot be derived from the latest Account facts or from pruned historical state.
The node-level restart regressions require zero old Account reads, no duplicate epoch, one late finalize, no lost
Account, and preservation of a newer dispute across crashes after recording and clearing a read wait. A separate pending-start regression preserves its original epoch across a same-block advance. Once new
`j_observation` rows exist, recovery requires a version that understands them; do not downgrade the WAL reader.

A value node boots blind again and re-probes tracing. Retry counters remain volatile and restart at zero, extending
rather than shortening the retry floor.

## 7. The state machine, in one table

Per Account, per tx op:

```
log seen ──► R read (first sight; pruned ⇒ account lost)
   │
   ├─ start ──► told now (no body) ── bytes read ⇒ told again with body
   │                                └ window passed ⇒ j_start_unread
   ├─ counter/window/collateral/other advance ──► told now
   └─ finalize ──► the advance it made is told now (j_epoch, rebase, pays the Account out)
                 ├ bytes read ⇒ secrets, then dispute_over, in order
                 └ pending ⇒ the finalize alone held, Account behind, quiet
                       └ tries >= FEW_TRIES and to >= latest(peer) ⇒ j_finalize_unread, then dispute_over (late)
SecretRevealed ──► told now, always (about no Account)
```

## 8. Tests (each through the real poll, the daemon or the real port)

P9/P10 B9, B10 (start never held; stranger first and two Accounts); P11 two forwards, short and long: the long lock's
secret is heard (read lands at head 7 after one fault; the Entity is fed the events and claims upstream); the dissolve race
(the Entity is never told the finalize's end while the read is pending: the entry stays `locked`, and the epoch is told at
once); G1: a late end of a dispute leaves a dispute of the epoch after and a later collateral alone, and the advance
before the start is what makes the Entity hear the start (entity/chain.test.ts); two locks on one Account (the longer
lock's secret is claimed, the end fails the other: entity/paybook/paybook.test.ts); hearing out of order (a start still
reading and a finalize held, told again in the chain's order: host/shell/watch/loop.test.ts); P12 a hold past the
recent-state window: the release asks for no old block; pruned readings: the six wordings that lose their Account, the
fifteen that are faults, a null answer a fault (host/shell/evm/watch.test.ts); P13 a run-time "no method" on a value node
leaves the node polling, draining and countering, value forwards off; M1 boot on a quiet chain, probe at each block,
`j_blind_over`; L2/L3 `isFrame` and the Nethermind text; L4 a restart re-derives the held read from the cursor (a lost
Account is not read again); the node-level waits test (forward outstanding: waits past FEW_TRIES; none: gives up at
FEW_TRIES; the view guard); mutants rerun, survivors listed.
