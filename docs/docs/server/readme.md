# Server System

## Overview
ESM-based TypeScript server handling state management, WebSocket communication, and entity coordination.

## Configuration

### TypeScript/ESM Setup
```json
// tsconfig.json
{
  "extends": "@tsconfig/node20/tsconfig.json",
  "compilerOptions": {
    "moduleResolution": "node16",
    "module": "node16",
    "allowImportingTsExtensions": true,
    "noEmit": true
  }
}

// package.json
{
  "type": "module",
  "scripts": {
    "start": "NODE_ENV=development ts-node --esm --experimental-specifier-resolution=node src/server.ts"
  }
}
```

## State Management

### Server State
```typescript
interface ServerState {
  pool: Map<string, Map<string, EntityInput[]>>
  block: number
  merkleStore: ReturnType<typeof createMerkleStore>
  unsaved: Set<string>
}
```

### State Updates
- Use immutable state updates
- Track changes in unsaved set
- Batch database operations
- Validate state consistency

### Database Operations
```typescript
// Batch operations for efficiency
const ops = [];
ops.push({
  type: 'put',
  key: Buffer.from([]),
  value: Buffer.from(encode([state.block, merkleRoot, timestamp]))
});

// Save entity states
for (const key of state.unsaved) {
  const [signerId, entityId] = key.split('/');
  const node = state.merkleStore.debug.getEntityNode(signerId, entityId);
  if (node?.value) {
    ops.push({
      type: 'put',
      key: Buffer.from(key, 'hex'),
      value: Buffer.from(encode(Array.from(node.value.entries())))
    });
  }
}
```

## Type Safety

### Buffer Handling
```typescript
// Safe pattern
const encoded = Buffer.from(encode(data));
const merkleRoot = state.merkleStore.getMerkleRoot();

// Unsafe pattern (avoid)
const encoded = encode(data) as Buffer;
```

### Type Guards
```typescript
function isValidInput(input: unknown): input is EntityInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'type' in input &&
    typeof input.type === 'string'
  );
}
```

## WebSocket Communication

### Message Format
```typescript
interface WSMessage {
  signerId: string
  entityId: string
  input: EntityInput
}
```

### Error Handling
```typescript
ws.on('message', async (msg) => {
  try {
    const { signerId, entityId, input } = JSON.parse(msg.toString());
    if (!isValidInput(input)) {
      throw new Error('Invalid input format');
    }
    // Process message
  } catch (error) {
    ws.send(JSON.stringify({ 
      error: error instanceof Error ? error.message : String(error) 
    }));
  }
});
```

## Debugging

### Debug Namespaces
```typescript
const log = {
  state: debug('state:🔵'),
  tx: debug('tx:🟡'),
  block: debug('block:🟢'),
  error: debug('error:🔴'),
  diff: debug('diff:🟣'),
  merkle: debug('merkle:⚪')
};
```

### State Diffing
- Track state changes
- Log merkle root updates
- Monitor pool size
- Track unsaved changes

## Best Practices

### State Management
- Use immutable updates
- Batch database operations
- Validate state before persistence
- Track unsaved changes

### Type Safety
- Use explicit Buffer conversions
- Add type guards
- Validate all inputs
- Handle edge cases

### Performance
- Batch database operations
- Cache merkle roots
- Use efficient encoding
- Monitor memory usage

### Error Handling
- Add descriptive messages
- Validate all inputs
- Handle edge cases
- Log errors properly

## Core Components

### State Management
```typescript
interface ServerState {
  pool: Map<string, Map<string, EntityInput[]>>  // Transaction pool
  block: number                                   // Current block number
  merkleStore: MerkleStore                       // State storage
  unsaved: Set<string>                           // Modified entries
}
```

### Storage
- LevelDB for persistence
- Separate databases for:
  - Log (immutable history)
  - State (current state)
  - Entity log (entity-specific history)

### Communication
- WebSocket server on port 8080
- JSON message format
- Automatic state updates

## Transaction Processing

### Input Types
- Entity transactions
- Channel inputs
- System operations

### State Updates
1. Input validation
2. State transition
3. Merkle root update
4. State persistence

## Development Mode
- REPL interface for debugging
- Live state inspection
- Test transaction generation
- Tree visualization

## Configuration
```typescript
// Debug namespaces
debug.enable('state:*,tx:*,block:*,error:*,diff:*,merkle:*');

// Storage paths
const logDb = new Level('./db/log');
const stateDb = new Level('./db/state');
const entityLogDb = new Level('./db/entitylog');
```

## Testing
- Automated test transactions
- State verification
- Performance monitoring
- Error handling validation

## Known Issues
- ESM/TypeScript import paths require `.js` extension
- Buffer type handling needs explicit imports
- Debug logging verbosity control needed 