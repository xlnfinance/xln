import { describe, expect, test } from 'bun:test';

import type { JReplica } from '../types';
import {
  buildCanonicalJReplicaSnapshot,
  normalizePersistedSnapshotInPlace,
} from '../wal/snapshot';
import { normalizeRestoredJReplicas } from '../runtime-infra';

const makeJReplica = (overrides: Partial<JReplica> = {}): JReplica => ({
  name: 'arrakis',
  blockNumber: 0n,
  stateRoot: null,
  mempool: [],
  blockDelayMs: 0,
  lastBlockTimestamp: 0,
  position: { x: 0, y: 0, z: 0 },
  ...overrides,
});

const normalizeMap = (raw: unknown): Map<string, unknown> => {
  if (raw instanceof Map) return raw;
  if (raw && typeof raw === 'object') return new Map(Object.entries(raw as Record<string, unknown>));
  return new Map();
};

describe('JReplica stateRoot semantics', () => {
  test('RPC snapshots do not preserve placeholder zero roots', () => {
    const snapshot = buildCanonicalJReplicaSnapshot(makeJReplica({
      stateRoot: new Uint8Array(32),
      rpcs: ['http://127.0.0.1:8545'],
    }));

    expect(snapshot.stateRoot).toBeNull();
  });

  test('BrowserVM snapshots clone real state roots for time travel', () => {
    const root = new Uint8Array(32);
    root[31] = 7;
    const snapshot = buildCanonicalJReplicaSnapshot(makeJReplica({
      name: 'local',
      stateRoot: root,
      rpcs: [],
    }));

    expect(snapshot.stateRoot).toBeInstanceOf(Uint8Array);
    expect(Array.from(snapshot.stateRoot ?? [])).toEqual(Array.from(root));
    expect(snapshot.stateRoot).not.toBe(root);
  });

  test('snapshots preserve J-machine progress and pending transactions', () => {
    const snapshot = buildCanonicalJReplicaSnapshot(makeJReplica({
      blockNumber: 42n,
      lastBlockTimestamp: 1_700_000,
      blockReady: true,
      mempool: [{
        type: 'mint',
        entityId: `0x${'11'.repeat(32)}`,
        data: { entityId: `0x${'11'.repeat(32)}`, tokenId: 1, amount: 5n },
        timestamp: 1_700_000,
      }],
      rpcs: ['http://127.0.0.1:8545'],
    }));

    expect(snapshot.blockNumber).toBe(42n);
    expect(snapshot.lastBlockTimestamp).toBe(1_700_000);
    expect(snapshot.blockReady).toBe(true);
    expect(snapshot.mempool).toHaveLength(1);
  });

  test('storage-reconstructed jurisdiction metadata becomes a complete deterministic snapshot', () => {
    const partial = {
      name: 'restored-rpc',
      chainId: 31337,
      contracts: { depository: `0x${'11'.repeat(20)}` },
    } as JReplica;

    const snapshot = buildCanonicalJReplicaSnapshot(partial);

    expect(snapshot.blockNumber).toBe(0n);
    expect(snapshot.stateRoot).toBeNull();
    expect(snapshot.mempool).toEqual([]);
    expect(snapshot.blockDelayMs).toBe(300);
    expect(snapshot.lastBlockTimestamp).toBe(0);
    expect(snapshot.position).toEqual({ x: 0, y: 50, z: 0 });
  });

  test('restored runtime normalizes partial J replicas before frontend publication', () => {
    const partial = {
      name: 'restored-rpc',
      chainId: 31337,
    } as JReplica;
    const env = { jReplicas: new Map([['restored-rpc', partial]]) } as Parameters<typeof normalizeRestoredJReplicas>[0];

    normalizeRestoredJReplicas(env);

    expect(env.jReplicas.get('restored-rpc')).toMatchObject({
      blockNumber: 0n,
      mempool: [],
      blockDelayMs: 300,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 50, z: 0 },
    });
  });

  test('legacy persisted RPC zero roots normalize to explicit unavailable', () => {
    const persisted = {
      jReplicas: new Map<string, unknown>([[
        'arrakis',
        {
          name: 'arrakis',
          blockNumber: 0n,
          stateRoot: Array.from(new Uint8Array(32)),
          mempool: [],
          blockDelayMs: 0,
          lastBlockTimestamp: 0,
          position: { x: 0, y: 0, z: 0 },
          rpcs: ['http://127.0.0.1:8545'],
        },
      ]]),
    };

    normalizePersistedSnapshotInPlace(persisted, {
      normalizeReplicaMap: normalizeMap,
      normalizeJReplicaMap: normalizeMap,
    });

    const restored = persisted.jReplicas.get('arrakis') as JReplica;
    expect(restored.stateRoot).toBeNull();
  });
});
