# Entity Machine

[Up: runtime machine](./machine.md) | [Down: account machine](./account.md) | [Side: jurisdiction machine](./jurisdiction.md) | [Transactions](./entity-transactions.md)

The E-machine is replicated state owned by one entity board. The proposer builds an entity frame; every validator replays the same transactions, rebuilds every emitted secondary hash locally, and signs only an exact manifest match.

## Source

- [`runtime/entity-consensus.ts`](../../runtime/entity-consensus.ts) - consensus facade and commit flow.
- [`runtime/entity/consensus/`](../../runtime/entity/consensus) - frame hash, input merge, Hanko witness manifest.
- [`runtime/entity/tx/apply.ts`](../../runtime/entity/tx/apply.ts) - entity transaction dispatcher.
- [`runtime/entity/tx/handlers/`](../../runtime/entity/tx/handlers) - account, dispute, J-event, scheduler, and extension handlers.
- [`runtime/entity/scheduler.ts`](../../runtime/entity/scheduler.ts) - canonical jobs and crontab execution.

## Main Methods

- `applyEntityInput(env, replica, input)` - proposer/validator entrypoint for entity ingress.
- `applyEntityFrame(env, replica, frame)` - replay, verify, and commit a proposed frame.
- `createEntityFrameHash(frame)` - canonical entity-frame commitment.
- `buildEntityHashesToSign(...)` - locally rebuilds the ordered secondary signature manifest.
- `applyEntityTx(state, tx, env)` - pure dispatcher for one entity transaction.
- `mergeEntityInputs(inputs)` - canonical input deduplication and wake ordering.

## Invariant

Validators never sign proposer-supplied secondary hashes blindly. Local replay must emit the same ordered `(type, context, hash)` manifest or the frame fails.
