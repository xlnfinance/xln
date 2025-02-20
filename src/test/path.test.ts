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
  merkle: debug('merkle:⚪')
};

describe('Merkle Tree Path Handling', () => {
  it('should correctly handle paths with nibble count prefix', () => {
    const store = createMerkleStore({ bitWidth: 4, leafThreshold: 4 });
    
    // Test cases with different path lengths
    const testCases = [
      { path: Buffer.from('00', 'hex'), expectedNibbles: 1 },
      { path: Buffer.from('0000', 'hex'), expectedNibbles: 2 },
      { path: Buffer.from('000000', 'hex'), expectedNibbles: 3 },
      { path: Buffer.from('00000000', 'hex'), expectedNibbles: 4 }
    ];
    
    for (const { path, expectedNibbles } of testCases) {
      const signerId = path.toString('hex');
      const entityId = randomBytes(32).toString('hex');
      
      // Update state to create a path
      store.updateEntityState(signerId, entityId, {
        status: 'idle',
        entityPool: new Map(),
        finalBlock: {
          blockNumber: 1,
          storage: { value: expectedNibbles },
          channelRoot: Buffer.from([]),
          channelMap: new Map(),
          inbox: [],
          validatorSet: []
        }
      });
      
      // Get node and verify path
      const node = store.debug.getEntityNode(signerId, entityId);
      assert(node, `Node should exist for path ${signerId}`);
      
      log.test(`\nTesting path: ${signerId}`);
      log.test(`Expected nibbles: ${expectedNibbles}`);
      log.test(`Node exists with hash: ${node.hash.toString('hex').slice(0, 8)}...`);
    }
  });
  
  it('should handle paths with leading zeros correctly', () => {
    const store = createMerkleStore({ bitWidth: 4, leafThreshold: 4 });
    
    // Test paths with leading zeros
    const paths = [
      '0000',   // 2 nibbles, all zeros
      '0001',   // 2 nibbles, ending in 1
      '0100',   // 2 nibbles, zero in middle
      '1000'    // 2 nibbles, leading 1
    ].map(hex => Buffer.from(hex, 'hex'));

    // Generate entityIds once to reuse them
    const entityIds = paths.map(() => randomBytes(32).toString('hex'));
    
    // Create entities with these paths
    for (let i = 0; i < paths.length; i++) {
      const signerId = paths[i].toString('hex');
      const entityId = entityIds[i];
      
      store.updateEntityState(signerId, entityId, {
        status: 'idle',
        entityPool: new Map(),
        finalBlock: {
          blockNumber: 1,
          storage: { value: 42 },
          channelRoot: Buffer.from([]),
          channelMap: new Map(),
          inbox: [],
          validatorSet: []
        }
      });
      
      // Verify node exists
      const node = store.debug.getEntityNode(signerId, entityId);
      assert(node, `Node should exist for path ${signerId}`);
      log.test(`Created node for path ${signerId} with hash: ${node.hash.toString('hex').slice(0, 8)}...`);
    }
    
    // Verify root is deterministic
    const root1 = store.getMerkleRoot();
    log.test(`\nFirst tree root: ${root1.toString('hex').slice(0, 8)}...`);
    
    // Create new store and add in reverse order
    const store2 = createMerkleStore({ bitWidth: 4, leafThreshold: 4 });
    
    // Use paths.reverse() but keep entityIds in corresponding order
    const reversedPaths = [...paths].reverse();
    for (let i = 0; i < reversedPaths.length; i++) {
      const signerId = reversedPaths[i].toString('hex');
      // Use the entityId that corresponds to this path's original position
      const originalIndex = paths.findIndex(p => p.equals(reversedPaths[i]));
      const entityId = entityIds[originalIndex];
      
      store2.updateEntityState(signerId, entityId, {
        status: 'idle',
        entityPool: new Map(),
        finalBlock: {
          blockNumber: 1,
          storage: { value: 42 },
          channelRoot: Buffer.from([]),
          channelMap: new Map(),
          inbox: [],
          validatorSet: []
        }
      });
      
      const node = store2.debug.getEntityNode(signerId, entityId);
      log.test(`Created node for path ${signerId} with hash: ${node.hash.toString('hex').slice(0, 8)}...`);
    }
    
    const root2 = store2.getMerkleRoot();
    log.test(`Second tree root: ${root2.toString('hex').slice(0, 8)}...`);
    
    // Roots should match regardless of insertion order
    assert.deepEqual(root1, root2, 'Root hash should be same regardless of path insertion order');
  });
  
  it('should maintain path integrity during updates', () => {
    const store = createMerkleStore({ bitWidth: 4, leafThreshold: 4 });
    
    const signerId = Buffer.from('0001', 'hex').toString('hex');
    const entityId = randomBytes(32).toString('hex');
    
    // Initial state
    store.updateEntityState(signerId, entityId, {
      status: 'idle',
      entityPool: new Map(),
      finalBlock: {
        blockNumber: 1,
        storage: { value: 1 },
        channelRoot: Buffer.from([]),
        channelMap: new Map(),
        inbox: [],
        validatorSet: []
      }
    });
    
    const initialNode = store.debug.getEntityNode(signerId, entityId);
    log.test(`\nInitial node hash: ${initialNode.hash.toString('hex').slice(0, 8)}...`);
    
    // Update state multiple times
    for (let i = 2; i <= 4; i++) {
      store.updateEntityState(signerId, entityId, {
        status: 'idle',
        entityPool: new Map(),
        finalBlock: {
          blockNumber: i,
          storage: { value: i },
          channelRoot: Buffer.from([]),
          channelMap: new Map(),
          inbox: [],
          validatorSet: []
        }
      });
      
      // Verify node still exists and path is intact
      const node = store.debug.getEntityNode(signerId, entityId);
      assert(node, `Node should exist after update ${i}`);
      log.test(`Node hash after update ${i}: ${node.hash.toString('hex').slice(0, 8)}...`);
    }
  });
}); 