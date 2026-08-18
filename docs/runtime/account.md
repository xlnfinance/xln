# Account Machine

[Up: entity machine](./entity.md) | [Transactions](./account-transactions.md) | [Protocol primitives](./protocol.md) | [Dispute arguments](../security/dispute-two-arguments-spec.md)

The A-machine is bilateral state between two entities. `leftEntity` is always the lexicographically lower ID. A frame may carry an ACK plus an optional new proposal; frame Hanko and optional dispute seal are separate commitments.

## Source

- [`core/account/consensus/index.ts`](../../core/account/consensus/index.ts) - bilateral validation and commit facade.
- [`core/account/consensus/`](../../core/account/consensus) - proposal, frame, deadline, flush, and dispute policies.
- [`core/account/tx/apply.ts`](../../core/account/tx/apply.ts) - account transaction dispatcher.
- [`core/account/tx/handlers/`](../../core/account/tx/handlers) - payments, HTLC, pulls, swaps, settlement.
- [`core/account/commitment/state-root.ts`](../../core/account/commitment/state-root.ts) - canonical account-state commitment.

## Main Methods

- `proposeAccountFrame(env, account, jHeight)` - executes mempool txs and signs a new frame.
- `applyAccountInput(env, account, input, context)` - validates ACK/proposal and commits locally.
- `validateAccountFrame(frame)` / `createFrameHash(frame)` - canonical frame checks and hash.
- `getIncomingAccountDeadlineViolation(...)` - receiver-local financial deadline preflight.
- `applyAccountTx(account, tx, context)` - deterministic financial state transition.
- `computeAccountStateRoot(account)` - commits bilateral state, excluding mempool and signatures.

## Invariant

The receiver validates against local entity time and finalized J-height where financial enforcement windows matter. Peer-controlled frame time is ordering metadata, not authority over local deadlines.
