import { describe, expect, test } from 'bun:test';
import { buildPublicHubDiscoveryPayload, getDebugEntityEntries } from '../orchestrator/public-discovery';
import type { HubChild } from '../orchestrator/orchestrator-types';
import { createRelayStore } from '../relay/store';

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
  restartTimer: null,
  restartCount: 0,
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
      primaryJurisdictionFallback: null,
      serverTime: 1234,
    });
    const debugEntries = getDebugEntityEntries({
      requestUrl: new URL('http://localhost/api/debug/entities?limit=5000'),
      relayStore,
      hubChildren,
      serverTime: 1234,
    });

    expect(publicPayload.hubs.map((hub) => [hub.entityId, hub.metadata.jurisdiction?.name]).sort()).toEqual([
      [TESTNET_HUB_ID, 'Testnet'],
      [TRON_HUB_ID, 'Tron'],
    ]);
    expect(debugEntries.map((entry) => [entry.entityId, jurisdictionNameOf(entry)]).sort()).toEqual([
      [TESTNET_HUB_ID, 'Testnet'],
      [TRON_HUB_ID, 'Tron'],
    ]);
  });
});
