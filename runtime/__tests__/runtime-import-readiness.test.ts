import { describe, expect, test } from 'bun:test';

import { classifyRuntimeImportReadinessReason } from '../failure-taxonomy';
import { resolveRuntimeImportReadiness } from '../orchestrator/runtime-import-readiness';
import type { AggregatedHealth } from '../orchestrator/orchestrator-types';

const baseReadyHealth = (): Pick<AggregatedHealth,
  'systemOk' |
  'coreOk' |
  'degraded' |
  'reset' |
  'hubMesh' |
  'marketMaker' |
  'custody' |
  'bootstrapReserves'
> => ({
  systemOk: true,
  coreOk: true,
  degraded: [],
  reset: { inProgress: false } as AggregatedHealth['reset'],
  hubMesh: { ok: true, hubIds: ['h1', 'h2', 'h3'], pairs: [], direct: { openLinkCount: 6, links: [] } },
  marketMaker: {
    enabled: true,
    ok: true,
    entityId: '0xmm',
    startupPhase: 'offers-ready',
    expectedOffersPerHub: 3,
    cross: { applicable: true, ok: true, expectedRoutes: 6, routeCount: 6, routes: [] },
    hubs: [],
  },
  custody: { enabled: true, ok: true, entityId: '0xcustody', daemonPort: 1, servicePort: 2 },
  bootstrapReserves: {
    ok: true,
    targetMet: true,
    requiredTokenCount: 3,
    entityCount: 4,
    entities: [],
  },
});

describe('runtime import readiness gate', () => {
  test('allows import only after orchestrator reports a usable network', () => {
    expect(resolveRuntimeImportReadiness(baseReadyHealth())).toEqual({ ok: true });
  });

  test('blocks import while market maker bootstrap is not fully offers-ready', () => {
    const health = baseReadyHealth();
    health.systemOk = false;
    health.degraded = ['marketMaker'];
    health.marketMaker = {
      ...health.marketMaker,
      ok: false,
      startupPhase: 'bootstrap-cross',
      cross: { ...health.marketMaker.cross, ok: false },
    };

    expect(resolveRuntimeImportReadiness(health)).toEqual({
      ok: false,
      status: 503,
      error: 'RUNTIME_IMPORT_NETWORK_NOT_READY',
      reason: 'system-not-ok',
      category: 'TransientRace',
      code: 'SYSTEM_NOT_OK',
      retryable: true,
      fatal: false,
      failure: {
        category: 'TransientRace',
        code: 'SYSTEM_NOT_OK',
        message: 'system-not-ok',
        retryable: true,
        fatal: false,
      },
      degraded: ['marketMaker'],
    });
  });

  test('blocks import when reserve targets are not fully met even if core system is up', () => {
    const health = baseReadyHealth();
    health.degraded = ['bootstrapReserveTargets'];
    health.bootstrapReserves = { ...health.bootstrapReserves, targetMet: false };

    expect(resolveRuntimeImportReadiness(health)).toEqual({
      ok: false,
      status: 503,
      error: 'RUNTIME_IMPORT_NETWORK_NOT_READY',
      reason: 'degraded:bootstrapReserveTargets',
      category: 'TransientRace',
      code: 'DEGRADED',
      retryable: true,
      fatal: false,
      failure: {
        category: 'TransientRace',
        code: 'DEGRADED',
        message: 'degraded:bootstrapReserveTargets',
        retryable: true,
        fatal: false,
      },
      degraded: ['bootstrapReserveTargets'],
    });
  });

  test('blocks import during reset before exposing any runtime links or tokens', () => {
    const health = baseReadyHealth();
    health.reset = { ...health.reset, inProgress: true };

    expect(resolveRuntimeImportReadiness(health)).toEqual({
      ok: false,
      status: 503,
      error: 'RUNTIME_IMPORT_NETWORK_NOT_READY',
      reason: 'reset-in-progress',
      category: 'TransientRace',
      code: 'RESET_IN_PROGRESS',
      retryable: true,
      fatal: false,
      failure: {
        category: 'TransientRace',
        code: 'RESET_IN_PROGRESS',
        message: 'reset-in-progress',
        retryable: true,
        fatal: false,
      },
      degraded: [],
    });
  });

  test('classifies non-startup readiness reasons without string parsing at callers', () => {
    expect(classifyRuntimeImportReadinessReason('NO_MANAGED_RUNTIME_IMPORTS')).toMatchObject({
      category: 'ExpectedEmpty',
      code: 'NO_MANAGED_RUNTIME_IMPORTS',
      retryable: false,
      fatal: false,
    });
    expect(classifyRuntimeImportReadinessReason('INVALID_RUNTIME_IMPORT_MANIFEST:bad-token')).toMatchObject({
      category: 'Contradiction',
      code: 'INVALID_RUNTIME_IMPORT_MANIFEST',
      retryable: false,
      fatal: true,
    });
  });
});
