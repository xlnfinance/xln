import { describe, expect, test } from 'bun:test';

import type { JReplica } from '../types';
import {
  buildCanonicalJReplicaSnapshot,
  normalizePersistedSnapshotInPlace,
} from '../wal/snapshot';
import {
  applyTrustedJurisdictionRpcBindings,
  ensureLiveJAdapterForReplica,
  normalizeRestoredJReplicas,
} from '../machine/infra';
import { buildBrowserVMJurisdiction, createJAdapter } from '../jadapter';
import { applyImportJurisdictionIntent } from '../machine/jurisdiction-import';
import { createEmptyEnv } from '../runtime';
import { getJurisdictionIdentityRef } from '../jurisdiction/jurisdiction-runtime';

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
  test('BrowserVM registry preserves the trusted adapter chain domain', () => {
    const jurisdiction = buildBrowserVMJurisdiction(
      `0x${'11'.repeat(20)}`,
      `0x${'22'.repeat(20)}`,
      31_338,
    );
    expect(jurisdiction.chainId).toBe(31_338);
  });

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

  test('persists trusted EntityProvider deployment height without archive rediscovery', () => {
    const snapshot = buildCanonicalJReplicaSnapshot(makeJReplica({
      entityProviderDeploymentBlock: 91,
      entityProviderAddress: `0x${'22'.repeat(20)}`,
      rpcs: ['https://non-archive.invalid'],
    }));
    const persisted = { jReplicas: new Map<string, unknown>([['arrakis', structuredClone(snapshot)]]) };
    normalizePersistedSnapshotInPlace(persisted, {
      normalizeReplicaMap: normalizeMap,
      normalizeJReplicaMap: normalizeMap,
    });
    expect((persisted.jReplicas.get('arrakis') as JReplica).entityProviderDeploymentBlock).toBe(91);
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

  test('trusted stack binding rebases only the matching restored RPC transport', () => {
    const matching = makeJReplica({
      name: 'matching',
      chainId: 31_337,
      depositoryAddress: `0x${'11'.repeat(20)}`,
      rpcs: ['http://127.0.0.1:19700'],
    });
    const otherStack = makeJReplica({
      name: 'other-stack',
      chainId: 31_337,
      depositoryAddress: `0x${'22'.repeat(20)}`,
      rpcs: ['http://127.0.0.1:19700'],
    });
    const env = {
      jReplicas: new Map([
        ['matching', matching],
        ['other-stack', otherStack],
      ]),
    } as Parameters<typeof applyTrustedJurisdictionRpcBindings>[0];

    applyTrustedJurisdictionRpcBindings(env, [{
      jurisdictionRef: getJurisdictionIdentityRef(matching),
      rpcUrl: 'http://127.0.0.1:19800',
    }]);

    expect(matching.rpcs).toEqual(['http://127.0.0.1:19800']);
    expect(otherStack.rpcs).toEqual(['http://127.0.0.1:19700']);
  });

  test('conflicting trusted RPC bindings for one stack fail loud', () => {
    const replica = makeJReplica({
      chainId: 31_337,
      depositoryAddress: `0x${'11'.repeat(20)}`,
      rpcs: ['http://127.0.0.1:19700'],
    });
    const env = {
      jReplicas: new Map([['arrakis', replica]]),
    } as Parameters<typeof applyTrustedJurisdictionRpcBindings>[0];
    const jurisdictionRef = getJurisdictionIdentityRef(replica);

    expect(() => applyTrustedJurisdictionRpcBindings(env, [
      { jurisdictionRef, rpcUrl: 'http://127.0.0.1:19800' },
      { jurisdictionRef, rpcUrl: 'http://127.0.0.1:19900' },
    ])).toThrow('RESTORE_JURISDICTION_RPC_BINDING_CONFLICT');
    expect(replica.rpcs).toEqual(['http://127.0.0.1:19700']);
  });

  test('does not send persisted BrowserVM pseudo URLs to an RPC provider', async () => {
    const replica = makeJReplica({ name: 'local', rpcs: ['browservm://local'] });
    const env = {
      jReplicas: new Map([['local', replica]]),
    } as Parameters<typeof ensureLiveJAdapterForReplica>[0];

    expect(await ensureLiveJAdapterForReplica(env, 'local', { allowBrowserVm: false })).toBeNull();
    expect(replica.jadapter).toBeUndefined();
  });

  test('rejects a pre-attached adapter from a different trusted chain domain', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31_338 });
    const stateRoot = await adapter.captureStateRoot?.();
    if (!(stateRoot instanceof Uint8Array)) throw new Error('BROWSERVM_TEST_STATE_ROOT_MISSING');
    const replica = makeJReplica({
      name: 'wrong-domain',
      chainId: 31_337,
      stateRoot,
      rpcs: [],
      depositoryAddress: adapter.addresses.depository,
      entityProviderAddress: adapter.addresses.entityProvider,
      contracts: { ...adapter.addresses },
      jadapter: adapter,
    });
    const env = {
      jReplicas: new Map([['wrong-domain', replica]]),
    } as Parameters<typeof ensureLiveJAdapterForReplica>[0];

    await expect(ensureLiveJAdapterForReplica(env, 'wrong-domain', { allowBrowserVm: true }))
      .rejects.toThrow('RESTORE_JADAPTER_CHAIN_MISMATCH');
    expect(replica.jadapter).toBeUndefined();
  }, 30_000);

  test('import intent is independent of an ephemeral attached adapter', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31_337 });
    try {
      const existingReplica = (jadapter?: typeof adapter): JReplica => makeJReplica({
        name: 'persisted-rpc',
        chainId: 1,
        stateRoot: null,
        rpcs: ['https://rpc.example/'],
        depositoryAddress: adapter.addresses.depository,
        entityProviderAddress: adapter.addresses.entityProvider,
        contracts: { ...adapter.addresses },
        ...(jadapter ? { jadapter } : {}),
      });
      const withAdapter = createEmptyEnv('import-intent-with-ephemeral-adapter');
      const withoutAdapter = createEmptyEnv('import-intent-without-ephemeral-adapter');
      withAdapter.jReplicas.set('persisted-rpc', existingReplica(adapter));
      withoutAdapter.jReplicas.set('persisted-rpc', existingReplica());
      const importTx = {
        type: 'importJ' as const,
        data: { name: 'new-browser-vm', chainId: 31_337, ticker: 'SIM', rpcs: [] },
      };

      applyImportJurisdictionIntent(withAdapter, importTx);
      applyImportJurisdictionIntent(withoutAdapter, importTx);

      expect(withAdapter.runtimeState?.pendingJurisdictionImports?.size).toBe(1);
      expect(withoutAdapter.runtimeState?.pendingJurisdictionImports?.size).toBe(1);
    } finally {
      await adapter.close();
    }
  }, 30_000);

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
