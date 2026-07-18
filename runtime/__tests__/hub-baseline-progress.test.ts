import { describe, expect, test } from 'bun:test';
import { buildHubBaselineProgressSignature } from '../orchestrator/hub-baseline-progress';
import type { HubHealthPayload } from '../orchestrator/orchestrator-types';

const health = (overrides: Partial<HubHealthPayload> = {}): HubHealthPayload => ({
  height: 1,
  gossip: { visibleHubNames: ['H1'], visibleHubIds: ['h1'], ready: false },
  mesh: { ready: false, pairs: [] },
  bootstrapProgress: {
    active: false,
    idleMs: 0,
    lastProgressAtMs: 1,
    stallTimeoutMs: 60_000,
    startedAtMs: 1,
    step: 'start',
    totalMs: 0,
  },
  bootstrapReserves: { ok: false, targetMet: false, tokens: [], entities: [] },
  ...overrides,
});

const signature = (value: HubHealthPayload): string =>
  buildHubBaselineProgressSignature([{ name: 'H1', health: value }]);

describe('hub baseline progress', () => {
  test('counts runtime frames while startup gossip is still forming', () => {
    expect(signature(health({ height: 2 }))).not.toBe(signature(health({ height: 1 })));
  });

  test('does not let heartbeat height mask a stalled post-gossip baseline', () => {
    const gossip = { visibleHubNames: ['H1', 'H2', 'H3'], visibleHubIds: ['h1', 'h2', 'h3'], ready: true };
    expect(signature(health({ height: 2, gossip }))).toBe(signature(health({ height: 1, gossip })));
  });

  test('counts causal account and bootstrap-step changes after gossip', () => {
    const gossip = { visibleHubNames: ['H1', 'H2', 'H3'], visibleHubIds: ['h1', 'h2', 'h3'], ready: true };
    const before = health({ height: 2, gossip });
    const accountProgress = health({
      height: 3,
      gossip,
      mesh: {
        ready: false,
        pairs: [{
          counterpartyId: 'h2',
          counterpartyName: 'H2',
          hasAccount: true,
          grantedByMe: '1',
          grantedByPeer: '0',
          ready: false,
        }],
      },
    });
    expect(signature(accountProgress)).not.toBe(signature(before));
  });
});
