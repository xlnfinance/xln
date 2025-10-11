# XLN Visual Debugger Architecture

## Overview
This document outlines the architectural decisions and data flow patterns discovered and implemented during the development of the XLN visual debugging system.

## System Architecture

### High-Level Components
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend UI   │    │  Server Logic   │    │ Consensus Core  │
│   (index.html)  │◄──►│  (server.ts)    │◄──►│ (entity-*.ts)   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  LocalStorage   │    │ Process Utils   │    │  State Machine  │
│   (Tabs/UI)     │    │(processUntil    │    │   (Immutable)   │
│                 │    │     Empty)      │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Data Flow Pattern
```
User Action → Frontend → Server Input → Consensus Processing → State Update → UI Refresh
     ↑                                                                          │
     └──────────────────── Feedback Loop ←───────────────────────────────────────┘
```

## Core Design Principles

### 1. Immutable State Management
```typescript
// Wrong: Mutating existing state
function updateState(state, newData) {
  state.proposals.set(newData.id, newData);
  return state;
}

// Correct: Creating new state
function updateState(state, newData) {
  return {
    ...state,
    proposals: new Map(state.proposals).set(newData.id, newData)
  };
}
```

### 2. Centralized Processing
All consensus operations flow through a single processing pipeline:
```typescript
// Central processing in server.ts
export function processUntilEmpty(initialOutputs) {
  let outputs = initialOutputs;
  let iteration = 0;
  
  while (outputs && outputs.length > 0) {
    console.log(`🔥 PROCESS-CASCADE: Iteration ${iteration}, processing ${outputs.length} outputs`);
    
    const result = applyServerInput({ 
      entityInputs: outputs.map(createEntityInput) 
    });
    
    outputs = result.entityOutbox;
    iteration++;
    
    if (iteration > 100) { // Safety limit
      console.warn('🔥 PROCESS-CASCADE: Hit iteration limit');
      break;
    }
  }
}
```

### 3. Defensive Programming
```typescript
// Robust replica lookup with multiple fallbacks
function findReplica(entityId, signerId) {
  // Try primary key format
  let replica = xlnEnv.replicas.get(`${entityId}:${signerId}`);
  
  // Try alternative format
  if (!replica) {
    replica = xlnEnv.replicas.get(`${signerId}:${entityId}`);
  }
  
  // Fallback to property search
  if (!replica) {
    for (const [key, r] of xlnEnv.replicas) {
      if (r.entityId === entityId && r.signerId === signerId) {
        replica = r;
        break;
      }
    }
  }
  
  return replica;
}
```

## Module Organization

### Frontend Layer (`index.html`)
**Responsibilities**:
- User interface rendering
- Event handling
- Local state management (tabs, UI preferences)
- Data formatting and display
- User input validation

**Key Functions**:
```javascript
// UI Management
function renderEntityInTab(tabId)
function renderProposals(replica)
function renderTransactionHistory(transactions)

// User Interactions
function submitChat(tabId)
function submitVote(tabId)
function submitEntityFormation()

// State Synchronization
function refreshAllEntityDisplays()
function syncTimeControls(frameIndex)
```

### Server Layer (`src/server.ts`)
**Responsibilities**:
- Consensus orchestration
- Input/output processing
- State snapshot management
- History tracking

**Key Functions**:
```typescript
export function applyServerInput(input: ServerInput): ServerOutput
export function processUntilEmpty(outputs: EntityOutput[]): void
export function getHistory(): Snapshot[]
```

### Consensus Layer (`src/entity-*.ts`)
**Responsibilities**:
- Transaction processing
- State transitions
- Consensus algorithm implementation
- Entity lifecycle management

**Key Modules**:
- `entity-consensus.ts`: Core consensus logic
- `entity-tx.ts`: Transaction application
- `entity-factory.ts`: Entity creation
- `types.ts`: Type definitions

## Data Models

### Entity State Structure
```typescript
interface EntityState {
  height: number;
  timestamp: number;
  nonces: Map<string, number>;
  messages: ChatMessage[];
  proposals: Map<string, Proposal>;
  validators: Map<string, bigint>;  // signerId → voting power
  threshold: bigint;               // minimum voting power for approval
}
```

### Transaction Types
```typescript
type EntityTx = 
  | { type: 'chat', data: { message: string } }
  | { type: 'propose', data: ProposalData }
  | { type: 'vote', data: VoteData };

interface VoteData {
  proposalId: string;
  choice: 'yes' | 'no' | 'abstain';
  comment?: string;
}
```

### Consensus Frame
```typescript
interface Frame {
  id: string;                    // 'frame_' + height + '_' + timestamp
  height: number;                // Consensus height
  timestamp: number;             // Frame creation time
  transactions: EntityTx[];      // All transactions in frame
  proposer: string;              // Proposer replica ID
  signatures: Map<string, any>;  // Precommit signatures
}
```

## Processing Patterns

### Transaction Lifecycle
1. **Creation**: User creates transaction in UI
2. **Validation**: Frontend validates input
3. **Submission**: Transaction sent to server
4. **Consensus**: Server processes through consensus
5. **Application**: Transaction applied to state
6. **Propagation**: State changes propagated to all replicas
7. **UI Update**: Frontend refreshes display

### Error Recovery
```typescript
// Graceful error handling with fallbacks
function safeProcessTransaction(tx: EntityTx) {
  try {
    return applyEntityTx(state, tx);
  } catch (error) {
    console.error('Transaction failed:', error);
    
    // Log error but continue processing
    logTransactionError(tx, error);
    
    // Return unchanged state
    return state;
  }
}
```

### State Consistency
```typescript
// Ensure consistent state across all replicas
function validateStateConsistency(replicas: Map<string, EntityReplica>) {
  const heights = new Set();
  const proposalCounts = new Set();
  
  for (const replica of replicas.values()) {
    heights.add(replica.state.height);
    proposalCounts.add(replica.state.proposals.size);
  }
  
  if (heights.size > 1) {
    console.warn('Height mismatch detected:', Array.from(heights));
  }
  
  if (proposalCounts.size > 1) {
    console.warn('Proposal count mismatch:', Array.from(proposalCounts));
  }
}
```

## Performance Optimizations

### 1. Lazy Rendering
```javascript
// Only re-render when state actually changes
let lastStateHash = '';
function shouldRerender(newState) {
  const newHash = hashState(newState);
  if (newHash === lastStateHash) return false;
  lastStateHash = newHash;
  return true;
}
```

### 2. Batch Processing
```typescript
// Process multiple inputs together
function processBatch(inputs: EntityInput[]) {
  const mergedInputs = mergeInputs(inputs);
  return applyServerInput({ entityInputs: mergedInputs });
}
```

### 3. Memory Management
```javascript
// Limit history size to prevent memory bloat
const MAX_HISTORY_FRAMES = 1000;
function trimHistory(history) {
  if (history.length > MAX_HISTORY_FRAMES) {
    return history.slice(-MAX_HISTORY_FRAMES);
  }
  return history;
}
```

## Integration Patterns

### Frontend-Backend Communication
```javascript
// Standardized server input format
function createServerInput(entityTxs) {
  return {
    entityTxs: entityTxs.map(tx => ({
      entityId: tx.entityId,
      signerId: tx.signerId,
      transactions: tx.transactions,
      timestamp: Date.now()
    }))
  };
}
```

### Tab System Architecture
```javascript
// Tab-based entity management
const tabSystem = {
  tabs: new Map(),           // tabId → tabData
  activeTabId: null,         // Currently active tab
  nextTabId: 1,             // Auto-incrementing ID
  
  createTab(entityId, signerId) {
    const tab = {
      id: `tab-${this.nextTabId++}`,
      title: `Entity ${getEntityNumber(entityId)}`,
      entityId,
      signerId,
      jurisdiction: 'Ethereum'
    };
    
    this.tabs.set(tab.id, tab);
    return tab;
  }
};
```

### Settings Management
```javascript
// Global settings with persistence
const settings = {
  mode: 'proposer',           // 'gossip' or 'proposer'
  serverDelay: 100,          // Processing delay in ms
  
  save() {
    localStorage.setItem('xln-settings', JSON.stringify(this));
  },
  
  load() {
    const saved = localStorage.getItem('xln-settings');
    if (saved) Object.assign(this, JSON.parse(saved));
  }
};
```

## Debugging Architecture

### Logging System
```typescript
// Hierarchical logging with prefixes
const LogPrefixes = {
  CONSENSUS: '🔥',
  VOTING: '🗳️', 
  TRANSACTION: '🚨',
  FRAME: '🔍',
  UI: '🎨'
};

function log(prefix: string, message: string, data?: any) {
  console.log(`${prefix} ${message}`, data || '');
}
```

### State Inspection
```javascript
// Comprehensive state debugging
function debugEntityState(replica) {
  console.group(`🔍 Entity ${replica.entityId}:${replica.signerId}`);
  console.log('Height:', replica.state.height);
  console.log('Messages:', replica.state.messages.length);
  console.log('Proposals:', replica.state.proposals.size);
  console.log('Mempool:', replica.mempool.length);
  console.log('Is Proposer:', replica.isProposer);
  console.groupEnd();
}
```

## Security Considerations

### Input Sanitization
```javascript
// HTML escaping for XSS prevention
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Safe rendering of user content
function renderUserMessage(message) {
  return `<div class="message">${escapeHtml(message)}</div>`;
}
```

### Validation
```typescript
// Transaction validation
function validateEntityTx(tx: EntityTx): boolean {
  switch (tx.type) {
    case 'vote':
      return Boolean(tx.data.proposalId && 
                    ['yes', 'no', 'abstain'].includes(tx.data.choice));
    case 'chat':
      return Boolean(tx.data.message && tx.data.message.length > 0);
    default:
      return false;
  }
}
```

## Future Architecture Considerations

### Framework Migration
- **Component-based architecture**: React/Vue/Svelte for better state management
- **Type safety**: Full TypeScript conversion for better error catching
- **Testing**: Unit and integration test suites
- **Build system**: Webpack/Vite for module bundling

### Scalability Enhancements
- **Virtual scrolling**: For large transaction histories
- **Web workers**: For heavy consensus computations
- **Streaming**: Real-time updates via WebSockets
- **Caching**: Intelligent state caching and invalidation

### Monitoring and Observability
- **Performance metrics**: Track rendering times and memory usage
- **Error tracking**: Centralized error reporting
- **User analytics**: Track feature usage and performance
- **Health checks**: Monitor system health and consistency

This architecture provides a solid foundation for the XLN visual debugger while maintaining flexibility for future enhancements and optimizations.
