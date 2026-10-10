import { describe, expect, test } from 'bun:test';
import {
  buildPublicHubDiscoveryPayload,
  getDebugEntityEntries,
  parseDebugEntityLimit,
} from '../../../orchestrator/hub/public-discovery';
import { maybeHandleOrchestratorDebugApi } from '../../../orchestrator/debug-api';
import type { HubChild, MarketMakerChild } from '../../../orchestrator/orchestrator-types';
import { createRelayStore } from '../../../network/relay/store';

const RUNTIME_ID = '0x' + '11'.repeat(20);
const TESTNET_HUB_ID = '0x' + 'aa'.repeat(32);
const TRON_HUB_ID = '0x' + 'bb'.repeat(32);

const makeHubChild = (): HubChild => ({
  name: 'H1',
  region: 'local',
  seed: 'h1-seed',
  authSeed: 'h1-auth',
  signerLabel: 'h1',
  apiPort: 8082,
  publicPort: 9082,
  dbPath: '/tmp/xln-h1',
  deployTokens: true,
  proc: { exitCode: null } as unknown as NonNullable<HubChild['proc']>,
  startedAt: 1,
  exitedAt: null,
  exitCode: null,
  exitSignal: null,
  restartTimer: null,
  restartCount: 0,
  recoveryInProgress: false,
  failureCounts: {},
  recentStdout: [],
  recentStderr: [],
  lastHealth: {
    ok: true,
    name: 'H1',
    entityId: TESTNET_HUB_ID,
    runtimeId: RUNTIME_ID,
    directWsUrl: 'ws://127.0.0.1:9082',
  },
  lastInfo: {
    name: 'H1',
    entityId: TESTNET_HUB_ID,
    runtimeId: RUNTIME_ID,
    directWsUrl: 'ws://127.0.0.1:9082',
    hubEntities: [
      {
        entityId: TESTNET_HUB_ID,
        name: 'H1',
        jurisdictionName: 'Testnet',
        chainId: 31337,
        depositoryAddress: '0x' + '12'.repeat(20),
        entityProviderAddress: '0x' + '13'.repeat(20),
        primary: true,
      },
      {
        entityId: TRON_HUB_ID,
        name: 'H1',
        jurisdictionName: 'Tron',
        chainId: 31338,
        depositoryAddress: '0x' + '22'.repeat(20),
        entityProviderAddress: '0x' + '23'.repeat(20),
        primary: false,
      },
    ],
  },
});

const jurisdictionNameOf = (entry: { metadata: Record<string, unknown> }): string | undefined => {
  const jurisdiction = entry.metadata['jurisdiction'];
  if (!jurisdiction || typeof jurisdiction !== 'object') return undefined;
  const name = (jurisdiction as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
};

describe('public discovery', () => {
  test('debug entities preserve all managed hub jurisdiction metadata', () => {
    const relayStore = createRelayStore('debug-test');
    const hubChildren = [makeHubChild()];

    const publicPayload = buildPublicHubDiscoveryPayload({
      hubChildren,
      relayStore,
      defaultJurisdiction: null,
      serverTime: 1234,
    });
    const debugEntries = getDebugEntityEntries({
      limit: parseDebugEntityLimit('5000'),
      requestUrl: new URL('http://localhost/api/debug/entities?limit=5000'),
      relayStore,
      hubChildren,
      serverTime: 1234,
    });

    expect(publicPayload.hubs.map((hub) => [hub.entityId, hub.metadata.jurisdiction?.name]).sort()).toEqual([
      [TESTNET_HUB_ID, 'Testnet'],
      [TRON_HUB_ID, 'Tron'],
    ]);
    expect(publicPayload.hubs.every((hub) => hub.roleSource === 'operator-config')).toBe(true);
    expect(debugEntries.map((entry) => [entry.entityId, jurisdictionNameOf(entry)]).sort()).toEqual([
      [TESTNET_HUB_ID, 'Testnet'],
      [TRON_HUB_ID, 'Tron'],
    ]);
  });

  test('debug entities reject a malformed limit instead of returning an empty list', () => {
    const relayStore = createRelayStore('debug-limit-test');
    const hubChildren = [makeHubChild()];
    const entries = (limit: string): number => getDebugEntityEntries({
      requestUrl: new URL(`http://localhost/api/debug/entities?limit=${limit}`),
      relayStore,
      hubChildren,
      limit: parseDebugEntityLimit(limit),
      serverTime: 1234,
    }).length;

    expect(entries('1')).toBe(1);
    expect(entries('99999')).toBe(2);
    for (const malformed of ['abc', '0', '-5', '1.5', '1e3']) {
      expect(() => entries(malformed)).toThrow('DEBUG_ENTITY_LIMIT_INVALID');
    }
  });

  test('the debug entities route answers a malformed limit with 400 before polling any hub', async () => {
    let polls = 0;
    const url = new URL('http://localhost/api/debug/entities?limit=abc');
    const response = await maybeHandleOrchestratorDebugApi({
      request: new Request(url),
      pathname: url.pathname,
      url,
      headers: { 'content-type': 'application/json' },
      hubApiHost: '127.0.0.1',
      relayStore: createRelayStore('debug-limit-route-test'),
      hubChildren: [makeHubChild()],
      // Never read: the limit is refused first.
      marketMakerChild: {} as MarketMakerChild,
      operatorAuthorized: true,
      pollAllHubHealth: async () => { polls += 1; },
      pollMarketMakerHealth: async () => { polls += 1; },
    });
    // It surfaced as a 500 after a full poll of every hub.
    expect(response?.status).toBe(400);
    expect(((await response?.json()) as { code?: string }).code).toBe('DEBUG_ENTITY_LIMIT_INVALID');
    expect(polls).toBe(0);
  });
});
