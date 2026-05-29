import { describe, expect, test } from 'bun:test';

import { getHealthStatus } from '../health';
import { startJurisdictionWatchers } from '../runtime';
import type { Env, JReplica } from '../types';

const makeEnv = (replicas: Array<[string, JReplica]>): Env => ({
  runtimeId: 'test-runtime',
  height: 0n,
  timestamp: 0,
  eReplicas: new Map(),
  jReplicas: new Map(replicas),
  runtimeState: {},
} as unknown as Env);

const makeAdapter = (options?: { watching?: boolean }) => {
  let watching = options?.watching === true;
  return {
    mode: 'rpc',
    chainId: 31337,
    addresses: {
      account: '0x0000000000000000000000000000000000000001',
      depository: '0x0000000000000000000000000000000000000002',
      entityProvider: '0x0000000000000000000000000000000000000003',
      deltaTransformer: '0x0000000000000000000000000000000000000004',
    },
    provider: {
      _getConnection: () => ({ url: 'http://127.0.0.1:8545' }),
      getBlockNumber: async () => {
        throw new Error('health must use j-watcher cursor, not direct RPC');
      },
    },
    startCount: 0,
    stopCount: 0,
    startWatching() {
      this.startCount += 1;
      watching = true;
    },
    stopWatching() {
      this.stopCount += 1;
      watching = false;
    },
    isWatching() {
      return watching;
    },
  };
};

const makeReplica = (adapter: ReturnType<typeof makeAdapter>, blockNumber = 0n): JReplica => ({
  name: 'arrakis',
  blockNumber,
  stateRoot: new Uint8Array(32),
  mempool: [],
  blockDelayMs: 0,
  lastBlockTimestamp: 0,
  position: { x: 0, y: 0, z: 0 },
  depositoryAddress: adapter.addresses.depository,
  entityProviderAddress: adapter.addresses.entityProvider,
  contracts: adapter.addresses,
  rpcs: ['http://127.0.0.1:8545'],
  chainId: 31337,
  jadapter: adapter as never,
});

describe('canonical J-watcher ownership', () => {
  test('health reports the J-watcher cursor without direct provider RPC reads', async () => {
    const adapter = makeAdapter({ watching: true });
    const env = makeEnv([['arrakis', makeReplica(adapter, 42n)]]);

    const health = await getHealthStatus(env);

    expect(health.jMachines).toHaveLength(1);
    expect(health.jMachines[0]?.lastBlock).toBe(42);
    expect(health.jMachines[0]?.watching).toBe(true);
    expect(health.jMachines[0]?.status).toBe('healthy');
    expect(adapter.startCount).toBe(0);
  });

  test('one env starts only one watcher for duplicate RPC jurisdiction replicas', () => {
    const primary = makeAdapter();
    const duplicate = makeAdapter({ watching: true });
    const env = makeEnv([
      ['primary', makeReplica(primary)],
      ['duplicate', makeReplica(duplicate)],
    ]);

    startJurisdictionWatchers(env);

    expect(primary.startCount).toBe(1);
    expect(primary.isWatching()).toBe(true);
    expect(duplicate.stopCount).toBe(1);
    expect(duplicate.isWatching()).toBe(false);
  });
});
