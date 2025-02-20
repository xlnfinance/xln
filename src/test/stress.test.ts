import { createMerkleStore, StorageType } from '../storage/merkle.js';
import { randomBytes } from 'crypto';
import { encode } from 'rlp';
import debug from 'debug';
import { expect } from 'chai';

// Enable debug logging
debug.enable('merkle:*,state:*,tx:*');

const log = {
  test: debug('test:🔵'),
  merkle: debug('merkle:⚪'),
  tx: debug('tx:🟡')
};

describe('Merkle Tree Stress Tests', () => {
  const NUM_SIGNERS = 1000;
  
  it(`should handle ${NUM_SIGNERS} signers with initial entity creation`, async function() {
    this.timeout(60000); // Allow 60 seconds for this test
    
    // Create merkle store with larger threshold for testing
    const store = createMerkleStore({ bitWidth: 8, leafThreshold: 128 });
    
    // Track all signer and entity IDs
    const signers: { id: string, entities: { id: string, value: number }[] }[] = [];
    
    log.test('Creating initial entities for each signer...');
    console.time('Initial entity creation');
    
    // First phase: Create one entity for each signer
    for (let i = 0; i < NUM_SIGNERS; i++) {
      const signerId = randomBytes(32).toString('hex');
      const entityId = randomBytes(32).toString('hex');
      
      // Initial state with Create command
      store.updateEntityState(signerId, entityId, {
        status: 'idle',
        entityPool: new Map([
          ['create', Buffer.from(encode(['Create']))]
        ]),
        finalBlock: {
          blockNumber: 0,
          storage: { value: 0 },
          channelRoot: Buffer.from([]),
          channelMap: new Map(),
          inbox: [],
          validatorSet: []
        }
      });
      
      signers.push({ 
        id: signerId, 
        entities: [{ id: entityId, value: 0 }] 
      });
      
      if (i % 100 === 0) {
        log.test(`Created ${i} signers with initial entities`);
        // Get and log current merkle root
        const currentRoot = store.getMerkleRoot().toString('hex');
        log.merkle(`Current merkle root: ${currentRoot.slice(0,8)}...`);
      }
    }
    
    console.timeEnd('Initial entity creation');
    
    // Track merkle root changes
    const merkleRoots = new Set<string>();
    let lastRoot = store.getMerkleRoot().toString('hex');
    merkleRoots.add(lastRoot);
    
    log.test(`\nPhase 1 Complete:`);
    log.test(`- Created ${NUM_SIGNERS} signers with one entity each`);
    log.test(`- Final merkle root: ${lastRoot.slice(0,8)}...`);
    
    // Verify all entities exist and are accessible
    log.test('\nVerifying entity states...');
    for (const signer of signers) {
      for (const entity of signer.entities) {
        const node = store.debug.getEntityNode(signer.id, entity.id);
        if (!node) {
          throw new Error(`Entity node not found: ${signer.id.slice(0,8)}/${entity.id.slice(0,8)}`);
        }
        if (!node.value?.get(StorageType.CURRENT_BLOCK)) {
          throw new Error(`Entity state not found: ${signer.id.slice(0,8)}/${entity.id.slice(0,8)}`);
        }
      }
    }
    
    log.test('All entity states verified successfully');
    log.test(`Generated ${merkleRoots.size} unique merkle roots`);
  });
  
  // This test will be enabled in the next phase
  it.skip('should handle multiple entities per signer', async function() {
    // This will be implemented in the next phase
    // after we verify the first test works correctly
  });
}); 