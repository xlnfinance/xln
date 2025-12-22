# XLN Consensus Debugging Guide

## Overview
This guide documents debugging techniques and patterns discovered during development of the XLN visual debugger, specifically for consensus-related issues.

## Key Debugging Strategies

### 1. Extensive Console Logging
Use unique prefixes for different subsystems:
- `🔥 PROCESS-CASCADE` - processUntilEmpty execution
- `🗳️` - Voting and proposal operations  
- `🔍` - Frame and history analysis
- `🚨 APPLY-ENTITY-TX` - Transaction application
- `🔄` - State refresh operations

### 2. Critical Race Condition: Vote Processing
**Problem**: Votes submitted by non-proposers weren't appearing in proposals.

**Root Cause**: Race condition in `entity-consensus.ts` where commit notifications cleared mempool before transactions could be forwarded.

**Solution**: Move transaction forwarding logic to execute BEFORE commit processing:
```typescript
// WRONG: Forwarding after commit (mempool gets cleared)
if (commitNotification) {
  // ... commit processing clears mempool
}
if (!entityReplica.isProposer && entityReplica.mempool.length > 0) {
  // ... forwarding (too late!)
}

// CORRECT: Forwarding before commit
if (!entityReplica.isProposer && entityReplica.mempool.length > 0) {
  // ... forwarding first
}
if (commitNotification) {
  // ... commit processing
}
```

### 3. Data Type Consistency
**Problem**: Vote choices inconsistent between frontend (`true`/`false`) and backend (`'yes'`/`'no'`).

**Solution**: Standardize on strings throughout:
```javascript
// Frontend vote submission
const voteChoice = document.getElementById('vote-choice').value; // 'yes' or 'no'
```

### 4. Single Signer Entity Optimization
**Problem**: Single-signer entities (1 validator, threshold 1) were going through full consensus rounds unnecessarily.

**Solution**: Direct execution bypass:
```typescript
if (entityReplica.state.validators.size === 1 && entityReplica.state.threshold === 1n) {
  // Direct execution for single signer
  for (const tx of entityReplica.mempool) {
    entityReplica.state = applyEntityTx(entityReplica.state, tx);
  }
  entityReplica.mempool = [];
}
```

## Transaction Flow Debugging

### Vote Transaction Journey
1. **Frontend**: User clicks vote → `submitVote()` 
2. **Data Transform**: Choice converted to string, comment added
3. **Server Input**: `applyServerInput()` processes vote
4. **Forwarding**: Non-proposer forwards to proposer
5. **Proposal**: Proposer includes in next frame
6. **Commit**: All replicas apply committed frame

### Debug Log Sequence for Vote
```
🗳️ Vote form data: {proposalId: 'prop_123', voteChoice: 'yes', comment: 'agree'}
🔥 BOB-TO-ALICE: Bob forwarding 1 txs to proposer alice
🔥 ALICE-RECEIVES: Alice received input with 1 txs
🔥 ALICE-PROPOSES: Alice proposing frame with 1 txs
🚨 APPLY-ENTITY-TX: Processing vote tx for proposal prop_123
```

## Common Error Patterns

### 1. BigInt Mixing Errors
**Error**: `Cannot mix BigInt and other types`
**Solution**: Universal conversion utilities
```javascript
function toNumber(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function safeStringify(obj) {
  return JSON.stringify(obj, (key, value) => 
    typeof value === 'bigint' ? value.toString() : value
  );
}
```

### 2. Undefined Function Errors
**Pattern**: Global functions not exposed properly
**Solution**: Explicit window assignments
```javascript
window.submitVote = submitVote;
window.updateThresholdTab = updateThresholdTab;
```

### 3. Replica Lookup Failures
**Pattern**: Multiple key formats for replica identification
**Solution**: Robust lookup with fallbacks
```javascript
// Try multiple key formats
let replica = xlnEnv.replicas.get(`${signerId}:${entityId}`) ||
              xlnEnv.replicas.get(`${entityId}:${signerId}`);

// Fallback to property search
if (!replica) {
  for (const [key, r] of xlnEnv.replicas) {
    if (r.entityId === entityId && r.signerId === signerId) {
      replica = r;
      break;
    }
  }
}
```

## Debugging Tools

### 1. State Inspection
```javascript
// Check replica state
console.log('🔍 Replica state:', replica.state);
console.log('🔍 Mempool:', replica.mempool);
console.log('🔍 Proposals:', replica.state.proposals);
```

### 2. Transaction Tracing
```javascript
// Trace transaction through system
console.log('📤 TX-OUT:', tx);
console.log('📥 TX-IN:', receivedTx);
console.log('🔄 TX-APPLY:', appliedTx);
```

### 3. Frame Analysis
```javascript
// Analyze historical frames
for (let i = 0; i < history.length; i++) {
  const snapshot = history[i];
  console.log(`🔍 Frame ${i}: entityInputs=${snapshot.entityInputs?.length || 0}`);
}
```

## Best Practices

1. **Always use processUntilEmpty**: Ensure full consensus cascade completion
2. **Centralize utilities**: Move common functions to `server.ts` and export
3. **Consistent data types**: Use strings for vote choices, BigInt for amounts
4. **Defensive lookups**: Handle multiple key formats and missing data
5. **Race condition awareness**: Order operations carefully in consensus logic
6. **Extensive logging**: Use unique prefixes for different subsystems

## Performance Considerations

- **Batch operations**: Process multiple inputs together when possible
- **Avoid unnecessary re-renders**: Only update UI when state actually changes
- **Memory management**: Clear old history frames if memory becomes an issue
- **Background processing**: Use settings modal to adjust processing delays
