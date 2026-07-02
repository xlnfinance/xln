import { expect, test } from 'bun:test';

import { RuntimeP2P } from '../networking/p2p';

type FakeRelayClient = {
  isOpen: () => boolean;
  isConnecting: () => boolean;
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
  p2p.startRetryLoop = () => {
    p2p.startedRetryLoop = Number(p2p.startedRetryLoop || 0) + 1;
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
  });

  p2p.connect();

  expect(p2p.isConnecting()).toBe(true);
  expect(p2p.closedClients).toBeUndefined();
  expect(p2p.registeredVisibility).toBe(1);
  expect(p2p.startedPolling).toBe(1);
  expect(p2p.startedRetryLoop).toBe(1);
});

test('RuntimeP2P connect is idempotent while relay client is open', () => {
  const p2p = makeDetachedP2P({
    isOpen: () => true,
    isConnecting: () => false,
  });

  p2p.connect();

  expect(p2p.isConnected()).toBe(true);
  expect(p2p.closedClients).toBeUndefined();
  expect(p2p.registeredVisibility).toBe(1);
  expect(p2p.startedPolling).toBe(1);
  expect(p2p.startedRetryLoop).toBe(1);
});
