import { describe, expect, it } from 'bun:test';

import {
  evaluateMmHealthProbeFailure,
  trackCausalProgress,
  type CausalProgressState,
} from '../scripts/bootstrap-progress';

describe('trackCausalProgress', () => {
  it('starts the progress clock on the first observed snapshot', () => {
    expect(trackCausalProgress(null, 'sig-a', 1_000)).toEqual({
      signature: 'sig-a',
      lastProgressAtMs: 1_000,
    });
  });

  it('advances the progress clock only when the snapshot changes', () => {
    const first = trackCausalProgress(null, 'sig-a', 1_000);
    const repeated = trackCausalProgress(first, 'sig-a', 5_000);
    expect(repeated).toBe(first);
    expect(repeated.lastProgressAtMs).toBe(1_000);
    const changed = trackCausalProgress(repeated, 'sig-b', 5_000);
    expect(changed).toEqual({ signature: 'sig-b', lastProgressAtMs: 5_000 });
  });

  it('treats repeated stale health as no new progress across many polls', () => {
    let state: CausalProgressState | null = null;
    state = trackCausalProgress(state, 'sig-a', 1_000);
    for (let poll = 1; poll <= 100; poll += 1) {
      state = trackCausalProgress(state, 'sig-a', 1_000 + poll * 250);
    }
    expect(state.lastProgressAtMs).toBe(1_000);
  });

  it('fails fast on invalid inputs', () => {
    expect(() => trackCausalProgress(null, '', 1_000)).toThrow('CAUSAL_PROGRESS_SIGNATURE_EMPTY');
    expect(() => trackCausalProgress(null, 'sig-a', Number.NaN)).toThrow('CAUSAL_PROGRESS_NOW_INVALID');
    expect(() => trackCausalProgress(null, 'sig-a', -1)).toThrow('CAUSAL_PROGRESS_NOW_INVALID');
    const state = trackCausalProgress(null, 'sig-a', 1_000);
    expect(() => trackCausalProgress(state, 'sig-b', 999)).toThrow('CAUSAL_PROGRESS_CLOCK_REGRESSION');
  });
});

describe('evaluateMmHealthProbeFailure', () => {
  it('continues after a transient MM health timeout while causal progress is recent', () => {
    expect(evaluateMmHealthProbeFailure({
      nowMs: 61_000,
      lastProgressAtMs: 60_000,
      noProgressFatalMs: 60_000,
    })).toEqual({ action: 'continue', msSinceProgress: 1_000 });
  });

  it('continues just below the no-progress window', () => {
    expect(evaluateMmHealthProbeFailure({
      nowMs: 119_999,
      lastProgressAtMs: 60_000,
      noProgressFatalMs: 60_000,
    })).toEqual({ action: 'continue', msSinceProgress: 59_999 });
  });

  it('goes fatal once the no-progress window is exhausted', () => {
    expect(evaluateMmHealthProbeFailure({
      nowMs: 120_000,
      lastProgressAtMs: 60_000,
      noProgressFatalMs: 60_000,
    })).toEqual({ action: 'fatal', msSinceProgress: 60_000 });
    expect(evaluateMmHealthProbeFailure({
      nowMs: 200_000,
      lastProgressAtMs: 60_000,
      noProgressFatalMs: 60_000,
    })).toEqual({ action: 'fatal', msSinceProgress: 140_000 });
  });

  it('fails fast on invalid clocks and windows', () => {
    expect(() => evaluateMmHealthProbeFailure({
      nowMs: Number.NaN,
      lastProgressAtMs: 0,
      noProgressFatalMs: 60_000,
    })).toThrow('MM_HEALTH_PROBE_NOW_INVALID');
    expect(() => evaluateMmHealthProbeFailure({
      nowMs: 1_000,
      lastProgressAtMs: Number.NaN,
      noProgressFatalMs: 60_000,
    })).toThrow('MM_HEALTH_PROBE_PROGRESS_AT_INVALID');
    expect(() => evaluateMmHealthProbeFailure({
      nowMs: 1_000,
      lastProgressAtMs: 0,
      noProgressFatalMs: 0,
    })).toThrow('MM_HEALTH_PROBE_FATAL_WINDOW_INVALID');
    expect(() => evaluateMmHealthProbeFailure({
      nowMs: 500,
      lastProgressAtMs: 1_000,
      noProgressFatalMs: 60_000,
    })).toThrow('MM_HEALTH_PROBE_CLOCK_REGRESSION');
  });
});
