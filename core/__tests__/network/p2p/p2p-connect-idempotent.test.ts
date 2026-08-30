import { expect, test } from 'bun:test';
import { Wallet, getBytes } from 'ethers';

import { RuntimeP2P } from '../../../network/p2p/p2p';
import { createEmptyEnv } from '../../../runtime';
import { createJurisdictionGossipAnnouncement } from '../../../jurisdiction/gossip/announcement';

type FakeRelayClient = {
  isOpen: () => boolean;
  isConnecting: () => boolean;
  getReconnectState: () => { attempt: number; nextAt: number } | null;
};

const makeDetachedP2P = (client: FakeRelayClient): RuntimeP2P & Record<string, unknown> => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, unknown>;
  p2p.clients = [client];
  p2p.relayUrls = [];
  p2p.startPolling = () => {
    p2p.startedPolling = Number(p2p.startedPolling || 0) + 1;
  };
  p2p.closeClients = () => {
    p2p.closedClients = Number(p2p.closedClients || 0) + 1;
  };
  return p2p;
};

test('RuntimeP2P connect is idempotent while relay client is connecting', () => {
  const p2p = makeDetachedP2P({
    isOpen: () => false,
    isConnecting: () => true,
    getReconnectState: () => null,
  });

  p2p.connect();

  expect(p2p.isConnecting()).toBe(true);
  expect(p2p.closedClients).toBeUndefined();
  expect(p2p.startedPolling).toBe(1);
});

test('RuntimeP2P connect is idempotent while relay client is open', () => {
  const p2p = makeDetachedP2P({
    isOpen: () => true,
    isConnecting: () => false,
    getReconnectState: () => null,
  });

  p2p.connect();

  expect(p2p.isConnected()).toBe(true);
  expect(p2p.closedClients).toBeUndefined();
  expect(p2p.startedPolling).toBe(1);
});

test('RuntimeP2P connect rejects a retired reconnect timer as live transport activity', () => {
  const p2p = makeDetachedP2P({
    isOpen: () => false,
    isConnecting: () => false,
    getReconnectState: () => ({ attempt: 1, nextAt: 1_000 }),
  });

  p2p.connect();

  expect(p2p.closedClients).toBe(1);
  expect(p2p.startedPolling).toBe(1);
});

test('RuntimeP2P pauses gossip timers without closing established transport', () => {
  const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, unknown>;
  const announceTimer = setTimeout(() => {}, 60_000);
  const prefetchTimer = setTimeout(() => {}, 60_000);
  p2p.backgroundIoPaused = false;
  p2p.announceTimer = announceTimer;
  p2p.profilePrefetchTimer = prefetchTimer;
  p2p.pendingAnnounceEntities = new Set(['entity']);
  p2p.pendingProfilePrefetchIds = new Set(['profile']);
  p2p.stopPolling = () => { p2p.pollingStopped = true; };
  p2p.clients = [{ transport: 'still-open' }];

  p2p.pauseBackgroundIo();

  expect(p2p.backgroundIoPaused).toBe(true);
  expect(p2p.pollingStopped).toBe(true);
  expect(p2p.announceTimer).toBeNull();
  expect(p2p.profilePrefetchTimer).toBeNull();
  expect(p2p.pendingAnnounceEntities).toEqual(new Set());
  expect(p2p.pendingProfilePrefetchIds).toEqual(new Set());
  expect(p2p.clients).toEqual([{ transport: 'still-open' }]);
});

test('RuntimeP2P reconnect flushes locally queued jurisdiction discovery without local profiles', async () => {
  const privateKey = `0x${'55'.repeat(32)}`;
  const signerId = new Wallet(privateKey).address.toLowerCase();
  const announcement = createJurisdictionGossipAnnouncement({
    scope: 'community',
    key: 'queued-chain',
    name: 'Queued Chain',
    rpcUrl: 'https://queued.example/rpc',
    blockTimeMs: 1_000,
    currency: 'ETH',
    explorer: '',
    chainId: 99,
    deployer: signerId,
    foundationRecipient: signerId,
    entityProviderDeploymentBlock: 1,
    contracts: {
      account: `0x${'01'.repeat(20)}`,
      depositoryBounds: `0x${'02'.repeat(20)}`,
      hashLadderRegistry: `0x${'03'.repeat(20)}`,
      nftCustody: `0x${'04'.repeat(20)}`,
      hankoVerifier: `0x${'05'.repeat(20)}`,
      entityProvider: `0x${'06'.repeat(20)}`,
      depository: `0x${'07'.repeat(20)}`,
      deltaTransformer: `0x${'08'.repeat(20)}`,
    },
    stablecoin: { symbol: 'USDT', address: `0x${'09'.repeat(20)}`, tokenId: 1, decimals: 6 },
  }, getBytes(privateKey));
  const env = createEmptyEnv('queued-jurisdiction-gossip');
  env.gossip.announceJurisdiction(announcement);
  const sent: unknown[] = [];
  const p2p = new RuntimeP2P({
    env,
    runtimeId: signerId,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
  });
  Object.defineProperty(p2p, 'clients', { value: [{
    isOpen: () => true,
    sendGossipAnnounce: (_from: string, payload: unknown) => {
      sent.push(payload);
      return true;
    },
  }] });

  await p2p.announceLocalProfiles();

  expect(sent).toEqual([{ profiles: [], jurisdictions: [announcement] }]);
});

test('RuntimeP2P accepts a reconnect batch above one authority-scope cap and rejects above both caps', async () => {
  const privateKey = `0x${'56'.repeat(32)}`;
  const signerId = new Wallet(privateKey).address.toLowerCase();
  const announcement = createJurisdictionGossipAnnouncement({
    scope: 'community',
    key: 'full-scope-chain',
    name: 'Full Scope Chain',
    rpcUrl: 'https://full-scope.example/rpc',
    blockTimeMs: 1_000,
    currency: 'ETH',
    explorer: '',
    chainId: 100,
    deployer: signerId,
    foundationRecipient: signerId,
    entityProviderDeploymentBlock: 1,
    contracts: {
      account: `0x${'11'.repeat(20)}`,
      depositoryBounds: `0x${'12'.repeat(20)}`,
      hashLadderRegistry: `0x${'13'.repeat(20)}`,
      nftCustody: `0x${'14'.repeat(20)}`,
      hankoVerifier: `0x${'15'.repeat(20)}`,
      entityProvider: `0x${'16'.repeat(20)}`,
      depository: `0x${'17'.repeat(20)}`,
      deltaTransformer: `0x${'18'.repeat(20)}`,
    },
    stablecoin: { symbol: 'USDT', address: `0x${'19'.repeat(20)}`, tokenId: 1, decimals: 6 },
  }, getBytes(privateKey));
  const accepted: unknown[] = [];
  const p2p = new RuntimeP2P({
    env: createEmptyEnv('full-scope-jurisdiction-gossip'),
    runtimeId: signerId,
    onEntityInputs: () => {},
    onGossipProfiles: () => {},
    onGossipJurisdictions: (_from, values) => accepted.push(...values),
  });
  await expect(p2p.admitGossipAnnouncement(signerId, {
    profiles: [],
    jurisdictions: Array.from({ length: 129 }, () => announcement),
  })).resolves.toBeUndefined();
  expect(accepted).toEqual([announcement]);
  await expect(p2p.admitGossipAnnouncement(signerId, {
    profiles: [],
    jurisdictions: Array.from({ length: 257 }, () => announcement),
  })).rejects.toThrow('P2P_GOSSIP_RESPONSE_JURISDICTION_BATCH_TOO_LARGE');
});
