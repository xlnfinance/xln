import { describe, expect, test } from 'bun:test';
import { deriveMarketMakerChildReadiness } from '../orchestrator/market-maker-child-readiness';

const readyInput = {
  runtimeHalted: false,
  startupPhase: 'offers-ready',
  gossipReady: true,
  marketMakerReady: true,
};

describe('market-maker child readiness', () => {
  test('does not confuse process liveness with book readiness', () => {
    expect(deriveMarketMakerChildReadiness({
      ...readyInput,
      startupPhase: 'bootstrap-offers',
    })).toEqual({ live: true, ready: false });
    expect(deriveMarketMakerChildReadiness({
      ...readyInput,
      marketMakerReady: false,
    })).toEqual({ live: true, ready: false });
    expect(deriveMarketMakerChildReadiness({
      ...readyInput,
      gossipReady: false,
    })).toEqual({ live: true, ready: false });
  });

  test('requires a live runtime and every readiness condition', () => {
    expect(deriveMarketMakerChildReadiness(readyInput)).toEqual({
      live: true,
      ready: true,
    });
    expect(deriveMarketMakerChildReadiness({
      ...readyInput,
      runtimeHalted: true,
    })).toEqual({ live: false, ready: false });
  });
});
