import { expect, test } from 'bun:test';

import { createEmptyEnv } from '../runtime';
import { encodeBuffer } from '../storage/codec';
import { computeCanonicalEntityHash } from '../storage/canonical-hash';
import { KEY_HEAD, STORAGE_SCHEMA_VERSION, keyDiff } from '../storage/keys';
import { projectEntityCoreDoc } from '../storage/projections';
import { loadEntityStatesAtHeightFromStorage } from '../storage/read';
import type { RuntimeDbLike, StorageDiffRecord, StorageHead } from '../storage/types';
import type { EntityReplica, EntityState, JurisdictionConfig } from '../types';

const jurisdiction: JurisdictionConfig = {
  name: 'bulk-restore',
  address: 'http://localhost:8545',
  chainId: 31337,
  depositoryAddress: `0x${'44'.repeat(20)}`,
  entityProviderAddress: `0x${'55'.repeat(20)}`,
};

const makeState = (entityId: string, height: number): EntityState => ({
  entityId,
  height,
  timestamp: height * 100,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    validators: ['signer'],
    shares: { signer: 1n },
    threshold: 1n,
    jurisdiction,
  },
  reserves: new Map([[1, BigInt(height)]]),
  accounts: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  entityEncPubKey: '',
  entityEncPrivKey: '',
  profile: { name: `entity-${entityId.slice(-4)}`, isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
});

const canonicalHash = (state: EntityState): string => computeCanonicalEntityHash({
  entityId: state.entityId,
  signerId: 'signer',
  mempool: [],
  isProposer: true,
  state,
} as EntityReplica).hash;

test('bulk restore decodes each tail diff once for every Entity', async () => {
  const firstId = `0x${'11'.repeat(32)}`;
  const secondId = `0x${'22'.repeat(32)}`;
  const initial = [makeState(firstId, 1), makeState(secondId, 1)];
  const expected = [makeState(firstId, 2), makeState(secondId, 2)];
  const diff = (height: number, states: EntityState[]): StorageDiffRecord => ({
    height,
    puts: states.map((state) => ({
      family: 'entity' as const,
      entityId: state.entityId,
      value: projectEntityCoreDoc(state),
    })),
    dels: [],
  });
  const head: StorageHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: 2,
    latestMaterializedHeight: 2,
    latestSnapshotHeight: 0,
    snapshotPeriodFrames: 256,
    retainSnapshots: 3,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    retainedHistoryBytes: 0,
  };
  const store = new Map<string, Buffer>([
    [KEY_HEAD.toString('hex'), encodeBuffer(head)],
    [keyDiff(1).toString('hex'), encodeBuffer(diff(1, initial))],
    [keyDiff(2).toString('hex'), encodeBuffer(diff(2, expected))],
  ]);
  const reads = new Map<string, number>();
  const db: RuntimeDbLike = {
    get: async (key) => {
      const hex = key.toString('hex');
      reads.set(hex, (reads.get(hex) ?? 0) + 1);
      const value = store.get(hex);
      if (!value) {
        const error = new Error('NotFound') as Error & { code?: string; notFound?: boolean };
        error.code = 'LEVEL_NOT_FOUND';
        error.notFound = true;
        throw error;
      }
      return Buffer.from(value);
    },
    batch: () => ({ put: () => {}, write: async () => {} }),
    keys: async function* (options) {
      const keys = Array.from(store.keys()).map((hex) => Buffer.from(hex, 'hex')).sort(Buffer.compare);
      if (options?.reverse) keys.reverse();
      for (const key of keys) {
        if (options?.gte && Buffer.compare(key, options.gte) < 0) continue;
        if (options?.lt && Buffer.compare(key, options.lt) >= 0) continue;
        yield key;
      }
    },
  };

  const restored = await loadEntityStatesAtHeightFromStorage({
    env: createEmptyEnv('bulk-restore-read-once'),
    tryOpenDb: async () => true,
    getRuntimeDb: () => db,
    height: 2,
  });

  expect(reads.get(keyDiff(1).toString('hex'))).toBe(1);
  expect(reads.get(keyDiff(2).toString('hex'))).toBe(1);
  expect(Array.from(restored.keys()).sort()).toEqual([firstId, secondId]);
  expect(canonicalHash(restored.get(firstId)!)).toBe(canonicalHash(expected[0]!));
  expect(canonicalHash(restored.get(secondId)!)).toBe(canonicalHash(expected[1]!));
});
