/**
 * Comprehensive MPT Entity Testing Suite
 * Tests MPT implementation correctness at entity level for regulatory compliance
 */

import { describe, beforeEach, afterEach, it, expect } from 'bun:test';
import { createMPTStorage } from '../entity-mpt.js';
import { createCachedMPTStorage } from '../entity-cached-storage.js';
import { EntityStorage, EntityState, ConsensusConfig, Proposal } from '../types.js';
import fs from 'fs';
import { createHash } from '../utils.js';

describe('Entity MPT Implementation Tests', () => {
  let storage: EntityStorage;
  let cachedStorage: EntityStorage;
  let testId: string;

  beforeEach(async () => {
    // Generate unique test ID to avoid database conflicts
    testId = `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const storagePath = `db/test-mpt-${testId}`;
    const cachedPath = `db/test-mpt-cached-${testId}`;

    // Clean test databases if they exist
    if (fs.existsSync(storagePath)) {
      fs.rmSync(storagePath, { recursive: true });
    }
    if (fs.existsSync(cachedPath)) {
      fs.rmSync(cachedPath, { recursive: true });
    }

    storage = await createMPTStorage(storagePath);
    cachedStorage = await createCachedMPTStorage(cachedPath);
  });

  afterEach(() => {
    // Clean up test databases using unique paths
    const storagePath = `db/test-mpt-${testId}`;
    const cachedPath = `db/test-mpt-cached-${testId}`;

    if (fs.existsSync(storagePath)) {
      fs.rmSync(storagePath, { recursive: true });
    }
    if (fs.existsSync(cachedPath)) {
      fs.rmSync(cachedPath, { recursive: true });
    }
  });

  describe('Core MPT Operations', () => {
    it('should store and retrieve entity state components correctly', async () => {
      const testState: Partial<EntityState> = {
        height: 42,
        timestamp: Date.now(),
        messages: ['msg1', 'msg2'],
        proposals: new Map([
          [
            'prop1',
            {
              id: 'prop1',
              proposer: 'alice',
              action: { type: 'collective_message', data: { message: 'test' } },
              votes: new Map(),
              status: 'pending',
              created: Date.now(),
            } as Proposal,
          ],
        ]),
        nonces: new Map([
          ['alice', 1],
          ['bob', 2],
        ]),
        config: {
          mode: 'proposer-based',
          validators: ['alice', 'bob'],
          shares: { alice: 5n, bob: 3n },
          threshold: 6n,
        } as ConsensusConfig,
      };

      // Store each component
      await storage.set('state', 'height', testState.height);
      await storage.set('state', 'timestamp', testState.timestamp);
      await storage.set('state', 'messages', testState.messages);
      await storage.set('state', 'proposals', testState.proposals);
      await storage.set('state', 'nonces', testState.nonces);
      await storage.set('state', 'config', testState.config);

      // Retrieve and verify
      expect((await storage.get('state', 'height')) as number).toBe(testState.height!);
      expect((await storage.get('state', 'timestamp')) as number).toBe(testState.timestamp!);
      expect((await storage.get('state', 'messages')) as string[]).toEqual(testState.messages!);
      expect((await storage.get('state', 'proposals')) as Map<string, Proposal>).toEqual(testState.proposals!);
      expect((await storage.get('state', 'nonces')) as Map<string, number>).toEqual(testState.nonces!);
      expect((await storage.get('state', 'config')) as ConsensusConfig).toEqual(testState.config!);
    });

    it('should generate deterministic root hashes', async () => {
      const initialRoot = await storage.getRoot();

      // Store some data
      await storage.set('test', 'key1', 'value1');
      const root1 = await storage.getRoot();

      // Store more data
      await storage.set('test', 'key2', 'value2');
      const root2 = await storage.getRoot();

      // Verify roots change with state
      expect(root1).not.toBe(initialRoot);
      expect(root2).not.toBe(root1);

      // Verify deterministic behavior
      const storage2 = await createMPTStorage('db/test-mpt-2');
      await storage2.set('test', 'key1', 'value1');
      await storage2.set('test', 'key2', 'value2');
      const root2_duplicate = await storage2.getRoot();

      expect(root2).toBe(root2_duplicate);

      // Cleanup
      if (fs.existsSync('db/test-mpt-2')) {
        fs.rmSync('db/test-mpt-2', { recursive: true });
      }
    });

    it('should handle complex data types (Maps, BigInts)', async () => {
      const complexData = {
        bigIntValue: 123456789012345678901234567890n,
        mapValue: new Map([
          ['simple', 'value'],
          ['complex', 'nested-object'],
        ]),
        nestedMap: new Map([
          ['alice', 1n],
          ['bob', 2n],
        ]),
      };

      await storage.set('complex', 'test', complexData);
      const retrieved = (await storage.get('complex', 'test')) as typeof complexData;

      expect(retrieved).toEqual(complexData);
      expect(typeof retrieved?.bigIntValue).toBe('bigint');
      expect(retrieved?.mapValue).toBeInstanceOf(Map);
      expect(retrieved?.nestedMap).toBeInstanceOf(Map);
    });
  });

  describe('Merkle Proof Generation', () => {
    it('should generate valid merkle proofs for stored data', async () => {
      const testData = { id: 'test', value: 'merkle proof test' };
      await storage.set('proofs', 'test', testData);

      const proof = await storage.getProof('proofs', 'test');
      expect(proof).toBeTruthy();

      // TODO: Add proof verification when available in @ethereumjs/mpt
      console.log('📝 Generated proof structure:', Object.keys(proof));
    });

    it('should generate different proofs for different keys', async () => {
      await storage.set('proofs', 'key1', { data: 'value1' });
      await storage.set('proofs', 'key2', { data: 'value2' });

      const proof1 = await storage.getProof('proofs', 'key1');
      const proof2 = await storage.getProof('proofs', 'key2');

      expect(proof1).not.toEqual(proof2);
    });
  });

  describe('Entity State Persistence', () => {
    it('should persist complete entity state and maintain root hash integrity', async () => {
      const entityState: EntityState = {
        height: 100,
        timestamp: Date.now(),
        messages: ['genesis', 'block1', 'block2'],
        proposals: new Map([
          [
            'proposal1',
            {
              id: 'proposal1',
              proposer: 'alice',
              action: { type: 'collective_message', data: { message: 'Test proposal' } },
              votes: new Map(),
              status: 'pending' as const,
              created: Date.now(),
            } as Proposal,
          ],
        ]),
        nonces: new Map([
          ['alice', 1],
          ['bob', 2],
          ['charlie', 1],
        ]),
        config: {
          mode: 'proposer-based' as const,
          validators: ['alice', 'bob', 'charlie'],
          shares: { alice: 2n, bob: 2n, charlie: 1n },
          threshold: 3n,
        } as ConsensusConfig,
      };

      const rootBefore = await storage.getRoot();

      // Store entity state components directly
      await storage.set('entity', 'height', entityState.height);
      await storage.set('entity', 'messages', entityState.messages);
      await storage.set('entity', 'proposals', entityState.proposals);
      await storage.set('entity', 'nonces', entityState.nonces);
      await storage.set('entity', 'config', entityState.config);

      const rootAfter = await storage.getRoot();

      // Root should change after state persistence
      expect(rootBefore).not.toBe(rootAfter);

      // Verify all components persisted correctly
      expect((await storage.get('entity', 'height')) as number).toBe(entityState.height);
      expect((await storage.get('entity', 'messages')) as string[]).toEqual(entityState.messages);
      expect((await storage.get('entity', 'proposals')) as Map<string, Proposal>).toEqual(entityState.proposals);
      expect((await storage.get('entity', 'nonces')) as Map<string, number>).toEqual(entityState.nonces);
      expect((await storage.get('entity', 'config')) as ConsensusConfig).toEqual(entityState.config);

      console.log(`✅ Entity state persisted with root: ${rootAfter.slice(0, 16)}...`);
    });

    it('should maintain consistent root hashes across identical operations', async () => {
      const operations = [
        ['state', 'height', 42],
        ['state', 'timestamp', 1640995200000],
        ['proposals', 'prop1', { id: 'prop1' }],
        ['committed', 'frame1', { hash: 'frame1' }],
      ];

      // Perform operations in storage1
      for (const [type, key, value] of operations) {
        await storage.set(type as string, key as string, value);
      }
      const root1 = await storage.getRoot();

      // Perform same operations in storage2
      const storage2 = await createMPTStorage('db/test-mpt-consistency');
      for (const [type, key, value] of operations) {
        await storage2.set(type as string, key as string, value);
      }
      const root2 = await storage2.getRoot();

      expect(root1).toBe(root2);

      // Cleanup
      if (fs.existsSync('db/test-mpt-consistency')) {
        fs.rmSync('db/test-mpt-consistency', { recursive: true });
      }
    });
  });

  describe('Audit Trail Features (E-Journal)', () => {
    it('should create immutable audit entries for entity operations', async () => {
      const auditEntry = {
        type: 'entity_operation',
        entityId: '0x1234567890abcdef',
        operation: 'board_change',
        oldState: 'prev_root_hash',
        newState: 'new_root_hash',
        timestamp: Date.now(),
        signerId: 'alice',
        signature: 'sig_alice_12345',
      };

      const auditKey = `entity_${auditEntry.timestamp}`;
      await storage.set('audit', auditKey, auditEntry);

      const retrieved = await storage.get('audit', auditKey);
      expect(retrieved).toEqual(auditEntry);

      // Generate audit proof for regulatory compliance
      const auditProof = await storage.getProof('audit', auditKey);
      expect(auditProof).toBeTruthy();

      console.log('📋 Created audit entry with timestamp:', auditEntry.timestamp);
    });

    it('should handle financial transaction audit entries', async () => {
      const txAudit = {
        type: 'financial_transaction',
        amount: '1000000', // 1M units
        from: 'entity_A',
        to: 'entity_B',
        timestamp: Date.now(),
        blockHeight: 42,
        transactionHash: createHash('sha256').update('tx_data').digest('hex'),
      };

      await storage.set('audit', `finance_${txAudit.timestamp}`, txAudit);
      const rootWithTx = await storage.getRoot();

      const retrieved = await storage.get('audit', `finance_${txAudit.timestamp}`);
      expect(retrieved).toEqual(txAudit);

      console.log(`💰 Financial audit entry created, root: ${rootWithTx.slice(0, 16)}...`);
    });

    it('should handle governance decision audit entries', async () => {
      const govAudit = {
        type: 'governance_decision',
        proposalId: 'prop_increase_threshold',
        voter: 'alice',
        choice: 'yes',
        votingPower: 2n,
        blockHeight: 100,
        timestamp: Date.now(),
        quorumReached: true,
      };

      await storage.set('audit', `governance_${govAudit.timestamp}`, govAudit);
      const retrieved = (await storage.get('audit', `governance_${govAudit.timestamp}`)) as typeof govAudit;

      expect(retrieved).toEqual(govAudit);
      expect(typeof retrieved?.votingPower).toBe('bigint');

      console.log('🗳️  Governance audit entry created');
    });
  });

  describe('Performance and Caching', () => {
    it('should demonstrate cached vs non-cached performance difference', async () => {
      const testData = Array.from({ length: 100 }, (_, i) => ({
        type: 'perf',
        key: `item_${i}`,
        value: { id: i, data: `test_data_${i}`, balance: BigInt(1000 + i) },
      }));

      // Test regular storage
      const regularStart = performance.now();
      for (const item of testData) {
        await storage.set(item.type, item.key, item.value);
      }
      const regularWriteTime = performance.now() - regularStart;

      // Test cached storage
      const cachedStart = performance.now();
      for (const item of testData) {
        await cachedStorage.set(item.type, item.key, item.value);
      }
      const cachedWriteTime = performance.now() - cachedStart;

      console.log(
        `📊 Write Performance - Regular: ${regularWriteTime.toFixed(2)}ms, Cached: ${cachedWriteTime.toFixed(2)}ms`,
      );

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

      console.log(
        `📊 Read Performance - Regular: ${regularReadTime.toFixed(2)}ms, Cached: ${cachedReadTime.toFixed(2)}ms`,
      );

      // Hot read test (cached should be much faster)
      const hotReadStart = performance.now();
      for (const item of testData) {
        await cachedStorage.get(item.type, item.key);
      }
      const hotReadTime = performance.now() - hotReadStart;

      console.log(`🔥 Hot Read Performance: ${hotReadTime.toFixed(2)}ms`);

      // Hot reads should be significantly faster than first reads
      expect(hotReadTime).toBeLessThan(cachedReadTime);
    });
  });

  describe('Data Integrity and Error Handling', () => {
    it('should handle corrupted data gracefully', async () => {
      // Store valid data
      await storage.set('test', 'valid', { data: 'valid' });

      // Try to retrieve non-existent data
      const nonExistent = await storage.get('test', 'nonexistent');
      expect(nonExistent).toBeUndefined();

      // Try to get proof for non-existent data
      try {
        await storage.getProof('test', 'nonexistent');
        // Should handle gracefully or throw appropriate error
      } catch (error) {
        console.log('📝 Expected error for non-existent proof:', (error as Error)?.message?.slice(0, 50));
      }
    });

    it('should maintain consistency after multiple operations', async () => {
      const operations = 50;
      const rootHashes: string[] = [];

      for (let i = 0; i < operations; i++) {
        await storage.set('consistency', `key_${i}`, {
          id: i,
          data: `operation_${i}`,
          timestamp: Date.now() + i,
        });

        const root = await storage.getRoot();
        rootHashes.push(root);

        // Each operation should produce a unique root
        if (i > 0) {
          expect(rootHashes[i]).not.toBe(rootHashes[i - 1]);
        }
      }

      console.log(`✅ ${operations} operations completed with consistent root progression`);
    });
  });

  describe('Type Index Management', () => {
    it('should maintain accurate type indexes', async () => {
      const items = ['item1', 'item2', 'item3'];

      // Add items
      for (const item of items) {
        await storage.set('indexed', item, { name: item });
      }

      // Retrieve all items using getAll
      const allItems = await storage.getAll('indexed');
      expect(allItems.length).toBe(items.length);

      // Verify all items are present
      for (const item of items) {
        const found = allItems.find((i: any) => i.name === item);
        expect(found).toBeTruthy();
      }

      console.log('📇 Type index management verified');
    });

    it('should handle clear operations correctly', async () => {
      // Add test data
      await storage.set('cleartest', 'item1', { data: 'test1' });
      await storage.set('cleartest', 'item2', { data: 'test2' });

      const beforeClear = await storage.getAll('cleartest');
      expect(beforeClear.length).toBe(2);

      // Clear the type
      await storage.clear('cleartest');

      const afterClear = await storage.getAll('cleartest');
      expect(afterClear.length).toBe(0);

      // Individual gets should return undefined
      expect(await storage.get('cleartest', 'item1')).toBeUndefined();
      expect(await storage.get('cleartest', 'item2')).toBeUndefined();

      console.log('🧹 Clear operations verified');
    });
  });
});
