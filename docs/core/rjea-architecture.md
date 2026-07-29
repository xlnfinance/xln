# Runtime → Entity → Account → Jurisdiction

**Role:** canonical architecture reference
**Status:** live
**Audience:** core protocol implementers and auditors

xln is a hierarchy of deterministic financial state machines. Every layer uses
the same nouns and transition direction, but each layer has a different trust
and commit boundary.

## Canonical vocabulary

| Layer | Live replica | Committed state | Input | Transaction | Frame | Output |
|---|---|---|---|---|---|
| Runtime | `RuntimeReplica` | `RuntimeState` | `RuntimeInput` | `RuntimeTx` | `RuntimeFrame` | `RuntimeOutput` |
| Entity | `EntityReplica` | `EntityState` | `EntityInput` | `EntityTx` | `EntityFrame` | `EntityOutput` |
| Account | `AccountReplica` | `AccountState` | `AccountInput` | `AccountTx` | `AccountFrame` | `AccountOutput` |
| Jurisdiction | J adapter/replica | J state | `JInput` | `JTx` | J block | J event |

The common shape is:

```text
(replica, input) → { replica, outputs }
```

- An input controls exactly one machine.
- Transactions inside the input request that machine's state transitions.
- Deterministic outputs bubble to the parent machine.
- Only Runtime interprets committed outputs as external effects.
- External effects run only after the Runtime frame is durable in WAL.

Entity application outputs commit destination Entity plus payload, not
validator topology. Runtime converts them to exact signer-addressed
`EntityInput` values inside the Runtime candidate and publishes them only after
the WAL commit. Validator-consensus messages that already target a specific
replica keep that exact signer.

The shared vocabulary does not imply a shared base class or generic reducer.
Runtime, Entity and Account have different consensus and failure boundaries.

## State is not the machine

`*State` is deterministic data committed by the corresponding frame.

The replica envelope owns everything required to build, certify,
deliver or retry the next frame:

- mempool and in-flight input;
- candidate execution;
- proposal, precommits, certificate or bilateral ACK;
- resend and reliable-delivery metadata;
- transport, watchdog and retry state;
- WAL, database and adapter handles.

These envelope fields must not silently enter a state root.

Target ownership:

```text
RuntimeReplica
  committed: RuntimeState
  mempool: RuntimeInput
  WAL / outbox / lifecycle

EntityReplica
  committed: EntityState
  mempool: EntityTx[]
  candidate / precommits / certificate

AccountReplica
  committed: AccountState
  mempool: AccountTx[]
  candidate / pending ACK / resend metadata
```

## Nested input cascade

```text
RuntimeInput
  ├─ RuntimeTx[]
  └─ routed EntityInput[]

EntityInput
  ├─ EntityTx[]
  └─ Entity consensus evidence

EntityTx
  ├─ Entity-owned operation
  ├─ accountInput
  │    └─ exact child AccountPeerInput
  │         └─ frame | ack | frame_ack | dispute | board_reseal | settle
  └─ financial intent
       └─ produces AccountInput.txs(AccountTx[]) locally for a future AccountFrame
```

The Account entrypoint is one union:

```typescript
type AccountInput =
  | { kind: 'txs'; txs: AccountTx[] }
  | AccountPeerInput;
```

Every branch enters `applyAccountInput`. The local `txs` branch is never sent
to a peer. Peer branches preserve their exact signed bilateral payload.

`*Replica` names live data. `*Machine` names deterministic transition logic or
its module; it is never a state interface.

## Commit models

### Runtime

Runtime has one writer and no external proposer consensus. It snapshots one
live mempool, applies one deterministic frame and commits at WAL.

```text
take input → apply → WAL commit → install/publish → dispatch effects
```

Before WAL, a failed mutation may only be discarded or followed by
halt-and-reload. After WAL, delivery is retryable but the frame is committed.

### Entity

The proposer executes a candidate without replacing committed `EntityState`.
Validators replay the exact transactions and sign the exact frame and secondary
hash manifest. The candidate installs only after certification.

Single-signer Entity uses the same pipeline with an immediate local
certificate. It is not a separate transition semantics.

### Account

Account is bilateral. A proposer builds an `AccountFrame` from local
`AccountTx[]`; the peer independently replays and validates it. Committed
`AccountState` changes only when the bilateral frame/ACK protocol allows it.

An `AccountInput` may acknowledge one frame and propose the next frame in the
same message. The ACK and proposal bind different state epochs and therefore
retain separate commitments.

## Determinism and performance

The RJEA cascade is replayable:

```text
(previous machine, exact input) → byte-identical next machine and outputs
```

- Use frame timestamps, never wall-clock time, inside state transitions.
- Preserve input and transaction order exactly.
- Canonicalize and sort only where the protocol explicitly requires it.
- Never read live contracts or RPC as reducer authority; authenticated events
  enter through inputs.
- Clone only an isolated candidate or touched child state.
- A Runtime frame touching one Entity/Account must not clone every unrelated
  replica.
- Performance work requires byte-identical differential roots plus measured
  clone/apply/WAL counters.

## Folder ownership

- `runtime/runtime/`: Runtime machine, WAL boundary and output planning.
- `runtime/entity/`: Entity transactions, candidate execution and validator
  consensus.
- `runtime/account/`: Account transactions, bilateral consensus and financial
  state roots.
- Adapters, transport, persistence, UI and QA remain outside those state
  machine folders.

Money moves only through Account-owned transaction handlers. Entity authorizes
and routes; Runtime orchestrates and persists.
