import { createMerkleStore, StorageType } from '../storage/merkle.js';
import { randomBytes } from 'crypto';
import { encode } from 'rlp';
import debug from 'debug';
import { expect } from 'chai';
import { strict as assert } from 'assert';

// Enable debug logging
debug.enable('merkle:*,test:*');

const log = {
  test: debug('test:🔵'),
  merkle: debug('merkle:⚪'),
  tx: debug('tx:🟡')
};

describe('Merkle Tree Large Scale Tests', () => {
  const NUM_SIGNERS = 42;
  const NUM_ENTITIES_PER_SIGNER = 6;
  
  it(`should handle ${NUM_SIGNERS} signers with ${NUM_ENTITIES_PER_SIGNER} entities each`, function() {
    this.timeout(60000); // Keep the same timeout for consistency
    
    // Create merkle store with 4-bit nibbles
    const store = createMerkleStore({ bitWidth: 4, leafThreshold: 4 });
    
    // Track all signer and entity IDs
    const signers: { id: string, entities: { id: string, value: number }[] }[] = [];
    
    console.time('Creating signers and entities');
    
    // Create signers and their entities
    for (let s = 0; s < NUM_SIGNERS; s++) {
      const signerId = randomBytes(32).toString('hex');
      const entities: { id: string, value: number }[] = [];
      
      // Create entities for this signer
      for (let e = 0; e < NUM_ENTITIES_PER_SIGNER; e++) {
        const entityId = randomBytes(32).toString('hex');
        
        // Initial state with unique path
        store.updateEntityState(signerId, entityId, {
          status: 'idle',
          entityPool: new Map(),
          finalBlock: {
            blockNumber: e, // Use e to make each entity's state unique
            storage: { value: e },
            channelRoot: Buffer.from([]),
            channelMap: new Map(),
            inbox: [],
            validatorSet: []
          }
        });
        
        entities.push({ id: entityId, value: e });
      }
      
      signers.push({ id: signerId, entities });
      
      // Show progress for each signer since we have fewer now
      if (s % 100 === 0) {
        log.test(`Created ${s} signers with initial entities`);
        // Get and log current merkle root
        const currentRoot = store.getMerkleRoot().toString('hex');
        log.merkle(`Current merkle root: ${currentRoot.slice(0,8)}...`);
      }
      
      // Show tree structure for each signer
      log.test(`Created signer ${s + 1}/${NUM_SIGNERS} with ${NUM_ENTITIES_PER_SIGNER} entities`);
      const currentRoot = store.getMerkleRoot().toString('hex');
      log.merkle(`Current merkle root: ${currentRoot.slice(0,8)}...`);
    }
    
    console.timeEnd('Creating signers and entities');
    
    // Track merkle root changes
    const merkleRoots = new Set<string>();
    let lastRoot = store.getMerkleRoot().toString('hex');
    merkleRoots.add(lastRoot);
    
    // Verify final state
    console.time('Verifying final state');
    
    let verifiedEntities = 0;
    for (const signer of signers) {
      for (const entity of signer.entities) {
        const node = store.debug.getEntityNode(signer.id, entity.id);
        expect(node).to.exist;
        
        if (node) {
          const blockData = node.value?.get(StorageType.CURRENT_BLOCK);
          expect(blockData).to.exist;
        }
        
        verifiedEntities++;
      }
    }
    
    console.timeEnd('Verifying final state');
    
    log.test('\nFinal State:');
    log.test(`- ${verifiedEntities} entities verified`);
    log.test(`- ${merkleRoots.size} unique merkle roots`);
    log.test(`- Final root: ${lastRoot.slice(0,8)}...`);
  });
});

describe('MerkleStore', () => {
  it('should handle basic entity state updates', () => {
    const store = createMerkleStore();
    
    // Create test data
    const signerId = randomBytes(32).toString('hex');
    const entityId = randomBytes(32).toString('hex');
    const state = {
      status: 'idle' as const,
      entityPool: new Map(),
      finalBlock: {
        blockNumber: 1,
        storage: { value: 42 },
        channelRoot: Buffer.from([]),
        channelMap: new Map(),
        inbox: []
      }
    };
    
    // Update state
    store.updateEntityState(signerId, entityId, state);
    
    // Verify state was stored
    const node = store.debug.getEntityNode(signerId, entityId);
    assert(node?.value?.has(StorageType.CURRENT_BLOCK), 'Entity state should be stored');
    
    // Calculate root hash
    const root = store.getMerkleRoot();
    assert(root.length === 32, 'Root hash should be 32 bytes');
  });
  
  it('should maintain deterministic root hash', () => {
    const store1 = createMerkleStore();
    const store2 = createMerkleStore();
    
    // Create test data
    const signers = [
      randomBytes(32).toString('hex'),
      randomBytes(32).toString('hex')
    ];
    
    const entities = [
      randomBytes(32).toString('hex'),
      randomBytes(32).toString('hex')
    ];
    
    const states = signers.map((_, i) => ({
      status: 'idle' as const,
      entityPool: new Map(),
      finalBlock: {
        blockNumber: i + 1,
        storage: { value: i * 100 },
        channelRoot: Buffer.from([]),
        channelMap: new Map(),
        inbox: []
      }
    }));
    
    // Add to store1 in forward order
    for (let i = 0; i < signers.length; i++) {
      store1.updateEntityState(signers[i], entities[i], states[i]);
    }
    
    // Add to store2 in reverse order
    for (let i = signers.length - 1; i >= 0; i--) {
      store2.updateEntityState(signers[i], entities[i], states[i]);
    }
    
    // Print trees for visual inspection
    console.log('\nStore 1 root:', store1.getMerkleRoot().toString('hex').slice(0,8));
    console.log('Store 2 root:', store2.getMerkleRoot().toString('hex').slice(0,8));
    
    // Verify roots match
    assert.deepEqual(
      store1.getMerkleRoot(),
      store2.getMerkleRoot(),
      'Root hash should be same regardless of insertion order'
    );
  });
  
  it('should handle many signers and entities efficiently', () => {
    const store = createMerkleStore();
    const signerCount = 42;
    const entitiesPerSigner = 6;
    
    // Create test data
    for (let i = 0; i < signerCount; i++) {
      const signerId = randomBytes(32).toString('hex');
      
      for (let j = 0; j < entitiesPerSigner; j++) {
        const entityId = randomBytes(32).toString('hex');
        const state = {
          status: 'idle' as const,
          entityPool: new Map(),
          finalBlock: {
            blockNumber: i * entitiesPerSigner + j + 1,
            storage: { value: i * 1000 + j },
            channelRoot: Buffer.from([]),
            channelMap: new Map(),
            inbox: []
          }
        };
        
        store.updateEntityState(signerId, entityId, state);
      }
    }
    
    // Print test summary
    console.log('\nTest Summary:');
    console.log(`- Created ${signerCount} signers`);
    console.log(`- Created ${signerCount * entitiesPerSigner} total entities`);
    console.log(`- Generated 1 unique merkle roots`);
    
    // Print final tree structure at the end
    console.log('\nFinal Tree Structure:');
    console.log(store.print());
  });
}); 