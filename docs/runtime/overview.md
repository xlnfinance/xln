# Runtime code map

**Role:** source-reading guide
**Audience:** protocol implementers and auditors
**Authority:** current source paths, enforced by `check:runtime-doc-paths`

The `core/` tree contains three nested state machines and the infrastructure
that drives them. Read the cascade before the services around it.

## The 90-minute path

### 1. Vocabulary and commitments

1. `core/runtime/types.ts` — Runtime Input, Tx, Frame, and live replica.
2. `core/entity/types.ts` — Entity State, candidate, Frame, and replica.
3. `core/types/account.ts` — Account State, replica, Input, Tx, and Frame.
4. `core/account/commitment/state-root.ts` — the exact bilateral commitment.
5. `core/entity/consensus/state-root.ts` — Entity commitment, including the
   deterministic Account-replica projection.

### 2. One input through all three machines

6. `core/runtime/frame/process.ts` — the visible Runtime coordinator.
7. `core/runtime/frame/lifecycle/prepare.ts` — detach one immutable Runtime input.
8. `core/runtime/frame/apply.ts` — apply Runtime and routed Entity work.
9. `core/entity/consensus/input/consensus.ts` — the Entity entry point.
10. `core/entity/consensus/frame/application.ts` — replay a candidate.
11. `core/account/consensus/index.ts` — the Account entry point.
12. `core/account/tx/apply.ts` — validate one Account transaction.
13. `core/account/tx/mutation.ts` — mutate Account-owned financial state.

### 3. Certification and failure

14. `core/entity/consensus/proposal/start.ts` — one canonical proposal builder;
    a one-member board seals its own quorum without a second implementation.
15. `core/entity/consensus/proposal/precommit-input.ts` — multi-validator
    precommit collection and threshold certification.
16. `core/account/consensus/incoming/collision.ts` — deterministic same-height
    LEFT-wins rollback.
17. `core/account/consensus/incoming/ack-commit.ts` — bilateral commit.
18. `core/runtime/frame/lifecycle/storage-failure.ts` — pre/post-WAL failure rules.
19. `core/storage/commit/commit.ts` — the only durable Runtime commit point.
20. `core/storage/recovery/journal/replay.ts` — rebuild from durable truth.

### 4. External settlement

21. `core/jurisdiction/machine/history-consensus/index.ts` — certified J-prefix facts.
22. `core/jurisdiction/adapter/events/ingress-transform.ts` — external evidence boundary.
23. `core/entity/tx/j-events.ts` — certified J effects enter Entity.
24. `core/account/settlement/j-finality.ts` — Account-owned settlement finality.
25. `core/runtime/j-submit/j-submit.ts` — durable post-frame submission lifecycle.

## Folder ownership

| Folder | Owns | Must not own |
|---|---|---|
| `core/runtime/` | Runtime input, frame, WAL ordering, routing | Entity/Account financial rules |
| `core/entity/` | Entity transactions, candidates, Hanko consensus | physical storage or transport |
| `core/account/` | bilateral consensus and every money mutation | Entity/Runtime orchestration |
| `core/jurisdiction/machine/` | deterministic J protocol facts | RPC/provider behavior |
| `core/jurisdiction/adapter/` | chain reads, authenticated receipts, submissions | consensus authority |
| `core/storage/` | current state, WAL, history views, replay | protocol decisions |
| `core/network/p2p/` | Runtime-to-Runtime delivery | financial state |
| `core/network/relay/` | discovery and market relay services | Runtime consensus |
| `core/api/public/` | public typed Runtime surface | service lifecycle |
| `core/api/server/` | HTTP/WebSocket delivery | process orchestration |
| `core/orchestrator/` | process startup and service composition | reducer logic |
| `core/api/runtime-adapter/` | frontend projections and commands | direct state mutation |
| `core/watchtower/` | encrypted appointments and chain action | spend-capable user keys |
| `core/qa/` | diagnostics and human-readable state dumps | protocol behavior |

## The three commit boundaries

```text
Runtime
  one local writer
  Input → apply owned state → WAL → publish → effects

Entity
  validator set
  Input → isolated candidate → Hanko certificate → install → outputs

Account
  two peers
  Input → isolated candidate → bilateral ACK → install → outputs
```

`*State` is frame-committed deterministic data. `*Replica` is the live instance
that also owns the next candidate, mempool, certification, retry, or delivery
metadata. `*Machine` describes transition logic; it is not a data type.

Runtime is locally single-writer, not concurrent consensus. Entity consensus
may be single-signer or multi-signer. Account consensus is always bilateral.
The common vocabulary must not hide these different trust boundaries behind a
generic base class.

## Visibility and failure

- Public API and UI read only the last WAL-committed Runtime frame.
- A candidate is not history and is never a public balance.
- Before WAL, a rejected input is absent from public history.
- Any programming/storage doubt after owned-state mutation halts reads and
  reloads durable truth.
- After WAL, the frame exists even if notification or delivery fails; effects
  retry without reclassifying the commit.
- RPC and transport observations become authority only after decoding,
  authentication, deterministic input construction, and frame commit.

## Executable reading traces

- `core/__tests__/runtime/commit/runtime-frame-atomicity.test.ts` — mutation/WAL/read
  barriers and input recovery.
- `core/scripts/operations/persistence/persistence-simultaneous-proposal-smoke.ts` — Account
  collision, rollback ordering, and LEFT wins.
- `core/__tests__/account/consensus/account-frame-integrity.test.ts` — exact frame validation.
- `core/__tests__/finance/state/derive-delta-property.test.ts` — the single balance model.
- `core/__tests__/storage/runtime/storage-canonical-hash.test.ts` — durable canonical bytes.
- `core/__tests__/security/authority/multisig-secondary-hanko.test.ts` — candidate
  certification.

## Supporting guides

- [Runtime machine](./runtime.md)
- [Entity machine](./entity.md)
- [Account machine](./account.md)
- [Jurisdiction machine](./jurisdiction.md)
- [Protocol primitives](./protocol.md)
- [Storage](./storage.md)
- [Networking](./networking.md)
- [Server](./server.md)
- [Jurisdiction adapter](./jadapter.md)
- [Recovery](./recovery.md)
- [Watchtower](./watchtower.md)

Generated bindings live under `jurisdictions/typechain-types/`. Scenario,
benchmark, QA, and archived files are valuable evidence but are not protocol
authority.
