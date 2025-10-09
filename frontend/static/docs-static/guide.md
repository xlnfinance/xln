# XLN Consensus System Development Guidelines

## Project Overview
XLN: The Organizational Layer for Digital Finance — Where TradFi meets DeFi. 

XLN delivers institutional-grade governance with crypto-native innovation through hierarchical state machines. Core functionality: propose→sign→commit flow with cryptographic hierarchies enabling both enterprise compliance and DeFi composability.

## Core Architecture Rules

### 1. State Management
- **Immutable at transaction level**: Each `applyEntityTx` creates new state objects
- **Mutable for performance**: Collections (mempool, signatures) use mutable operations within processing
- **Separate state types**: `EntityState` (consensus data) vs `ServerState` (infrastructure)
- **No shared state references**: Each replica gets its own state copy

### 2. Naming Conventions
- **Scope-specific prefixes**: `entityState`, `serverState`, `entityReplica`, `serverTx`
- **Clear intent**: `entityOutbox` (not `entityOutputs`), `ProposedEntityFrame` (not `Proposal`)
- **Descriptive variables**: `replicaKey`, `frameSignature`, `validatorId`, `proposerId`
- **Consistent terminology**: Always use "entity" for consensus layer, "server" for infrastructure

### 3. Function Design
- **Single responsibility**: `applyEntityTx` handles one transaction, `applyEntityFrame` handles batches
- **No double computation**: Pre-compute state in proposal, reuse in commit
- **Clear interfaces**: `ServerInput` separates `serverTxs` from `entityInputs`
- **Helper functions**: `processUntilEmpty` for iteration simplification

## Critical Bug Patterns & Fixes

### 1. Routing Bugs
**Problem**: Using `input.from` instead of `input.to` in message routing
**Fix**: Always route messages to intended recipients
```typescript
// ❌ Wrong - routes to sender
signerId: entityReplica.signerId

// ✅ Correct - routes to proposer
signerId: proposerId
```

### 2. Consensus Phantom
**Problem**: Each replica claiming to be proposer
**Fix**: Only first validator is proposer, others are validators
```typescript
isProposer: index === 0  // Only first validator
```

### 3. State Synchronization
**Problem**: Non-proposer validators not receiving commit notifications
**Fix**: Save proposal data before clearing, notify all validators
```typescript
// Save before clearing
const committedSignatures = Array.from(entityReplica.proposal.signatures);
const committedHash = entityReplica.proposal.hash;
entityReplica.proposal = undefined;

// Notify all validators
entityReplica.state.validators.forEach(validatorId => {
  entityOutbox.push({
    entityId: entityInput.entityId,
    signerId: validatorId,
    precommits: committedSignatures,
    proposedFrame: committedHash
  });
});
```

## Code Style Guidelines

### 1. Functional Programming
- **No classes**: Use interfaces and functions only
- **No CommonJS**: Always use ES modules (`import`/`export`)
- **Immutable patterns**: Create new objects instead of mutating existing ones
- **Pure functions**: `applyEntityTx`, `applyEntityFrame` have no side effects

### 2. Error Prevention
- **Strict typing**: Use TypeScript interfaces for all data structures
- **Validation**: Check thresholds, validate signatures, verify state transitions
- **Defensive programming**: Check existence before accessing (`entityReplica?.`)

### 3. Performance Considerations
- **Mutable collections**: Use `push()`, `set()`, `clear()` for performance-critical paths
- **Batch operations**: Use `leveldb batch()` for database operations
- **Efficient iteration**: `while (outputs.length > 0)` instead of manual stepping

## Testing & Debugging

### 1. Global Debug Pattern
```typescript
let DEBUG = true;
// Use throughout code without parameter passing
if (DEBUG) console.log(`→ Operation details`);
```

### 2. Comprehensive Logging
- **State transitions**: Log height changes, mempool operations
- **Message flow**: Track inputs/outputs with counts and types
- **Consensus progress**: Show signature collection, threshold reaching
- **Final verification**: Check all replicas have identical state

### 3. Test Verification
- **Always run**: `npm test` before returning results
- **State consistency**: Verify all replicas converge to same state
- **Message integrity**: Check transaction order and content
- **Consensus metrics**: Track completion time, message count

## Distributed System Patterns

### 1. Realistic Architecture
- **Separate server transactions**: Each validator gets own `importReplica` transaction
- **Transaction routing**: All transactions go through proposer for consensus
- **Validator coordination**: Proposer broadcasts to all validators

### 2. Consensus Flow
1. **Import phase**: Setup replicas with validator lists
2. **Propose phase**: Proposer creates frame, broadcasts to validators
3. **Sign phase**: Validators sign and send precommits to proposer
4. **Commit phase**: Proposer collects signatures, broadcasts final state
5. **Apply phase**: All replicas apply committed frame

### 3. State Management
- **Mempool**: Temporary transaction storage before consensus
- **Proposals**: Pending frames waiting for signature threshold
- **Committed state**: Final agreed-upon state across all replicas

## Development Workflow

### 1. Incremental Steps
- Start with minimal working version
- Add one feature at a time
- Verify each step before proceeding
- Test thoroughly at each stage

### 2. Code Evolution
- Begin with simple implementations
- Refactor for clarity and performance
- Remove redundant code and state
- Optimize critical paths

### 3. Documentation
- Log all significant operations
- Add comments for complex logic
- Maintain clear variable names
- Document interface contracts

## Financial System Considerations

### 1. Reliability
- **Byzantine fault tolerance**: Handle malicious validators
- **State consistency**: Ensure all replicas agree on final state
- **Transaction ordering**: Maintain deterministic sequence

### 2. Security
- **Signature validation**: Verify all precommits before accepting
- **Threshold enforcement**: Require minimum signatures for commits
- **State validation**: Check transaction validity before applying

### 3. Performance
- **Batch processing**: Group transactions for efficiency
- **Minimal state copying**: Only copy when necessary
- **Efficient data structures**: Use Maps for O(1) lookups

## Common Pitfalls to Avoid

1. **Shared state mutations**: Each replica needs independent state
2. **Routing errors**: Always verify message destinations
3. **Double computation**: Pre-compute state in proposals
4. **Missing notifications**: Ensure all validators receive commits
5. **Phantom consensus**: Only designated proposer should propose
6. **State inconsistency**: Validate that all replicas converge
7. **Performance bottlenecks**: Use mutable operations for hot paths
8. **Complex abstractions**: Prefer simple, clear implementations

## Success Metrics
- ✅ All replicas have identical final state
- ✅ Consensus completes within reasonable time
- ✅ All transactions are properly ordered
- ✅ Tests pass consistently
- ✅ Code is clean and maintainable
- ✅ Debug output provides clear visibility 