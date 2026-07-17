import { expect, test } from 'bun:test';
import { restoredRuntimeRouteRelocated } from '../orchestrator/restored-gossip-route';

const runtimeId = '0x1111111111111111111111111111111111111111';

test('restored runtime route resets only when the local signed endpoint moved', () => {
  const profile = {
    runtimeId,
    wsUrl: 'ws://127.0.0.1:19710/ws',
    relays: ['ws://127.0.0.1:19704/relay'],
  };

  expect(restoredRuntimeRouteRelocated([profile], {
    runtimeId,
    wsUrl: profile.wsUrl,
    relayUrls: profile.relays,
  })).toBe(false);
  expect(restoredRuntimeRouteRelocated([profile], {
    runtimeId,
    wsUrl: 'ws://127.0.0.1:19810/ws',
    relayUrls: ['ws://127.0.0.1:19804/relay'],
  })).toBe(true);
});

test('remote profile endpoints never trigger local relocation cleanup', () => {
  expect(restoredRuntimeRouteRelocated([{
    runtimeId: '0x2222222222222222222222222222222222222222',
    wsUrl: 'ws://127.0.0.1:19711/ws',
    relays: ['ws://127.0.0.1:19704/relay'],
  }], {
    runtimeId,
    wsUrl: 'ws://127.0.0.1:19810/ws',
    relayUrls: ['ws://127.0.0.1:19804/relay'],
  })).toBe(false);
});
