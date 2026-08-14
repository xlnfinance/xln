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
  p2p.registerVisibilityReconnect = () => {
    p2p.registeredVisibility = Number(p2p.registeredVisibility || 0) + 1;
  };
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
  expect(p2p.registeredVisibility).toBe(1);
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
  expect(p2p.registeredVisibility).toBe(1);
  expect(p2p.startedPolling).toBe(1);
});

test('RuntimeP2P connect preserves a relay client waiting to reconnect', () => {
  const p2p = makeDetachedP2P({
    isOpen: () => false,
    isConnecting: () => false,
    getReconnectState: () => ({ attempt: 1, nextAt: 1_000 }),
  });

  p2p.connect();

  expect(p2p.closedClients).toBeUndefined();
  expect(p2p.registeredVisibility).toBe(1);
  expect(p2p.startedPolling).toBe(1);
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
