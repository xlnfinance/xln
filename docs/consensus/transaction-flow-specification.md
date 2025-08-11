# XLN Transaction Flow Specification

## Overview
This document specifies the complete transaction flow in the XLN consensus system, based on implementation discoveries and debugging sessions.

## Transaction Types

### 1. Chat Transactions
```typescript
{
  type: 'chat',
  data: {
    message: string
  }
}
```

### 2. Proposal Transactions  
```typescript
{
  type: 'propose',
  data: {
    id: string,           // Generated: 'prop_' + random
    action: {
      type: string,       // e.g., 'updateThreshold', 'addValidator'
      description: string,
      data: any
    }
  }
}
```

### 3. Vote Transactions
```typescript
{
  type: 'vote', 
  data: {
    proposalId: string,
    choice: 'yes' | 'no' | 'abstain',
    comment?: string     // Optional vote comment
  }
}
```

## Consensus Flow Models

### Proposer-Based Model (Current Implementation)
1. **Transaction Creation**: User creates transaction in UI
2. **Mempool Addition**: Transaction added to replica's mempool
3. **Non-Proposer Forwarding**: If not proposer, forward all mempool txs to proposer
4. **Proposer Collection**: Proposer collects transactions from all replicas
5. **Frame Creation**: Proposer creates frame with collected transactions
6. **Precommit Phase**: All replicas precommit to the frame
7. **Commit Phase**: Once threshold reached, frame is committed
8. **State Application**: All replicas apply the committed frame

### Single Signer Optimization
For entities with 1 validator and threshold 1:
1. **Direct Execution**: Skip consensus rounds entirely
2. **Immediate Application**: Apply transactions directly from mempool
3. **Instant Commitment**: No need for precommit/commit phases

## Data Flow Architecture

### Frontend → Backend
```javascript
// Vote submission example
const serverInput = {
  entityTxs: [{
    entityId: activeTab.entityId,
    signerId: activeTab.signer,
    transactions: [voteTransaction],
    timestamp: Date.now()
  }]
};

XLN.applyServerInput(serverInput);
```

### Backend Processing
```typescript
// In entity-consensus.ts
function applyEntityInput(entityReplica, input) {
  // 1. Add transactions to mempool
  entityReplica.mempool.push(...input.transactions);
  
  // 2. Forward to proposer (if not proposer)
  if (!entityReplica.isProposer && entityReplica.mempool.length > 0) {
    // Forward transactions to proposer
  }
  
  // 3. Process precommits/commits
  if (commitNotification) {
    // Apply committed frame
  }
}
```

### State Updates
```typescript
// In entity-tx.ts
function applyEntityTx(state, tx) {
  switch (tx.type) {
    case 'vote':
      const proposal = state.proposals.get(tx.data.proposalId);
      if (proposal) {
        proposal.votes.set(signerId, {
          choice: tx.data.choice,
          comment: tx.data.comment
        });
      }
      break;
    // ... other transaction types
  }
  return newState;
}
```

## Timing and Ordering

### Critical Ordering in entity-consensus.ts
```typescript
// CORRECT ORDER:
// 1. Process new transactions first
entityReplica.mempool.push(...input.transactions);

// 2. Forward to proposer BEFORE processing commits
if (!entityReplica.isProposer && entityReplica.mempool.length > 0) {
  // Forward logic here
}

// 3. Process commits last (clears mempool)
if (commitNotification) {
  // Commit processing here
}
```

### Race Condition Prevention
- **Forward Before Commit**: Ensure transaction forwarding happens before commit processing
- **Mempool Management**: Clear mempool only after successful forwarding
- **State Consistency**: Use immutable updates to prevent partial state corruption

## Frame Structure
```typescript
interface Frame {
  id: string;           // 'frame_' + height + '_' + timestamp
  height: number;       // Consensus height
  timestamp: number;    // Frame creation time
  transactions: EntityTx[];  // All transactions in this frame
  proposer: string;     // Proposer replica ID
}
```

## Proposal Lifecycle

### 1. Creation Phase
```typescript
// Proposal created via UI
const proposal = {
  id: 'prop_' + generateId(),
  proposer: currentSigner,
  action: {
    type: 'updateThreshold',
    description: 'Update voting threshold to 2',
    data: { newThreshold: 2 }
  },
  votes: new Map(),
  status: 'pending',
  timestamp: Date.now()
};
```

### 2. Voting Phase
```typescript
// Votes collected from replicas
proposal.votes.set('alice', { choice: 'yes', comment: 'Agree' });
proposal.votes.set('bob', { choice: 'no', comment: 'Too restrictive' });
```

### 3. Execution Phase
```typescript
// Calculate voting power
let yesVotingPower = 0n;
for (const [voter, voteData] of proposal.votes) {
  if (voteData.choice === 'yes') {
    yesVotingPower += state.validators.get(voter) || 0n;
  }
}

// Check if threshold reached
if (yesVotingPower >= state.threshold) {
  proposal.status = 'executed';
  // Apply proposal action
} else {
  proposal.status = 'failed';
}
```

## Error Handling Patterns

### Transaction Validation
```typescript
function validateTransaction(tx, state) {
  switch (tx.type) {
    case 'vote':
      // Check if proposal exists
      if (!state.proposals.has(tx.data.proposalId)) {
        throw new Error('Proposal not found');
      }
      // Check if already voted
      const proposal = state.proposals.get(tx.data.proposalId);
      if (proposal.votes.has(signerId)) {
        throw new Error('Already voted on this proposal');
      }
      break;
  }
}
```

### State Recovery
```typescript
function recoverFromCorruption() {
  // Rebuild state from transaction history
  let cleanState = getInitialState();
  for (const frame of committedFrames) {
    for (const tx of frame.transactions) {
      cleanState = applyEntityTx(cleanState, tx);
    }
  }
  return cleanState;
}
```

## Performance Optimizations

### Batch Processing
```typescript
// Process multiple transactions together
function processBatch(transactions) {
  return XLN.processUntilEmpty(
    XLN.applyServerInput({ entityTxs: transactions })
  );
}
```

### Memory Management
```typescript
// Limit history size
const MAX_HISTORY_FRAMES = 1000;
if (history.length > MAX_HISTORY_FRAMES) {
  history = history.slice(-MAX_HISTORY_FRAMES);
}
```

### Selective Updates
```typescript
// Only update UI for relevant changes
function shouldUpdateUI(oldState, newState) {
  return oldState.height !== newState.height ||
         oldState.proposals.size !== newState.proposals.size;
}
```

## Integration Points

### Frontend Integration
- Use `XLN.processUntilEmpty()` after all server inputs
- Implement defensive replica lookups with multiple key formats
- Handle BigInt conversions consistently

### Testing Integration
- Create corner case tests for single signer entities
- Test vote forwarding and race conditions
- Verify proposal execution thresholds

### Debugging Integration
- Use unique log prefixes for transaction tracing
- Implement frame-by-frame history analysis
- Monitor mempool states and forwarding behavior
