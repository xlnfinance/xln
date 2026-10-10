import { expect, test } from 'bun:test';
import { normalizeWsUrl, sameWsEndpoint } from '../../../../frontend/src/lib/utils/runtime/wsUrl';
import { canonicalizeRuntimeWsAudience } from '../../../../core/network/p2p/ws-protocol';

test('relay connection preserves the exact configured origin used by signed hello authentication', () => {
  for (const origin of ['ws://127.0.0.1:20002', 'ws://localhost:8080', 'ws://[::1]:8080', 'wss://xln.finance']) {
    const relay = normalizeWsUrl(`${origin}/relay/`);
    expect(relay).toBe(`${origin}/relay`);
    expect(canonicalizeRuntimeWsAudience(relay)).toBe(canonicalizeRuntimeWsAudience(`${origin}/relay`));
  }
});

test('loopback aliases may share a settings key without rewriting the authenticated connection', () => {
  expect(sameWsEndpoint('ws://localhost:8080/relay', 'ws://127.0.0.1:8080/relay/')).toBe(true);
  expect(sameWsEndpoint('ws://localhost:8080/relay', 'ws://127.0.0.1:8081/relay')).toBe(false);
  expect(sameWsEndpoint('ws://localhost:8080/relay', 'wss://localhost:8080/relay')).toBe(false);
});
