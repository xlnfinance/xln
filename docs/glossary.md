# xln canonical glossary

This is the single vocabulary index for xln. It defines names, not new safety
rules. Normative TypeScript and state-machine safety remains in
[fints.md](fints.md); production execution invariants remain in
[runtime.md](runtime.md).

## Runtime → Entity → Account

| Layer | Live replica | Committed state | Input | Transaction | Frame |
|---|---|---|---|---|---|
| Runtime | `RuntimeReplica` | `RuntimeState` | `RuntimeInput` | `RuntimeTx` | `RuntimeFrame` |
| Entity | `EntityReplica` | `EntityState` | `EntityInput` | `EntityTx` | `EntityFrame` |
| Account | `AccountReplica` | `AccountState` | `AccountInput` | `AccountTx` | `AccountFrame` |

- **Replica** is the current live machine value. It includes committed state
  plus transient execution data required by future inputs.
- **State** is deterministic committed data owned by that layer.
- **Input** controls one transition of that layer and may contain its
  transactions and consensus evidence.
- **Transaction** requests a state change inside its owning layer.
- **Frame** is the committed result/boundary of a transition. `frame` is not a
  generic synonym for an input, transaction, proposal, batch or network row.
- **Output** returns from a child machine to its parent. Only Runtime converts a
  WAL-committed ordered outbox into external effects.

## Account consensus

- **Proposal** is a candidate `AccountFrame` sent to the counterparty for
  bilateral acceptance. A proposal is not itself a frame input type.
- **ACK** accepts the exact preceding proposal identified by its Account-frame
  height and hash.
- **`ack`** is an `AccountInput` carrying only an ACK.
- **`ack_frame`** is the only proposal-carrying `AccountInput` and is the
  superset form. When it carries an ACK, Account applies the ACK before the new
  proposal in the same transition.
- A standalone `AccountInput.kind = "frame"` is non-canonical and forbidden.
- **Wire tag / discriminator** is an internal binary-codec value, not a product
  concept or execution phase. The compact proposal/ACK wire has exactly two:
  tag `0` is `ack_frame` with an optional ACK; tag `1` is `ack`.
- **Hanko** is validator-quorum evidence over exact canonical bytes. It is not
  transport acknowledgement, delivery metadata or a second state root.
- **Account proposal work** is the final sharded Stage-3 row
  `{ accountId, accountTxs, forceAck }`. `forceAck` is transient: accepted or
  duplicate inbound proposals set it, the default is false, and it is never
  stored or committed. The Account worker alone reconstructs the exact ACK
  height/hash, frame Hanko and optional dispute proof from resident state.

## Entity financial sections

- **Paybook** is the only Entity-owned payment lifecycle, keyed by canonical
  `hashlock`. `lockBook`, `htlcRoutes` and payment projections are not separate
  canonical modules.
- **Orderbook** is the only Entity-owned representation of resting offers,
  price levels and matching state. One trading pair is one sequential
  price-time domain.
- **Crontab** owns deterministic scheduled work indexed by Runtime-frame time.
  It never uses wall-clock time or a full per-frame scan.
- **Account** remains the sole financial authority for bilateral balances,
  credit, locks, pending proposals, committed history and disputes. Entity
  sections emit `AccountTx`; they do not reproduce Account arithmetic.

## Execution and durability

- **Logical shard** is a canonical state partition independent of worker
  count. **Worker** is a physical CPU execution lane assigned logical shards.
- **Shared worker pool** is the one long-lived pool used across Account,
  Paybook, Orderbook and Crontab stages. It is not an actor system.
- **JOIN** is a dependency barrier between the three Runtime-frame stages; it
  is not another protocol round.
- **WAL** is Runtime's ordered durability authority together with the canonical
  checkpoint/state database.
- **Outbox** is the flat ordered external output of one sealed Runtime frame.
  It is published only after that frame is durable.

## Forbidden synonyms

- Do not use `channel`, `wave`, `round`, `receipt`, `delivery sequence` or
  `projection` as new names for canonical Runtime/Entity/Account values.
- `peer` may describe a transport counterparty only. It is never part of the
  canonical name `AccountInput`.
- Directional words such as inbound/outbound may describe movement at a
  boundary, but they never replace the canonical value name.
