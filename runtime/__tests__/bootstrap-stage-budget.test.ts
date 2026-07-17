import { describe, expect, test } from 'bun:test';

import { getHubMeshBudgetElapsedMs } from '../scripts/bootstrap-stage-budget';

describe('local production bootstrap stage budgets', () => {
  test('does not charge jurisdiction deployment time to the hub mesh budget', () => {
    expect(getHubMeshBudgetElapsedMs({
      nowMs: 41_000,
      resetStartedAt: 1_000,
      spawnH1StartedAt: null,
      readyAt: null,
    })).toBeNull();
  });

  test('charges the complete managed hub boot from H1 spawn through mesh readiness', () => {
    expect(getHubMeshBudgetElapsedMs({
      nowMs: 90_000,
      resetStartedAt: 1_000,
      spawnH1StartedAt: 50_000,
      readyAt: 57_900,
    })).toBe(7_900);
    expect(getHubMeshBudgetElapsedMs({
      nowMs: 58_001,
      resetStartedAt: 1_000,
      spawnH1StartedAt: 50_000,
      readyAt: null,
    })).toBe(8_001);
  });

  test('ignores a stale spawn timestamp from an earlier reset generation', () => {
    expect(getHubMeshBudgetElapsedMs({
      nowMs: 90_000,
      resetStartedAt: 80_000,
      spawnH1StartedAt: 50_000,
      readyAt: null,
    })).toBeNull();
  });

  test('rejects corrupt orchestrator timing instead of hiding it', () => {
    expect(() => getHubMeshBudgetElapsedMs({
      nowMs: 60_000,
      resetStartedAt: 1_000,
      spawnH1StartedAt: 50_000,
      readyAt: 49_999,
    }))
      .toThrow('HUB_MESH_TIMING_ORDER_INVALID');
    expect(() => getHubMeshBudgetElapsedMs({
      nowMs: 60_000,
      resetStartedAt: 1_000,
      spawnH1StartedAt: Number.NaN,
      readyAt: null,
    }))
      .toThrow('HUB_MESH_TIMING_STARTED_AT_INVALID');
    expect(() => getHubMeshBudgetElapsedMs({
      nowMs: 60_000,
      resetStartedAt: 1_000,
      spawnH1StartedAt: null,
      readyAt: 59_000,
    }))
      .toThrow('HUB_MESH_TIMING_MISSING');
  });
});
