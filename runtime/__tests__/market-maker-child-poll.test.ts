import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { createMarketMakerChildPoller } from '../orchestrator/market-maker-child-poll';
import type { MarketMakerChild, MarketMakerHealthPayload } from '../orchestrator/orchestrator-types';

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
};

const createChild = (): MarketMakerChild => {
  const proc = { exitCode: null } as ChildProcess;
  return {
    name: 'MM',
    seed: 'mm-seed',
    authSeed: 'mm-auth',
    signerLabel: 'mm',
    apiPort: 21040,
    publicPort: 443,
    dbPath: '/tmp/mm-child-poll-test',
    proc,
    startedAt: Date.now(),
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
    restartTimer: null,
    restartCount: 1,
    failureCounts: {},
    lastHealth: null,
    lastInfo: null,
    lastStartupPhase: null,
    recentStdout: [],
    recentStderr: [],
  };
};

describe('market maker child poller', () => {
  test('uses one cached health request for identity, phase and readiness', async () => {
    const child = createChild();
    const health = createDeferred<MarketMakerHealthPayload | null>();
    const calls: string[] = [];

    const poller = createMarketMakerChildPoller({
      child,
      host: '127.0.0.1',
      healthTimeoutMs: 30_000,
      fullHealthTimeoutMs: 50,
      fetchJson: async <T>(url: string): Promise<T | null> => {
        calls.push(url);
        if (url.endsWith('/api/health')) {
          return await health.promise as T | null;
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    const firstPoll = poller.pollHealth();
    const concurrentPoll = poller.pollHealth();

    health.resolve({
      runtimeId: 'runtime-health',
      entityId: 'entity-health',
      startupPhase: 'health-late',
      marketMaker: {
        enabled: true,
        ok: false,
        entityId: 'entity-health',
        expectedOffersPerHub: 60,
        hubs: [],
      },
    });
    await Promise.all([firstPoll, concurrentPoll]);

    expect(child.lastHealth?.runtimeId).toBe('runtime-health');
    expect(child.lastInfo).toMatchObject({
      runtimeId: 'runtime-health',
      entityId: 'entity-health',
      startupPhase: 'health-late',
    });
    expect(child.lastStartupPhase).toBe('health-late');
    expect(calls).toEqual(['http://127.0.0.1:21040/api/health']);
  });
});
