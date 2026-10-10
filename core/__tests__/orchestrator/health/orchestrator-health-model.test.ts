import { expect, test } from 'bun:test';

import { deriveHubRuntimeHealth, deriveResetHealthOk } from '../../../orchestrator/health/health-model';
import { createHealthRecomputer } from '../../../orchestrator/health/orchestrator-health-support';
import type { AggregatedHealth } from '../../../orchestrator/orchestrator-types';

test('orchestrator health treats hub process health separately from relay self-presence', () => {
  const health = deriveHubRuntimeHealth({
    processExitCode: null,
    hasHealth: true,
    hasSelfRelayPresence: false,
    runtimeHalted: false,
  });

  expect(health.online).toBe(true);
  expect(health.selfRelayPresence).toBe(false);
});

test('orchestrator health does not mark hubs online without a live process and health payload', () => {
  expect(deriveHubRuntimeHealth({
    processExitCode: undefined,
    hasHealth: true,
    hasSelfRelayPresence: true,
    runtimeHalted: false,
  }).online).toBe(false);

  expect(deriveHubRuntimeHealth({
    processExitCode: null,
    hasHealth: false,
    hasSelfRelayPresence: true,
    runtimeHalted: false,
  }).online).toBe(false);

  expect(deriveHubRuntimeHealth({
    processExitCode: 1,
    hasHealth: true,
    hasSelfRelayPresence: true,
    runtimeHalted: false,
  }).online).toBe(false);
});

test('orchestrator health fails closed when a live runtime has halted', () => {
  expect(deriveHubRuntimeHealth({
    processExitCode: null,
    hasHealth: true,
    hasSelfRelayPresence: true,
    runtimeHalted: true,
  })).toEqual({
    online: false,
    selfRelayPresence: true,
  });
});

test('orchestrator health latches a reset failure until a fresh reset clears it', () => {
  expect(deriveResetHealthOk({ inProgress: true, lastError: null })).toBe(false);
  expect(deriveResetHealthOk({ inProgress: false, lastError: 'reset failed' })).toBe(false);
  expect(deriveResetHealthOk({ inProgress: false, lastError: null })).toBe(true);
});

test('a disabled market maker does not degrade recomputed health', () => {
  const recompute = createHealthRecomputer(() => {});
  const health = {
    coreOk: true,
    reset: { inProgress: false, lastError: null },
    storage: { ok: true },
    hubs: [{ online: true }],
    hubMesh: { ok: true },
    custody: { ok: true },
    bootstrapReserves: { ok: true, targetMet: true },
  } as unknown as AggregatedHealth;
  const disabledMarketMaker = {
    enabled: false,
    ok: true,
    cross: { applicable: true, ok: false, expectedRoutes: 1, routes: [] },
    hubs: [{ hubEntityId: `0x${'11'.repeat(32)}`, offers: 0, ready: false, depthReady: false, pairs: [] }],
  } as unknown as AggregatedHealth['marketMaker'];

  const disabled = recompute(health, disabledMarketMaker);
  expect(disabled.systemOk).toBe(true);
  expect(disabled.degraded).toEqual([]);
  expect(disabled.failures).toEqual([]);

  const enabled = recompute(health, { ...disabledMarketMaker, enabled: true });
  expect(enabled.degraded).toEqual(['marketMakerSameChain', 'marketMakerCross']);
});
