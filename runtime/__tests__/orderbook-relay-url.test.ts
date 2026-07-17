import { expect, test } from 'bun:test';
import { resolveOrderbookRelayWsUrl } from '../../frontend/src/lib/components/Trading/orderbook-relay-url';
import { resolveOrchestratorSocketType } from '../orchestrator/orchestrator-types';

const localHttps = {
  protocol: 'https:',
  host: 'localhost:8080',
  hostname: 'localhost',
  origin: 'https://localhost:8080',
};

test('orderbook relay resolver uses local relay only when no explicit relay is provided', () => {
  expect(resolveOrderbookRelayWsUrl('', localHttps)).toEqual({
    url: 'wss://localhost:8080/relay?protocol=market',
    explicit: false,
    usedDefault: true,
    unavailableReason: '',
  });
});

test('orderbook relay resolver converts trusted explicit relay URLs', () => {
  expect(resolveOrderbookRelayWsUrl('https://localhost:8082/relay', localHttps)).toMatchObject({
    url: 'wss://localhost:8082/relay?protocol=market',
    explicit: true,
    usedDefault: false,
    unavailableReason: '',
  });
  expect(resolveOrderbookRelayWsUrl('/relay', localHttps)).toMatchObject({
    url: 'wss://localhost:8080/relay?protocol=market',
    explicit: true,
    usedDefault: false,
    unavailableReason: '',
  });
});

test('orderbook relay resolver rejects explicit remote relay without falling back', () => {
  expect(resolveOrderbookRelayWsUrl('wss://remote.example/relay', localHttps)).toEqual({
    url: null,
    explicit: true,
    usedDefault: false,
    unavailableReason: 'Relay unavailable for selected hub',
  });
});

test('orchestrator sends peer challenges only to peer relay sockets', () => {
  expect(resolveOrchestratorSocketType('market')).toBe('market');
  expect(resolveOrchestratorSocketType(null)).toBe('relay');
  expect(resolveOrchestratorSocketType('unknown')).toBe('relay');
});
