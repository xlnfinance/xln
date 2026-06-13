import { describe, expect, test } from 'bun:test';

import type { JReplica } from '../types';
import {
  buildCanonicalJReplicaSnapshot,
  normalizePersistedSnapshotInPlace,
} from '../wal/snapshot';

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
