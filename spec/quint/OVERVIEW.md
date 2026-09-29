# The Quint spec in one read

What the spec says, layer by layer: the state, the data that flows between layers, the state machines, the properties and the
mutants that prove each property bites. The files are the spec; this page is the map. Choices for unclear points are in
[QUESTIONS.md](QUESTIONS.md) (A = Account, C = chain, S = settlement, E = Entity, J = batch, R = Runtime); status is in
[PROGRESS.md](PROGRESS.md).

## The layers and what crosses between them

```
   user / peers ─▶ Runtime ─▶ Entity ─▶ Account (two replicas) ─▶ signed proofs ─┐
                     │ ▲         │ ▲                                              │
     durable log ◀───┘ │         │ └── J events (read LAG late, in order) ◀────┐   │
                       │         ▼                                              │   ▼
                       └── batches (signed, nonce n) ─▶ J: Depository ─────────┴── disputes, settlements, payouts
```

| layer | module | owns | consumes | produces |
|---|---|---|---|---|
| Account | `account_core`, `account` | the bilateral state (offdelta, credit limits, HTLC locks), the frame protocol between two replicas | transactions from its Entity, the peer's proposals and acks | committed bodies; a co-signed dispute proof per frame (+ the epoch baseline, S3) |
| Entity | `entity` | what one Entity does with its Accounts: routing, deadlines, escalation, freezing, commands | peer frames, acks, J events, signed commands, the tick | Account transactions, J ops (dispute start, counter, reveal, finalize) |
| J, one Account | `chain` | the dispute game and the payout of one Account on the Depository | J ops | reserves, collateral, epoch, debt, the secret registry |
| J, settlement | `settle` | the off-chain epoch lifecycle over the chain (cooperative update, rebase, presign + fold) | frames, the chain's view | the next epoch's baseline |
| J, batch | `jbatch` | how the Entity's ops reach the chain: strict nonce, atomic revert, urgent ops, the skip event of a dead dispute op | ops | landed batches, `DisputeOpSkipped` |
| Runtime | `runtime` | frame order, the idle gate, durability, J watching, the halt list | inputs from all sources | frames that are durable before they leave |

Nothing crosses a layer boundary except what the table says. A chain fact reaches an Account only as a J event, `LAG` ticks after
it happened (R-J1). A signed proof reaches the chain only through a batch.

## The numbers the layers share

`LAG` (a J transaction is included, and a J event read, within this many ticks), `REACT = 2 * LAG` (read it, then get the answer
included), the two dispute windows `>= 2 * MIN_WINDOW > REACT` (C11), `HOP >= REACT` between a hub's inbound and onward deadlines
(E3), `ESC >= LAG` (escalate that long before a deadline). `params_test.qnt` pins them across the modules; a change in one layer
fails there.

## Account (`account_core.qnt`, `account.qnt`)

State per replica: `height`, the committed `tip` Body, `status` (`Open | Proposed(f) | Received(f)`), a mempool. A Body is
`{offdelta, limitLeft, limitRight, locks}`; a lock is a slot with payer, amount, hashlock, deadline.

State machine of a replica: `Open` -- propose -> `Proposed(f)` -- ack -> `Open` (committed); `Open` -- peer's proposal -> `Received(f)`
-- own ack -> `Open`; a collision (both propose at one height): Left keeps its frame, Right rolls back to its mempool and applies
Left's (A1). A lost proposal or ack is recovered by resend. A refusal is a value, never a halt. The transition table (`applyTx`) has
six transactions: SetCredit, Pay, HtlcLock, HtlcResolve, HtlcCancel, HtlcExpire.

Properties: `credit_holds` (RCPAN in the worst case over open clauses), `agreed` (no two committed bodies at one height),
`no_equivocation`, `both_signed` (both signatures over the proof of the committed body). 14 mutants.

## Chain, one Account (`chain.qnt`)

State: the Account (`nonce, epoch, coll, ondelta`), money (reserves and debt per side), the dispute (starter, initial proof, windows,
counter), the secret registry, an arena of signed proofs (`nonce, epoch, leftAuthored, offdelta, clause, windows, signatures`).
Rank of a proof is `nonce * 2 + leftAuthored` (Left wins a tie).

State machine: `NoDispute` -- start(proof) -> `Active` -- counter(newer proof of the starter) -> `Active` -- finalize (three paths:
timeout on the initial proof, timeout on the counter, the non-starter adopting a newer proof at once) -> `NoDispute` with the epoch
advanced (C1) and collateral emptied. A clause pays iff its secret is on the chain by its deadline (E6), and a finalize over an open
clause waits for the deadline (H1). The honest side answers within `REACT`; an absent honest side can lose and is excluded from P1.

Properties: `p1_allowed` (what settles is a proof the honest side consented to or holds as its own latest), `p1_clause` (an honest
payee that learned the secret `LAG` before the deadline is paid), `p3_conserved` (money is conserved), `nonce_monotone`,
`no_double_settle`, `debt_only_when_broke`. 26 mutants.

## Settlement (`settle.qnt`)

The off-chain epoch: frames are Pay, Lock or Rebase; a cooperative update folds a settlement into the next epoch. Every frame
co-signs a baseline of epoch + 1 at nonce + 3 (S3, `BASELINE_GAP`), so after a finalize the honest side already holds a proof of the new
epoch. Properties: `no_dead_commit`, `no_lost_pay`, `claims_conserved`, `book_enforceable`, `hostage_free`, `baseline_clears`.
20 mutants.

## Entity (`entity.qnt`)

A hub with two Accounts (IN: the peer pays us; OUT: we pay on), both peers adversarial. One frame is four phases over one
state: (1) inputs (peer frames and acks first, then chain events: E1), (2) hooks read the state after the input (resolve, expire, route, fail back, escalate, reveal), (3) an atomic
signed command, (4) propose one frame per Account in ascending order.

Own dispute start: `Idle -> await -> {DisputeStarted: ours is open | DisputeOpSkipped: the peer's is open and ours is skipped}` (E12).

Route per slot: `Idle -> Fwd -> {Paid | Back}`. Rules: onward deadline = inbound - HOP; escalate `ESC` before a deadline; fail back only
when the onward lock is gone from a signed state or the deadline + LAG passed with the secret unknown; a dispute carries every known
payee secret; a dispute freezes the Account's frames.

Properties: `no_peer_halt`, `no_stranded`, `deadline_chain`, `dispute_carries_all`, `no_needless_dispute`, `no_frame_on_frozen`,
`cmd_atomic`, `credit_holds`, `route_safe` (the hub is never out of pocket), `answer_in_window`, `skip_ends_the_wait`. 20 mutants.

## J batch (`jbatch.qnt`)

State: the chain's stored nonce and reserve, the signed batches the Entity submitted (each with a nonce and a set of ops), the ops
(payment, secret reveal, dispute step). A batch lands iff its nonce is the next and no op reverts; a signed batch never expires.
Rules (J1 to J3, F1, R-SPLIT): abandon an op only when it can never apply; urgent ops (dispute, reveal, hash ladder) never share a batch with payment, settlement or reserve ops (R-SPLIT); **a signed batch is final at its
nonce: never sign other content at a signed nonce, every replacement goes to a fresh one** (F1). J2 (accepted): dispute ops skip instead of reverting, and the chain emits `DisputeOpSkipped(sender, counterentity, op, reason, nonce)`; the Entity abandons the op on reading it.

Properties: `urgent_lands`, `dropped_only_dead`, `skip_read`, `failed_read`, `no_burn`, `nonce_final`, `pay_once`, `urgent_once`, `nonce_sequential`, `reserve_sound`. 11 mutants.

## Runtime (`runtime.qnt`)

State: memory, the durable copy, the inbox, the chain head, what the peer has received. One frame = apply, persist, send; a crash
can come between any two steps. Rules (R1 to R5): canonical order (peers, then chain events, then commands), idle gate, cursor moves with the frame that applies the event (every kind of event, `DisputeOpSkipped` included: R7),
durable before send, command acknowledged only when durable, a closed list of local halt causes.

Properties: `no_equivocation`, `exactly_once_j`, `acked_durable`, `canonical_frames`. 8 mutants.

## What the spec asks of the contracts

| id | request | why | evidence |
|---|---|---|---|
| C1, C2, H1, H2 | done in the fork (`contracts/`) | see plan/contracts-review.md | chain mutants |
| C11 (accepted) | each dispute window above `LAG` (the floor of 60 s meets it while a J event is read and included in under 60 s) | the honest side needs `REACT` | `window-floor-below-react` |
| J2 (accepted) | dispute ops (start, counter, finalize, reveal) skip instead of revert, and an op that already ran is a no-op | a revert takes the urgent ops of the batch with it | `contract-reverts-on-moved-dispute` |
| J5 (accepted, as built) | a batch with no dispute, reveal or hash-ladder op that fails takes its nonce, applies nothing and emits `BatchFailed`; a mixed batch still reverts whole; a failure that leaves under 1/32 of the gas reverts instead | F1 forbids signing other content at an open nonce, so a batch that reverts holds every batch above it | `payment-revert-keeps-the-nonce` |
| E6 | a secret revealed before the deadline pays at finalize even when the dispute starts later | the Entity relies on it | pinned on the real contracts (#47) |

## What is not in it yet

Several tokens and swaps (v2), the order book, lending, boards (v2), the joint state of the hub's two Accounts and the chain with
real Account histories, several routes per slot, an offline Entity. See PROGRESS.md "Next".
