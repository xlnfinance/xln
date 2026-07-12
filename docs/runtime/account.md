# Account Machine

[Up: entity machine](./entity.md) | [Transactions](./account-transactions.md) | [Protocol primitives](./protocol.md) | [Dispute arguments](../security/dispute-two-arguments-spec.md)

The A-machine is bilateral state between two entities. `leftEntity` is always the lexicographically lower ID. A frame may carry an ACK plus an optional new proposal; frame Hanko and optional dispute seal are separate commitments.

## Source

- [`runtime/account-consensus.ts`](../../runtime/account-consensus.ts) - bilateral validation and commit facade.
- [`runtime/account/consensus/`](../../runtime/account/consensus) - proposal, frame, deadline, flush, and dispute policies.
- [`runtime/account/tx/apply.ts`](../../runtime/account/tx/apply.ts) - account transaction dispatcher.
- [`runtime/account/tx/handlers/`](../../runtime/account/tx/handlers) - payments, HTLC, pulls, swaps, settlement.
- [`runtime/account/state-root.ts`](../../runtime/account/state-root.ts) - canonical account-state commitment.

## Main Methods

- `proposeAccountFrame(env, account, jHeight)` - executes mempool txs and signs a new frame.
- `applyAccountInput(env, account, input, context)` - validates ACK/proposal and commits locally.
- `validateAccountFrame(frame)` / `createFrameHash(frame)` - canonical frame checks and hash.
- `getIncomingAccountDeadlineViolation(...)` - receiver-local financial deadline preflight.
- `applyAccountTx(account, tx, context)` - deterministic financial state transition.
- `computeAccountStateRoot(account)` - commits bilateral state, excluding mempool and signatures.

## Invariant

The receiver validates against local entity time and finalized J-height where financial enforcement windows matter. Peer-controlled frame time is ordering metadata, not authority over local deadlines.
