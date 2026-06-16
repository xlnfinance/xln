# Two-Argument Dispute Arguments Specification

Status: implemented
Scope: jurisdiction contracts, runtime account consensus, watchtower, dispute tests

## Summary

Current dispute finalization binds the signed state by `proofbodyHash`, but transformer
arguments are supplied later as mutable calldata. The runtime can currently build those
arguments from the live account machine while the contract finalizes an older stored
`ProofBody`. That is safe only for non-positional arguments.

This specification adds two precommitted starter argument sets:

- `starterInitialArguments`: starter-side arguments for the proof used to start the
  dispute.
- `starterIncrementedArguments`: starter-side arguments for the one newer state that the
  starter knows it already signed and sent to the counterparty.

If the dispute is finalized on the initial proof, the contract uses
`starterInitialArguments`. If the counterparty counters with the newer proof, the contract
uses `starterIncrementedArguments`. The counterparty still supplies its own side arguments at
finalization.

## Pre-Patch Code Facts

- Before V2, `jurisdictions/contracts/Types.sol:79` had `InitialDisputeProof` with only
  `initialArguments`.
- Before V2, `jurisdictions/contracts/Types.sol:87` had `FinalDisputeProof` with only
  `finalArguments` and `initialArguments`.
- Before V2, `jurisdictions/contracts/Account.sol:66` hashed only `initialArguments` into
  `disputeHash`.
- Before V2, `jurisdictions/contracts/Account.sol:402` stored that hash at dispute start
  and `jurisdictions/contracts/Account.sol:412` emitted only `initialArguments`.
- Before V2, `jurisdictions/contracts/Depository.sol:859` verified the stored dispute hash with only
  `initialArguments`.
- Before V2, `jurisdictions/contracts/Depository.sol:891` passed `finalArguments` and
  `initialArguments` into `_finalizeAccount`.
- Before V2, `runtime/entity-tx/handlers/dispute.ts:425` built `initialArguments` from the current
  `AccountMachine`.
- Before V2, `runtime/entity-tx/handlers/dispute.ts:447` then used a stored
  `counterpartyDisputeProofBodyHash`, so the arguments and proof body can be from
  different heights.
- Before V2, `runtime/entity-tx/handlers/dispute.ts:777` built `finalArguments` from the current
  `AccountMachine`, while `runtime/entity-tx/handlers/dispute.ts:805` could finalize using a
  stored proof body.
- Before V2, `runtime/entity-tx/j-events.ts:528` stored only `activeDispute.initialArguments`.
- Before V2, `runtime/watchtower/action.ts:198` reimplemented the same one-argument dispute hash.

## Bug Class

Severity: high for swaps and pulls, medium for HTLC-only proofs.

Root cause:

- Dispute signatures bind `(nonce, proofbodyHash)`.
- Transformer arguments are not part of that signed proof.
- The on-chain `disputeHash` currently commits only one late argument blob.
- Runtime argument builders walk the current mutable account state, not the exact stored
  proof body that will be finalized.

Why HTLC is less affected:

- `jurisdictions/contracts/DeltaTransformer.sol:195` matches HTLC secrets by
  `keccak256(secret) == hashlock`.
- A positional drift cannot directly apply an HTLC secret to a different hashlock.
- Missing or late secrets can still underclaim, but they do not usually cross-apply.

Why swaps and pulls are affected:

- `jurisdictions/contracts/DeltaTransformer.sol:123` consumes swap fill ratios by side
  position.
- `jurisdictions/contracts/DeltaTransformer.sol:144` consumes pull arguments by side
  position.
- `runtime/proof-builder.ts:165` orders swaps by active `offerId`.
- `runtime/proof-builder.ts:186` orders pulls by active `pullId`.
- `runtime/account-tx/handlers/swap-resolve.ts:392` can delete terminal swaps.
- `runtime/account-tx/handlers/pull.ts:258` and `runtime/account-tx/handlers/pull.ts:325`
  can delete pulls.

Impact:

- A starter can provide arguments for height `N`, but the counterparty can counter with
  height `N+1`, making the same positional arrays refer to different swaps or pulls.
- A valid partial pull/swap reveal can be ignored, or a different reveal slot can be used.
- Cross-jurisdiction source/target pull settlement can underclaim or settle the wrong
  committed progress if the route state changed between signed heights.

## Design Goals

- No extra dispute round.
- No silent fallback, repair, or rehydration.
- Preserve the fast one-proof path when no newer signed state is known.
- Bind all starter-side arguments that can be used later.
- Keep Solidity deterministic and independent from runtime heuristics.
- Make argument side mapping explicit; do not rely on ambiguous
  `finalArguments`/`initialArguments` role naming.

## Non-Goals

- Supporting an arbitrary number of future signed states.
- Migrating all transformer arguments to keyed, non-positional Solidity encoding.
- Hiding dispute calldata from the chain.
- Recovering from missing proof-body snapshots. Missing snapshot remains fatal.

## Protocol Invariant

At `disputeStart`, the starter must know at most one higher state that it signed and that
the counterparty may use for counter-dispute.

Valid cases:

- No known higher signed state: `starterIncrementedArguments = 0x`.
- One known higher signed state: `starterIncrementedArguments` is built for that exact state.

Invalid case:

- More than one higher signed state can be used by the counterparty and runtime cannot
  prove which one is latest.

Required runtime behavior for invalid case:

- Do not start dispute with guessed arguments.
- Throw or mark account as requiring a larger dispute bundle design.
- Do not downgrade to current-state argument building.

## Solidity API V2

Use clearer field names in V2. The old names can be preserved internally only if the ABI
must stay close to existing tests, but new code should treat them as deprecated aliases.

```solidity
struct InitialDisputeProofV2 {
  bytes32 counterentity;
  uint nonce;
  bytes32 proofbodyHash;
  bytes sig;
  bytes starterInitialArguments;
  bytes starterIncrementedArguments;
}

struct FinalDisputeProofV2 {
  bytes32 counterentity;
  uint initialNonce;
  uint finalNonce;
  bytes32 initialProofbodyHash;
  ProofBody finalProofbody;
  bytes leftArguments;
  bytes rightArguments;
  bytes starterInitialArguments;
  bytes starterIncrementedArguments;
  bytes sig;
  bool startedByLeft;
  uint disputeUntilBlock;
  bool cooperative;
}
```

Rationale for explicit `leftArguments` and `rightArguments`:

- `_finalizeAccount` ultimately consumes left/right transformer arguments.
- Existing `finalArguments` and `initialArguments` names are role-dependent and easy to
  misuse when the caller is the starter, the counterparty, or a watchtower.
- Explicit side fields make the counter path checkable without guessing who supplied
  which blob.

## Dispute Hash V2

Replace the current one-argument hash:

```solidity
keccak256(abi.encodePacked(
  nonce,
  startedByLeft,
  timeout,
  proofbodyHash,
  keccak256(initialArguments)
))
```

with:

```solidity
keccak256(abi.encodePacked(
  nonce,
  startedByLeft,
  timeout,
  proofbodyHash,
  keccak256(starterInitialArguments),
  keccak256(starterIncrementedArguments)
))
```

Rules:

- Empty `starterIncrementedArguments` is `0x`, not omitted.
- `keccak256(bytes(""))` is the committed empty value.
- Finalization must recompute the stored dispute hash using both starter argument blobs.
- Any mismatch is fatal and reverts with the same class as the existing `E9` hash mismatch.

## Contract Flow

### disputeStart

Inputs:

- Counterparty signature over the initial dispute proof body hash, as today.
- `starterInitialArguments` for the initial proof.
- Optional `starterIncrementedArguments` for the one newer state the starter already signed.

Contract behavior:

- Verify `params.sig` against `(nonce, proofbodyHash)` as today.
- Store `disputeHashV2(initialNonce, startedByLeft, timeout, initialProofbodyHash,
  starterInitialArguments, starterIncrementedArguments)`.
- Emit `watchSeed` and both argument blobs in `DisputeStarted`.

Event:

```solidity
event DisputeStarted(
  bytes32 indexed sender,
  bytes32 indexed counterentity,
  uint indexed nonce,
  bytes32 proofbodyHash,
  bytes32 watchSeed,
  bytes starterInitialArguments,
  bytes starterIncrementedArguments
);
```

### unilateral finalize on initial proof

Condition:

- `params.sig.length == 0`.
- `keccak256(abi.encode(params.finalProofbody)) == params.initialProofbodyHash`.
- Timeout rules remain unchanged.

Argument check:

- Derive `starterIsLeft = params.startedByLeft`.
- Require the starter side argument in `leftArguments/rightArguments` to equal
  `starterInitialArguments` by hash.
- The non-starter side can be supplied by the finalizer, or be empty.

Finalization:

- Apply `finalProofbody` with `leftArguments/rightArguments`.
- `starterIncrementedArguments` is only used to verify the stored dispute hash.

### counter finalize on newer proof

Condition:

- `params.sig.length > 0`.
- `params.finalNonce > storedNonce`.
- `params.finalNonce > params.initialNonce`.
- Counterparty signature verifies against `keccak256(abi.encode(params.finalProofbody))`.

Argument check:

- Derive `starterIsLeft = params.startedByLeft`.
- Require the starter side argument in `leftArguments/rightArguments` to equal
  `starterIncrementedArguments` by hash.
- If `starterIncrementedArguments == 0x`, the starter side argument for the counter proof must
  be empty.
- Do not reuse `starterInitialArguments` for the newer proof.

Finalization:

- Apply `finalProofbody` with `leftArguments/rightArguments`.
- The counterparty supplies its own side arguments in the opposite side field.

## Solidity Files To Change

- `jurisdictions/contracts/Types.sol`
  - Add V2 structs or replace current `InitialDisputeProof` and `FinalDisputeProof`.
  - Preferred: replace in-place before production deployment; there is no safe mixed ABI.

- `jurisdictions/contracts/Account.sol`
  - Change `encodeDisputeHash`.
  - Change `_encodeDisputeHash`.
  - Change `_disputeStart` to hash and emit both starter argument blobs.
  - Add side-check helper:

```solidity
function _requireStarterArguments(
  bool startedByLeft,
  bytes memory leftArguments,
  bytes memory rightArguments,
  bytes memory expectedStarterArguments
) internal pure {
  bytes32 expected = keccak256(expectedStarterArguments);
  bytes32 actual = startedByLeft ? keccak256(leftArguments) : keccak256(rightArguments);
  if (actual != expected) revert E9();
}
```

- `jurisdictions/contracts/Depository.sol`
  - Update batch ABI structs.
  - Recompute `expectedHash` with both starter argument blobs.
  - In no-signature finalize, require starter side equals `starterInitialArguments`.
  - In counter finalize, require starter side equals `starterIncrementedArguments`.
  - Call the internal finalizer with explicit left/right mapping.

- `jurisdictions/contracts/Depository.sol`
  - Add or refactor helper so finalization can accept already side-normalized
    `leftArguments/rightArguments`, instead of role-normalized `arguments1/arguments2`.

## Runtime TypeScript Changes

### Types and ABI

- `runtime/j-batch.ts`
  - Add `starterInitialArguments` and `starterIncrementedArguments` to `disputeStarts`.
  - Replace `finalArguments` and `initialArguments` in `disputeFinalizations` with
    `leftArguments`, `rightArguments`, `starterInitialArguments`,
    `starterIncrementedArguments`.
  - Update `DEPOSITORY_BATCH_ABI`.

- `runtime/types/entity-tx.ts`
  - Extend `disputeStart.data` with optional `starterIncrementedArguments`.
  - Extend `disputeFinalize.data` only if manual override is still supported; default flow
    should build from stored proof argument plans.

- `runtime/types/account.ts`
  - Extend `activeDispute` with `starterInitialArguments` and
    `starterIncrementedArguments`.
  - Add a proof-hash keyed argument cache:

```ts
type DisputeArgumentSide = 'left' | 'right';

type DisputeArgumentSnapshot = {
  proofbodyHash: string;
  nonce: number;
  side: DisputeArgumentSide;
  arguments: string;
  proofBodyStruct: unknown;
};
```

Required invariant:

- If `disputeProofBodiesByHash[hash]` exists, the matching argument snapshot must also
  exist for every local side that may later start or answer a dispute.
- Missing argument snapshot for a required side is fatal.

### Argument builder

Current problem:

- `buildDeltaTransformerArguments(account, ...)` iterates live `locks`, `swapOffers`, and
  `pulls`.
- It should not be used to build arguments for an older `ProofBody`.

Required change:

- Add a builder that takes an exact stored proof body or stored argument plan:

```ts
buildDeltaTransformerArgumentsForProofBody({
  proofBodyStruct,
  side,
  evidence,
  fillRatiosByStableId,
  pullRevealsByCommitment,
  htlcSecretsByHashlock,
}): string
```

Rules:

- HTLC secrets are selected by `hashlock`.
- Swap ratios are selected by a stable swap identity captured when the proof body is
  created, not by the current `swapOffers` map position.
- Pull binaries are selected by `fullHash/partialRoot` or another stable pull identity
  captured in the argument plan, not by current `pulls` map position.
- The output array order must follow the target `ProofBody`, not current account state.

### Consensus metadata

- `runtime/account-consensus/propose.ts`
  - When creating `currentDisputeProofBodyHash`, also store the local side argument
    snapshot for that proof.

- `runtime/account-consensus.ts`
  - When receiving `newDisputeProofBodyHash`, store the counterparty signed hash as today.
  - When sending ACK plus a newer frame, mark that newer local signed proof as
    `counter-dispute-capable` because the counterparty may later use it.
  - If more than one higher counter-dispute-capable proof exists above the initial proof,
    fail dispute start unless a future multi-proof bundle is implemented.

### disputeStart handler

- `runtime/entity-tx/handlers/dispute.ts`
  - Replace current live-state `initialArguments` construction.
  - Select `initialProofbodyHash = account.counterpartyDisputeProofBodyHash`.
  - Build `starterInitialArguments` for that exact hash.
  - Find the latest known local signed proof with nonce `> initialNonce` that was sent to
    the counterparty.
  - If exactly one exists, build `starterIncrementedArguments` for that hash.
  - If none exists, use `0x`.
  - If more than one exists and latest cannot be proven unique, abort loudly.
  - Queue `disputeStarts` with both starter argument blobs.

### disputeFinalize handler

- `runtime/entity-tx/handlers/dispute.ts`
  - Use `account.activeDispute.starterInitialArguments` and
    `account.activeDispute.starterIncrementedArguments`.
  - If finalizing the initial proof, build the caller/opponent side fields for the initial
    proof and ensure the starter side equals `starterInitialArguments`.
  - If countering with a newer signed proof, build side fields for the newer proof and
    ensure the starter side equals `starterIncrementedArguments`.
  - Never build finalization arguments from current account state when `finalProofbody` is
    taken from `disputeProofBodiesByHash`.

### J-events

- `runtime/entity-tx/j-events.ts`
  - Parse `DisputeStarted`.
  - Store both starter argument blobs in `activeDispute`.
  - Store the revealed `watchSeed` for last-resort dispute protection.
  - Do not treat `starterIncrementedArguments` as active source-pull evidence until a counter
    finalization path actually uses the newer proof.

### Watchtower and recovery

- `runtime/watchtower/action.ts`
  - Update `DEPOSITORY_MINIMAL_ABI`.
  - Update `encodeDisputeHash`.
  - Parse `DisputeStarted`.
  - Include both starter argument blobs in `ActiveDisputeContext`.
  - Submit `leftArguments/rightArguments/starterInitialArguments/starterIncrementedArguments`.

- `runtime/recovery/types.ts`
  - Version the tower remedy payload.
  - Add current dispute fields.
  - Reject counter-dispute remedies that do not bind the revealed `watchSeed`.

- `docs/recovery-watchtower-protocol.md`
  - Update the tower payload and hash formula.

## Why Solidity Does Not Need Counter Proof Body Hashes

The contract already receives the actual `finalProofbody` during finalization and verifies
its signature on the counter path. The argument ambiguity is not "which final body exists";
it is "which starter-side argument blob is valid for that final body".

Therefore Solidity only needs:

- `initialProofbodyHash`, already committed at dispute start.
- `starterInitialArguments` hash.
- `starterIncrementedArguments` hash.
- `finalProofbody` plus signature on counter finalization.

Runtime still should store the expected counter proof body hash for fail-fast checks, but
that is local safety metadata, not on-chain consensus data.

## Required Tests

### Contract tests

- `jurisdictions/test/Depository.ts`
  - Start dispute with `starterInitialArguments=A`, `starterIncrementedArguments=B`.
  - Unilateral finalize initial proof succeeds only when starter side args hash to `A`.
  - Unilateral finalize initial proof reverts when starter side args hash to `B`.
  - Counter finalize newer proof succeeds only when starter side args hash to `B`.
  - Counter finalize newer proof reverts when starter side args hash to `A`.
  - Recomputed dispute hash fails if either `A` or `B` is changed.

- `jurisdictions/test/DeltaTransformer.test.ts`
  - Build two proof bodies with different pull/swap positional order.
  - Show old behavior would apply the wrong positional argument.
  - Show V2 left/right arguments apply the intended proof-specific slot.

### Runtime unit tests

- `runtime/__tests__/dispute-two-arguments.test.ts`
  - `disputeStart` queues `starterIncrementedArguments=0x` when no newer local signed state
    exists.
  - `disputeStart` queues non-empty `starterIncrementedArguments` when exactly one newer
    local signed state was sent.
  - `disputeStart` aborts when two possible newer local signed states exist and runtime
    cannot prove uniqueness.
  - `disputeFinalize` uses stored proof-body keyed arguments, not current account state.

- `runtime/__tests__/cross-jurisdiction-security.test.ts`
  - Cross-j target/source pull dispute uses arguments for the exact source/target proof
    body hash.
  - Deleting a terminal pull after signing a newer state does not shift an older proof's
    pull argument slot.

- `runtime/__tests__/watchtower-rpc-last-resort.test.ts`
  - Tower parses `DisputeStarted`.
  - Tower hash check includes both starter argument blobs.
  - Tower counter-dispute submits the V2 final proof shape.

### E2E tests

- `tests/e2e-dispute.spec.ts`
  - UI dispute lifecycle still queues, broadcasts, and finalizes the current dispute shape.

- `tests/e2e-cross-j-swap.spec.ts`
  - Create a cross-j partial fill.
  - Sign a newer state.
  - Delete or mutate a pull/swap on the starter side.
  - Start dispute from the older proof.
  - Counter with the newer proof.
  - Assert exact `orderId/routeId` and exact final balances, not "some partial route".

## Expected Before/After Test Behavior

Before patch:

- A counter-dispute can finalize a newer `finalProofbody` while reusing
  `initialArguments` from the older proof.
- Runtime can generate arguments from live account state and pair them with a stored proof
  body.
- Watchtower ignores the second starter argument set because it has no field for it.

After patch:

- Any changed starter argument blob changes `disputeHashV2` and reverts at finalization.
- Initial finalization and counter finalization select different precommitted starter-side
  blobs.
- Runtime cannot start a dispute unless it has exact proof-body keyed argument snapshots.
- Watchtower can counter-dispute without inventing or reordering arguments.

## Migration

This is an ABI break.

Required deployment rule:

- Do not mix V1 runtime with V2 contracts.
- Do not mix V2 runtime with V1 contracts unless jurisdiction metadata explicitly marks
  the chain as legacy and disables incremented arguments.

Recommended metadata:

```ts
type JurisdictionContractCapabilities = {
  disputeArgumentsVersion: 1 | 2;
  supportsStarterIncrementedArguments: boolean;
};
```

For testnet:

- Redeploy contracts.
- Regenerate type bindings.
- Update static ABI strings in runtime and tests.
- Reset local persisted runtime state that contains V1 pending dispute batches.

## Open Risks

- Calldata grows because the starter argument blobs are repeated at finalization.
- Revealing `starterIncrementedArguments` at dispute start can reveal future-state secrets or
  pull binaries earlier than strictly needed.
- A hash-only optimization is possible later:
  `disputeStart` commits `keccak256(starterIncrementedArguments)` and finalization supplies
  the bytes. That saves calldata and reduces early leakage, but it is a separate ABI and
  should not be mixed into this first patch.
- The two-state invariant must be enforced. If runtime has multiple higher signed states,
  the two-argument scheme is not enough; either fail closed or introduce a larger
  hash-keyed bundle.

## Implementation Order

1. Contracts: structs, hash formula, event, side-explicit finalization, contract tests.
2. Runtime ABI/types: `j-batch`, entity tx types, account active dispute state.
3. Argument snapshots: proof-body keyed builder and consensus metadata.
4. Dispute handlers: start/finalize selection logic.
5. J-events/watchtower/recovery: parse and submit V2.
6. E2E: exact order/route assertions for cross-j disputed partial fills.

## Acceptance Criteria

- `bun run check` passes.
- Contract tests prove `A` works for initial proof and `B` works for counter proof.
- Runtime tests prove no argument is built from live state for a stored proof body.
- Cross-j E2E proves exact disputed route/order settlement after partial fill and counter
  dispute.
- No silent fallback path converts missing snapshots or missing incremented arguments into
  `0x` except the explicit "no known newer signed state" case.
