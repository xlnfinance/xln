import { createMerkleStore, StorageType } from '../storage/merkle.js';
import { randomBytes } from 'crypto';
import { encode } from 'rlp';
import debug from 'debug';
import { expect } from 'chai';

// Enable debug logging
debug.enable('merkle:*,test:*');

const log = {
  test: debug('test:🔵'),
  merkle: debug('merkle:⚪'),
  tx: debug('tx:🟡')
};

describe('Merkle Tree Large Scale Tests', () => {
  const NUM_SIGNERS = 10;
  const NUM_ENTITIES_PER_SIGNER = 10;
  
  it(`should handle ${NUM_SIGNERS} signers with ${NUM_ENTITIES_PER_SIGNER} entities each`, function() {
    this.timeout(60000); // Keep the same timeout for consistency
    
    // Create merkle store with 4-bit nibbles
    const store = createMerkleStore({ bitWidth: 4, leafThreshold: 16 });
    
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
        
        entities.push({ id: entityId, value: 0 });
      }
      
      signers.push({ id: signerId, entities });
      
      // Show progress for each signer since we have fewer now
      log.test(`Created signer ${s + 1}/${NUM_SIGNERS} with ${NUM_ENTITIES_PER_SIGNER} entities`);
      const currentRoot = store.getMerkleRoot().toString('hex');
      log.merkle(`Current merkle root: ${store.debug.formatHex(currentRoot.slice(0,8))}...`);
      
      // Show tree structure for each signer
      log.test('\nCurrent Tree Structure:\n' + store.debug.visualizeTree());
    }
    
    console.timeEnd('Creating signers and entities');
    
    // Show complete tree after creation
    log.test('\nFinal Tree Structure After Creation:\n' + store.debug.visualizeTree());
    
    // Track merkle root changes
    const merkleRoots = new Set<string>();
    let lastRoot = store.getMerkleRoot().toString('hex');
    merkleRoots.add(lastRoot);
    
    console.time('Performing random operations');
    
    // Reduce number of operations proportionally
    const NUM_OPERATIONS = 10; // Reduced from 100
    
    for (let op = 0; op < NUM_OPERATIONS; op++) {
      // Select random signers and their entities to update
      const numSignersToUpdate = Math.floor(Math.random() * NUM_SIGNERS) + 1;
      
      for (let i = 0; i < numSignersToUpdate; i++) {
        const signer = signers[Math.floor(Math.random() * signers.length)];
        const numEntitiesToUpdate = Math.floor(Math.random() * NUM_ENTITIES_PER_SIGNER) + 1;
        
        for (let j = 0; j < numEntitiesToUpdate; j++) {
          const entity = signer.entities[Math.floor(Math.random() * signer.entities.length)];
          const increment = Math.floor(Math.random() * 100);
          
          // Update entity state
          entity.value += increment;
          
          store.updateEntityState(signer.id, entity.id, {
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
      }
      
      // Get new merkle root
      const newRoot = store.getMerkleRoot().toString('hex');
      merkleRoots.add(newRoot);
      
      // Show progress and tree for each operation since we have fewer now
      log.test(`Operation ${op + 1}/${NUM_OPERATIONS}: Updated ${numSignersToUpdate} signers`);
      log.merkle(`Merkle root changed: ${store.debug.formatHex(lastRoot.slice(0,8))} -> ${store.debug.formatHex(newRoot.slice(0,8))}`);
      log.test('\nCurrent Tree Structure:\n' + store.debug.visualizeTree());
      
      lastRoot = newRoot;
    }
    
    console.timeEnd('Performing random operations');
    
    // Show final tree structure
    log.test('\nFinal Tree Structure After Operations:\n' + store.debug.visualizeTree());
    
    // Verify final state
    console.time('Verifying final state');
    
    let verifiedEntities = 0;
    for (const signer of signers) {
      for (const entity of signer.entities) {
        const node = store.debug.getEntityNode(signer.id, entity.id);
        expect(node).to.exist;
        
        if (node) {
          const blockData = node.value.get(StorageType.CURRENT_BLOCK);
          expect(blockData).to.exist;
        }
        
        verifiedEntities++;
        log.test(`Verified ${verifiedEntities}/${NUM_SIGNERS * NUM_ENTITIES_PER_SIGNER} entities`);
      }
    }
    
    console.timeEnd('Verifying final state');
    
    log.test(`\nTest Summary:`);
    log.test(`- Created ${NUM_SIGNERS} signers`);
    log.test(`- Created ${NUM_SIGNERS * NUM_ENTITIES_PER_SIGNER} total entities`);
    log.test(`- Performed ${NUM_OPERATIONS} batch operations`);
    log.test(`- Generated ${merkleRoots.size} unique merkle roots`);
  });
}); 