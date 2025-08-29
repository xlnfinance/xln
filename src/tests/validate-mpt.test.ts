/**
 * MPT Entity Implementation Test Suite
 * Tests core MPT functionality for entity storage using Bun test framework
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createMPTStorage } from '../entity-mpt.js';
import { createCachedMPTStorage } from '../entity-cached-storage.js';
import { EntityStorage, EntityState, ConsensusConfig } from '../types.js';
import fs from 'fs';

describe('MPT Entity Implementation', () => {
  let storage: EntityStorage;
  let cachedStorage: EntityStorage;
  let initialRoot: string;
  let newRoot: string;

  beforeAll(async () => {
    // Clean test databases before starting
    const testDirs = [
      'db/test-validate',
      'db/test-validate-cached', 
      'db/test-determinism-1',
      'db/test-determinism-2',
      'db/test-validate-2'
    ];
    
    for (const dir of testDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
      }
    }

    storage = await createMPTStorage('db/test-validate');
    cachedStorage = await createCachedMPTStorage('db/test-validate-cached');
  });

  afterAll(() => {
    // Clean up test databases after all tests
    const testDirs = [
      'db/test-validate',
      'db/test-validate-cached',
      'db/test-determinism-1', 
      'db/test-determinism-2',
      'db/test-validate-2'
    ];
    
    for (const dir of testDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  describe('Core MPT Operations', () => {
    test('should store and retrieve basic data', async () => {
      const testValue = { id: 'test', data: 'hello world', number: 42 };
      await storage.set('test', 'key1', testValue);
      const retrieved = await storage.get('test', 'key1');
      expect(retrieved).toEqual(testValue);
    });

    test('should change root hash when data changes', async () => {
      initialRoot = await storage.getRoot();
      await storage.set('test', 'key2', { data: 'more data' });
      newRoot = await storage.getRoot();
      expect(initialRoot).not.toBe(newRoot);
    });

    test('should handle complex data types (BigInt, Map)', async () => {
      const complexData = {
        bigIntValue: 123456789012345678901234567890n,
        mapValue: new Map([['key1', 'value1'], ['key2', 'value2']]),
        nested: { array: [1, 2, 3], object: { deep: true } }
      };
      await storage.set('complex', 'test', complexData);
      const retrievedComplex = await storage.get('complex', 'test') as any;
      
      expect(retrievedComplex?.bigIntValue).toBe(complexData.bigIntValue);
      expect(retrievedComplex?.mapValue).toBeInstanceOf(Map);
      expect(retrievedComplex?.mapValue.get('key1')).toBe('value1');
    });
  });

  describe('Entity State Storage', () => {
    const entityState = {
      height: 100,
      timestamp: 1704067200000, // Fixed timestamp for determinism
      messages: ['msg1', 'msg2', 'msg3'],
      proposals: new Map([
        ['prop1', { type: 'vote', data: { proposal: 'test' } }],
        ['prop2', { type: 'governance', data: { action: 'add_validator' } }]
      ]),
      nonces: new Map([
        ['alice', 5],
        ['bob', 3],
        ['charlie', 1]
      ]),
      config: {
        validators: ['alice', 'bob', 'charlie'],
        shares: { alice: 2n, bob: 2n, charlie: 1n },
        threshold: 3n,
        mode: 'proposer-based' as const
      }
    };

    test('should store entity state components', async () => {
      await storage.set('state', 'height', entityState.height);
      await storage.set('state', 'timestamp', entityState.timestamp);
      await storage.set('state', 'messages', entityState.messages);
      await storage.set('state', 'proposals', entityState.proposals);
      await storage.set('state', 'nonces', entityState.nonces);
      await storage.set('state', 'config', entityState.config);

      const heightRetrieved = await storage.get('state', 'height');
      const messagesRetrieved = await storage.get('state', 'messages');
      const proposalsRetrieved = await storage.get('state', 'proposals');

      expect(heightRetrieved).toBe(entityState.height);
      expect(messagesRetrieved).toEqual(entityState.messages);
      expect(proposalsRetrieved).toBeInstanceOf(Map);
    });
  });

  describe('Root Hash Determinism', () => {
    test('should generate identical root hashes for identical operations', async () => {
      // Create two fresh storages to ensure identical starting state
      const freshStorage1 = await createMPTStorage('db/test-determinism-1');
      const freshStorage2 = await createMPTStorage('db/test-determinism-2');
      
      // Apply same operations to both fresh storages
      const operations: [string, string, any][] = [
        ['type1', 'key1', { data: 'value1' }],
        ['type1', 'key2', { data: 'value2' }],
        ['type2', 'key1', { number: 42, bigint: 123n }]
      ];
      
      for (const [type, key, value] of operations) {
        await freshStorage1.set(type, key, value);
        await freshStorage2.set(type, key, value);
      }
      
      const root1 = await freshStorage1.getRoot();
      const root2 = await freshStorage2.getRoot();
      
      expect(root1).toBe(root2);
    });
  });

  describe('Merkle Proof Generation', () => {
    test('should generate merkle proofs', async () => {
      const proof = await storage.getProof('state', 'height');
      expect(proof).not.toBeNull();
      expect(proof).not.toBeUndefined();
    });
  });

  describe('E-Journal Audit Trail', () => {
    test('should store and retrieve audit entries', async () => {
      const auditEntry = {
        type: 'entity_operation',
        entityId: '0x1234567890abcdef',
        operation: 'board_change',
        oldState: initialRoot,
        newState: newRoot,
        timestamp: Date.now(),
        signerId: 'alice',
        hankoSignature: 'hanko_sig_12345'
      };
      
      const auditKey = `entity_${auditEntry.timestamp}`;
      await storage.set('audit', auditKey, auditEntry);
      const auditRetrieved = await storage.get('audit', auditKey);
      expect(auditRetrieved).toEqual(auditEntry);
    });
  });

  describe('Performance Comparison', () => {
    test('should complete performance tests for cached vs non-cached storage', async () => {
      const testData = Array.from({ length: 50 }, (_, i) => ({
        type: 'perf',
        key: `item_${i}`,
        value: { id: i, balance: BigInt(1000 + i), data: `test_${i}` }
      }));

      // Write performance test
      const regularWriteStart = performance.now();
      for (const item of testData) {
        await storage.set(item.type, item.key, item.value);
      }
      const regularWriteTime = performance.now() - regularWriteStart;

      const cachedWriteStart = performance.now();
      for (const item of testData) {
        await cachedStorage.set(item.type, item.key, item.value);
      }
      const cachedWriteTime = performance.now() - cachedWriteStart;

      // Read performance test
      const regularReadStart = performance.now();
      for (const item of testData) {
        await storage.get(item.type, item.key);
      }
      const regularReadTime = performance.now() - regularReadStart;

      const cachedReadStart = performance.now();
      for (const item of testData) {
        await cachedStorage.get(item.type, item.key);
      }
      const cachedReadTime = performance.now() - cachedReadStart;

      console.log(`   📊 Write: Regular ${regularWriteTime.toFixed(2)}ms, Cached ${cachedWriteTime.toFixed(2)}ms`);
      console.log(`   📊 Read: Regular ${regularReadTime.toFixed(2)}ms, Cached ${cachedReadTime.toFixed(2)}ms`);
      
      // Performance test should complete without errors
      expect(regularWriteTime).toBeGreaterThanOrEqual(0);
      expect(cachedWriteTime).toBeGreaterThanOrEqual(0);
      expect(regularReadTime).toBeGreaterThanOrEqual(0);
      expect(cachedReadTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Type Indexing', () => {
    test('should support type indexing with getAll', async () => {
      await storage.set('indexed', 'item1', { name: 'item1' });
      await storage.set('indexed', 'item2', { name: 'item2' });
      await storage.set('indexed', 'item3', { name: 'item3' });
      
      const allIndexed = await storage.getAll('indexed');
      expect(allIndexed).toHaveLength(3);
    });

    test('should support type clearing', async () => {
      await storage.clear('indexed');
      const afterClear = await storage.getAll('indexed');
      expect(afterClear).toHaveLength(0);
    });
  });
});
