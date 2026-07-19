import { describe, expect, test } from 'bun:test';
import {
  buildHubBaselineProgressSignature,
  evaluateHubBaselineDeadlines,
} from '../orchestrator/hub-baseline-progress';
import type { HubHealthPayload } from '../orchestrator/orchestrator-types';
import { validateHubHealthPayload } from '../orchestrator/bootstrap-health-validation';

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

const p2pReady = {
  p2p_connect: { startedAt: 1, completedAt: 2, ms: 1 },
} as HubHealthPayload['timings'];

describe('hub baseline progress', () => {
  test('rejects malformed observed collections before they can fabricate progress', () => {
    expect(() => validateHubHealthPayload({
      height: 1,
      gossip: { visibleHubNames: { H1: true } },
    })).toThrow('BOOTSTRAP_HEALTH_PAYLOAD_INVALID:path=gossip.visibleHubNames:expected=array');
    expect(() => validateHubHealthPayload({
      height: 1.5,
      mesh: { pairs: [] },
    })).toThrow('BOOTSTRAP_HEALTH_PAYLOAD_INVALID:path=health.height:expected=nonnegative-safe-integer');
    expect(() => validateHubHealthPayload({
      height: 1,
      mesh: { pairs: [{ counterpartyId: 'h2' }] },
    })).toThrow('BOOTSTRAP_HEALTH_PAYLOAD_INVALID:path=mesh.pairs[0].currentHeight:expected=nonnegative-safe-integer');
  });

  test('counts runtime frames while startup catch-up is still forming', () => {
    expect(signature(health({ height: 2 }))).not.toBe(signature(health({ height: 1 })));
  });

  test('does not let heartbeat height mask a stalled post-P2P baseline', () => {
    const gossip = { visibleHubNames: ['H1', 'H2', 'H3'], visibleHubIds: ['h1', 'h2', 'h3'], ready: true };
    expect(signature(health({ height: 2, gossip, timings: p2pReady }))).toBe(
      signature(health({ height: 1, gossip, timings: p2pReady })),
    );
  });

  test('counts causal account changes after P2P', () => {
    const gossip = { visibleHubNames: ['H1', 'H2', 'H3'], visibleHubIds: ['h1', 'h2', 'h3'], ready: true };
    const before = health({ height: 2, gossip, timings: p2pReady });
    const accountProgress = health({
      height: 3,
      gossip,
      timings: p2pReady,
      mesh: {
        ready: false,
        pairs: [{
          counterpartyId: 'h2',
          counterpartyName: 'H2',
          hasAccount: true,
          currentHeight: 1,
          pendingFrameHeight: null,
          pendingFrameHash: null,
          grantedByMe: '1',
          grantedByPeer: '0',
          ready: false,
        }],
      },
    });
    expect(signature(accountProgress)).not.toBe(signature(before));
  });

  test('counts an exact pending Account proposal while bilateral credit is unchanged', () => {
    const pair = {
      counterpartyId: 'h2',
      counterpartyName: 'H2',
      hasAccount: true,
      currentHeight: 1,
      pendingFrameHeight: null,
      pendingFrameHash: null,
      grantedByMe: '0',
      grantedByPeer: '1',
      ready: false,
    };
    const before = health({ timings: p2pReady, mesh: { ready: false, pairs: [pair] } });
    const after = health({
      timings: p2pReady,
      mesh: {
        ready: false,
        pairs: [{ ...pair, pendingFrameHeight: 2, pendingFrameHash: '0xproposal' }],
      },
    });

    expect(signature(after)).not.toBe(signature(before));
  });

  test('ignores mesh-loop clocks and labels after P2P', () => {
    const before = health({ timings: p2pReady });
    const after = health({
      timings: p2pReady,
      bootstrapProgress: {
        ...before.bootstrapProgress!,
        idleMs: 50_000,
        lastProgressAtMs: 51_000,
        step: 'idle',
        totalMs: 50_000,
      },
    });
    expect(signature(after)).toBe(signature(before));
  });

  test('counts a new active child bootstrap step without trusting its clock', () => {
    const before = health({
      timings: p2pReady,
      bootstrapProgress: {
        ...health().bootstrapProgress!,
        active: true,
        step: 'peer-reserve:fund-batch:Testnet:start',
      },
    });
    const after = health({
      timings: p2pReady,
      bootstrapProgress: {
        ...before.bootstrapProgress!,
        idleMs: 59_000,
        lastProgressAtMs: 60_000,
        step: 'peer-reserve:fund-events:Testnet:applied',
        totalMs: 60_000,
      },
    });

    expect(signature(after)).not.toBe(signature(before));
  });

  test('canonicalizes pair, reserve entity, and token order', () => {
    const pair = (counterpartyId: string) => ({
      counterpartyId,
      counterpartyName: counterpartyId,
      hasAccount: true,
      currentHeight: 1,
      pendingFrameHeight: null,
      pendingFrameHash: null,
      grantedByMe: '1',
      grantedByPeer: '1',
      ready: true,
    });
    const token = (tokenId: number) => ({
      tokenId,
      symbol: `T${tokenId}`,
      decimals: 6,
      current: '1',
      expectedMin: '1',
      ready: true,
      targetMet: true,
    });
    const entity = (entityId: string) => ({
      entityId,
      ready: true,
      targetMet: true,
      tokens: [token(2), token(1)],
    });
    const before = health({
      timings: p2pReady,
      mesh: { ready: false, pairs: [pair('h2'), pair('h1')] },
      bootstrapReserves: {
        ok: false,
        targetMet: false,
        tokens: [token(2), token(1)],
        entities: [entity('e2'), entity('e1')],
      },
    });
    const after = health({
      ...before,
      mesh: { ready: false, pairs: [...before.mesh!.pairs!].reverse() },
      bootstrapReserves: {
        ...before.bootstrapReserves!,
        tokens: [...before.bootstrapReserves!.tokens].reverse(),
        entities: [...before.bootstrapReserves!.entities!]
          .reverse()
          .map(value => ({ ...value, tokens: [...value.tokens].reverse() })),
      },
    });
    expect(signature(after)).toBe(signature(before));
  });

  test('tracks each incomplete hub deadline independently', () => {
    const h1 = health({ timings: p2pReady });
    const h2 = health({ timings: p2pReady });
    const initial = evaluateHubBaselineDeadlines([
      { name: 'H1', health: h1 },
      { name: 'H2', health: h2 },
    ], {}, 0, 60_000);
    const h2Progress = health({
      timings: p2pReady,
      mesh: { ready: false, pairs: [{
        counterpartyId: 'h1',
        counterpartyName: 'H1',
        hasAccount: true,
        currentHeight: 1,
        pendingFrameHeight: null,
        pendingFrameHash: null,
        grantedByMe: '0',
        grantedByPeer: '0',
        ready: false,
      }] },
    });
    const after = evaluateHubBaselineDeadlines([
      { name: 'H1', health: h1 },
      { name: 'H2', health: h2Progress },
    ], initial.state, 60_000, 60_000);

    expect(after.stalledNames).toEqual(['H1']);
    expect(after.evaluations['H1']?.stalled).toBe(true);
    expect(after.evaluations['H2']?.stalled).toBe(false);
  });

  test('counts only the exact peer mirror as causal progress for a waiting hub', () => {
    const h1 = health({ entityId: 'h1', timings: p2pReady });
    const h2 = health({ entityId: 'h2', timings: p2pReady });
    const initial = evaluateHubBaselineDeadlines([
      { name: 'H1', health: h1 },
      { name: 'H2', health: h2 },
    ], {}, 0, 60_000);
    const h2AcceptedH1 = health({
      entityId: 'h2',
      timings: p2pReady,
      mesh: { ready: false, pairs: [{
        counterpartyId: 'h1',
        counterpartyName: 'H1',
        hasAccount: true,
        currentHeight: 1,
        pendingFrameHeight: null,
        pendingFrameHash: null,
        grantedByMe: '0',
        grantedByPeer: '0',
        ready: false,
      }] },
    });
    const after = evaluateHubBaselineDeadlines([
      { name: 'H1', health: h1 },
      { name: 'H2', health: h2AcceptedH1 },
    ], initial.state, 60_000, 60_000);

    expect(after.stalledNames).toEqual([]);
    expect(after.evaluations['H1']?.progressed).toBe(true);
  });

  test('does not let an unrelated peer mirror mask a stalled hub', () => {
    const h1 = health({ entityId: 'h1', timings: p2pReady });
    const h2 = health({ entityId: 'h2', timings: p2pReady });
    const initial = evaluateHubBaselineDeadlines([
      { name: 'H1', health: h1 },
      { name: 'H2', health: h2 },
    ], {}, 0, 60_000);
    const h2AcceptedH3 = health({
      entityId: 'h2',
      timings: p2pReady,
      mesh: { ready: false, pairs: [{
        counterpartyId: 'h3',
        counterpartyName: 'H3',
        hasAccount: true,
        currentHeight: 1,
        pendingFrameHeight: null,
        pendingFrameHash: null,
        grantedByMe: '0',
        grantedByPeer: '0',
        ready: false,
      }] },
    });
    const after = evaluateHubBaselineDeadlines([
      { name: 'H1', health: h1 },
      { name: 'H2', health: h2AcceptedH3 },
    ], initial.state, 60_000, 60_000);

    expect(after.stalledNames).toEqual(['H1']);
  });
});
