import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { createMarketMakerChildPoller } from '../orchestrator/market-maker-child-poll';
import type { MarketMakerChild, MarketMakerHealthPayload, MarketMakerInfoPayload } from '../orchestrator/orchestrator-types';

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
  test('refreshes info independently while shared health poll is still in flight', async () => {
    const child = createChild();
    const health = createDeferred<MarketMakerHealthPayload | null>();
    const calls: string[] = [];
    let infoCalls = 0;

    const poller = createMarketMakerChildPoller({
      child,
      host: '127.0.0.1',
      infoTimeoutMs: 50,
      healthTimeoutMs: 30_000,
      fullHealthTimeoutMs: 50,
      fetchJson: async <T>(url: string): Promise<T | null> => {
        calls.push(url);
        if (url.endsWith('/api/info')) {
          infoCalls += 1;
          return {
            runtimeId: `runtime-${infoCalls}`,
            entityId: `entity-${infoCalls}`,
            startupPhase: `info-${infoCalls}`,
          } satisfies MarketMakerInfoPayload as T;
        }
        if (url.endsWith('/api/health')) {
          return await health.promise as T | null;
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    const healthPoll = poller.pollHealth();
    await poller.pollInfo();

    expect(infoCalls).toBe(2);
    expect(child.lastInfo?.runtimeId).toBe('runtime-2');
    expect(child.lastStartupPhase).toBe('info-2');
    expect(calls.filter(url => url.endsWith('/api/health'))).toHaveLength(1);

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
    await healthPoll;

    expect(child.lastHealth?.runtimeId).toBe('runtime-health');
    expect(child.lastInfo?.startupPhase).toBe('info-2');
    expect(child.lastStartupPhase).toBe('info-2');
  });
});
