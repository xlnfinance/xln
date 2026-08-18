# Entity Machine

[Up: runtime machine](./runtime.md) | [Down: account machine](./account.md) | [Side: jurisdiction machine](./jurisdiction.md) | [Transactions](./entity-transactions.md)

The E-machine is replicated state owned by one entity board. The proposer builds an entity frame; every validator replays the same transactions, rebuilds every emitted secondary hash locally, and signs only an exact manifest match.

## Source

- [`core/entity/consensus/index.ts`](../../core/entity/consensus/index.ts) - public consensus facade.
- [`core/entity/consensus/input/consensus.ts`](../../core/entity/consensus/input/consensus.ts) - proposal, precommit, timeout, and commit-input flow.
- [`core/entity/consensus/frame/application.ts`](../../core/entity/consensus/frame/application.ts) - deterministic committed-frame application.
- [`core/entity/consensus/`](../../core/entity/consensus) - frame hash, input merge, Hanko witness manifest.
- [`core/entity/tx/apply.ts`](../../core/entity/tx/apply.ts) - entity transaction dispatcher.
- [`core/entity/tx/handlers/`](../../core/entity/tx/handlers) - account, dispute, J-event, scheduler, and extension handlers.
- [`core/entity/scheduler/index.ts`](../../core/entity/scheduler/index.ts) - canonical jobs and crontab execution.

## Main Methods

- `applyEntityInput(env, replica, input)` - proposer/validator entrypoint for entity ingress.
- `applyEntityFrame(env, replica, frame)` - replay, verify, and commit a proposed frame.
- `createEntityFrameHash(frame)` - canonical entity-frame commitment.
- `buildEntityHashesToSign(...)` - locally rebuilds the ordered secondary signature manifest.
- `applyEntityTx(state, tx, env)` - pure dispatcher for one entity transaction.
- `mergeEntityInputs(inputs)` - canonical input deduplication and wake ordering.

## Invariant

Validators never sign proposer-supplied secondary hashes blindly. Local replay must emit the same ordered `(type, context, hash)` manifest or the frame fails.
