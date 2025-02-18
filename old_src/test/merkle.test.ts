import { createMerkleStore, StorageType } from '../storage/merkle.js';
import { randomBytes } from 'crypto';
import { encode } from 'rlp';
import debug from 'debug';
import { expect } from 'chai';

// Enable debug logging
debug.enable('merkle:*');

describe('Merkle Tree Large Scale Tests', () => {
  const NUM_ENTITIES = 1000;
  const NUM_OPERATIONS = 50;
  
  it(`should handle ${NUM_ENTITIES} entities with ${NUM_OPERATIONS} operations each`, function() {
    this.timeout(30000); // Allow 30 seconds for this test
    
    // Create merkle store with larger threshold for testing
    const store = createMerkleStore({ bitWidth: 8, leafThreshold: 64 });
    
    // Track all entity IDs and their current values
    const entities: { signerId: string; entityId: string; value: number }[] = [];
    
    console.time('Creating entities');
    
    // Create entities
    for (let i = 0; i < NUM_ENTITIES; i++) {
      const signerId = randomBytes(32).toString('hex');
      const entityId = randomBytes(32).toString('hex');
      
      // Initial state
      store.updateEntityState(signerId, entityId, {
        status: 'idle',
        entityPool: new Map(),
        finalBlock: {
          blockNumber: 0,
          storage: { value: 0 },
          channelRoot: Buffer.from([]),
          channelMap: new Map(),
          inbox: [],
          validatorSet: []
        }
      });
      
      entities.push({ signerId, entityId, value: 0 });
      
      if (i % 100 === 0) {
        console.log(`Created ${i} entities`);
      }
    }
    
    console.timeEnd('Creating entities');
    
    // Track merkle root changes
    const merkleRoots = new Set<string>();
    let lastRoot = store.getMerkleRoot().toString('hex');
    merkleRoots.add(lastRoot);
    
    console.time('Performing operations');
    
    // Perform random operations
    for (let op = 0; op < NUM_OPERATIONS; op++) {
      // Select random entities to update
      const numUpdates = Math.floor(Math.random() * 100) + 1; // 1-100 updates per operation
      
      for (let i = 0; i < numUpdates; i++) {
        const entity = entities[Math.floor(Math.random() * entities.length)];
        const increment = Math.floor(Math.random() * 100);
        
        // Update entity state
        entity.value += increment;
        
        store.updateEntityState(entity.signerId, entity.entityId, {
          status: 'idle',
          entityPool: new Map(),
          finalBlock: {
            blockNumber: op + 1,
            storage: { value: entity.value },
            channelRoot: Buffer.from(encode([])),
            channelMap: new Map(),
            inbox: [],
            validatorSet: []
          }
        });
      }
      
      // Get new merkle root
      const newRoot = store.getMerkleRoot().toString('hex');
      merkleRoots.add(newRoot);
      
      if (op % 10 === 0) {
        console.log(`Operation ${op}: Updated ${numUpdates} entities`);
        console.log(`Merkle root changed: ${lastRoot.slice(0,8)} -> ${newRoot.slice(0,8)}`);
      }
      
      lastRoot = newRoot;
    }
    
    console.timeEnd('Performing operations');
    
    // Verify final state
    for (const entity of entities) {
      const node = store.debug.getEntityNode(entity.signerId, entity.entityId);
      expect(node).to.exist;
      
      if (node) {
        const blockData = node.value.get(StorageType.CURRENT_BLOCK);
        expect(blockData).to.exist;
      }
    }
    
    console.log(`\nTest Summary:`);
    console.log(`- Created ${NUM_ENTITIES} entities`);
    console.log(`- Performed ${NUM_OPERATIONS} operations`);
    console.log(`- Generated ${merkleRoots.size} unique merkle roots`);
  });
  
  it('should maintain consistent hashes with repeated operations', () => {
    const store1 = createMerkleStore();
    const store2 = createMerkleStore();
    
    // Same operations on both stores
    const signerId = randomBytes(32).toString('hex');
    const entityId = randomBytes(32).toString('hex');
    const operations = [10, 20, 30, 40, 50];
    
    operations.forEach(value => {
      const state = {
        status: 'idle' as const,
        entityPool: new Map(),
        finalBlock: {
          blockNumber: value,
          storage: { value },
          channelRoot: Buffer.from([]),
          channelMap: new Map(),
          inbox: [],
          validatorSet: []
        }
      };
      
      store1.updateEntityState(signerId, entityId, state);
      store2.updateEntityState(signerId, entityId, state);
      
      const root1 = store1.getMerkleRoot().toString('hex');
      const root2 = store2.getMerkleRoot().toString('hex');
      
      expect(root1).to.equal(root2, 'Merkle roots should match for identical operations');
    });
  });
}); 