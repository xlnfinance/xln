import { describe, expect, test } from 'bun:test';
import type { Profile } from '../networking/gossip';
import { createRelayStore, storeVerifiedGossipProfile } from '../relay-store';
import { createEmptyEnv } from '../runtime';
import { handleRuntimeHealth, type RuntimeHealthCacheEntry, type RuntimeHealthDeps } from '../server/health-api';
import { createMarketMakerServerState } from '../server/market-maker-health';

const runtimeSecret = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const makeHubProfile = (suffix: string, updatedAt = 1): Profile => ({
  entityId: `0x${suffix.padStart(40, '0')}`,
  name: `Hub ${suffix}`,
  avatar: '',
  bio: '',
  website: '',
  lastUpdated: updatedAt,
  runtimeId: `0x${suffix.padStart(40, '1')}`,
  runtimeEncPubKey: `0x${suffix.padStart(64, '2')}`,
  publicAccounts: [],
  wsUrl: null,
  relays: [],
  metadata: {
    entityEncPubKey: `0x${suffix.padStart(64, '3')}`,
    isHub: true,
    routingFeePPM: 1,
    baseFee: 0n,
    board: {
      threshold: 1,
      validators: [{ signer: `0x${suffix.padStart(40, '4')}`, signerId: '1', publicKey: `0x${suffix.padStart(64, '5')}`, weight: 1 }],
    },
  },
  accounts: [],
});

const createHealthDeps = () => {
  let inFlightSetCount = 0;
  let cachedResponseSetCount = 0;
  const relayStore = createRelayStore('test-health');
  relayStore.clients.set(runtimeSecret, {
    runtimeId: runtimeSecret,
    lastSeen: Date.now(),
    topics: new Set(['health']),
    ws: { send: () => true, readyState: 1 },
  });

  const deps: RuntimeHealthDeps = {
    env: null,
    relayStore,
    healthCacheTtlMs: 60_000,
    cachedHealthResponse: null,
    setCachedHealthResponse(entry: RuntimeHealthCacheEntry | null): void {
      cachedResponseSetCount += entry ? 1 : 0;
      deps.cachedHealthResponse = entry;
    },
    cachedHealthInFlight: null,
    setCachedHealthInFlight(work: Promise<{ fullBody: string; publicBody: string }> | null): void {
      inFlightSetCount += work ? 1 : 0;
      deps.cachedHealthInFlight = work;
    },
    boot: {
      phase: 'test',
      startedAt: 1,
      completedAt: null,
      error: 'operator-only boot error',
    },
    activeHubEntityIds: [],
    marketMakerState: createMarketMakerServerState(),
    getAccountMachine(): never {
      throw new Error('getAccountMachine must not be called without env');
    },
    ensureTokenCatalog(): never {
      throw new Error('ensureTokenCatalog must not be called without env');
    },
  };

  return {
    deps,
    relayStore,
    getInFlightSetCount: () => inFlightSetCount,
    getCachedResponseSetCount: () => cachedResponseSetCount,
  };
};

describe('runtime health API handler', () => {
  test('coalesces concurrent health requests through one in-flight computation', async () => {
    const { deps, getInFlightSetCount, getCachedResponseSetCount } = createHealthDeps();
    const req = new Request('http://127.0.0.1:8080/api/health');

    const [first, second] = await Promise.all([
      handleRuntimeHealth(req, { 'Content-Type': 'application/json' }, deps),
      handleRuntimeHealth(req, { 'Content-Type': 'application/json' }, deps),
    ]);

    const firstBody = await first.text();
    const secondBody = await second.text();
    expect(firstBody).toBe(secondBody);
    expect(firstBody).toContain(runtimeSecret);
    expect(getInFlightSetCount()).toBe(1);
    expect(getCachedResponseSetCount()).toBe(1);
    expect(deps.cachedHealthInFlight).toBeNull();
  });

  test('serves cached public health response without leaking operator-only fields', async () => {
    const { deps, relayStore, getCachedResponseSetCount } = createHealthDeps();
    const operatorReq = new Request('http://127.0.0.1:8080/api/health');
    const publicReq = new Request('https://xln.finance/api/health');

    await handleRuntimeHealth(operatorReq, { 'Content-Type': 'application/json' }, deps);
    expect(getCachedResponseSetCount()).toBe(1);

    relayStore.clients.set('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', {
      runtimeId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      lastSeen: Date.now(),
      topics: new Set(['late']),
      ws: { send: () => true, readyState: 1 },
    });

    const publicResponse = await handleRuntimeHealth(publicReq, { 'Content-Type': 'application/json' }, deps);
    const publicBody = await publicResponse.text();
    const publicJson = JSON.parse(publicBody) as { relay?: { activeClientCount?: number }; boot?: { error?: string } };

    expect(getCachedResponseSetCount()).toBe(1);
    expect(publicJson.relay?.activeClientCount).toBe(1);
    expect(publicJson.boot?.error).toBe('redacted');
    expect(publicBody).not.toContain(runtimeSecret);
    expect(publicBody).not.toContain('operator-only boot error');
  });

  test('scopes hub mesh and market maker health to runtimes that own those roles', async () => {
    const { deps, relayStore } = createHealthDeps();
    deps.env = createEmptyEnv('runtime-health-non-hub-daemon');
    deps.env.quietRuntimeLogs = true;
    expect(storeVerifiedGossipProfile(relayStore, makeHubProfile('a'))).toBe(true);

    const response = await handleRuntimeHealth(
      new Request('http://127.0.0.1:8080/api/health'),
      { 'Content-Type': 'application/json' },
      deps,
    );
    const body = JSON.parse(await response.text()) as {
      hubs?: unknown[];
      hubMesh?: Record<string, unknown>;
      marketMaker?: Record<string, unknown>;
      bootstrapReserves?: Record<string, unknown>;
      system?: { runtime?: boolean };
    };

    expect(body.system?.runtime).toBe(true);
    expect(body.hubs).toEqual([]);
    expect(body.hubMesh).toMatchObject({
      applicable: false,
      ok: true,
      reason: 'no-active-hub-entities',
      hubIds: [],
      pairs: [],
    });
    expect(body.marketMaker).toMatchObject({
      applicable: false,
      enabled: false,
      ok: true,
      hubs: [],
    });
    expect(body.bootstrapReserves).toMatchObject({
      applicable: false,
      ok: true,
      entityCount: 0,
      entities: [],
    });
  });
});
