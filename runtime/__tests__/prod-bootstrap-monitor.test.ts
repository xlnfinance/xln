import { describe, expect, test } from 'bun:test';
import {
  findDeployScopedChildFatal,
  findProductionBootstrapFatal,
  isProductionBootstrapReady,
  summarizeProductionBootstrap,
} from '../../scripts/watch-prod-bootstrap';

const healthy = () => ({
  coreOk: true,
  systemOk: true,
  system: { runtime: true, relay: true },
  hubMesh: { ok: true },
  marketMaker: { ok: true, startupPhase: 'ready' },
  bootstrapReserves: { ok: true },
  custody: { ok: true },
  reset: { completedAt: 1, inProgress: false, failedAt: null, hasError: false },
  failures: [],
  bootstrapTimeline: { stages: [] },
  hubs: ['H1', 'H2', 'H3'].map((name) => ({
    name,
    online: true,
    selfRelayPresence: true,
    exitCode: null,
    exitSignal: null,
    recoveryInProgress: false,
    bootstrapProgress: { active: false, step: 'idle', idleMs: 0, totalMs: 1, stallTimeoutMs: 120_000 },
  })),
});

describe('production bootstrap monitor', () => {
  test('recognizes the complete production gate', () => {
    const health = healthy();
    expect(isProductionBootstrapReady(health)).toBe(true);
    expect(findProductionBootstrapFatal(health, 1_000)).toBeNull();
    expect(summarizeProductionBootstrap(health)['ready']).toBe(true);
  });

  test('fails immediately when a hub exits', () => {
    const health = healthy();
    health.systemOk = false;
    health.hubs[0]!.online = false;
    health.hubs[0]!.exitCode = 1;
    expect(findProductionBootstrapFatal(health, 1_000)).toBe('PROD_BOOTSTRAP_HUB_EXITED:H1:code=1');
  });

  test('allows the bounded local recovery window for an exited hub', () => {
    const health = healthy();
    health.systemOk = false;
    health.hubs[0]!.online = false;
    health.hubs[0]!.exitCode = 1;
    health.hubs[0]!.recoveryInProgress = true;
    expect(findProductionBootstrapFatal(health, 1_000)).toBeNull();
    expect(summarizeProductionBootstrap(health)['hubs']).toContainEqual(expect.objectContaining({
      name: 'H1',
      recovering: true,
    }));
  });

  test('fails the reported step as soon as its stall budget is exceeded', () => {
    const health = healthy();
    health.systemOk = false;
    health.hubs[1]!.bootstrapProgress = {
      active: true,
      step: 'local-reserve:H2:Tron:fund-events',
      idleMs: 120_001,
      totalMs: 300_000,
      stallTimeoutMs: 120_000,
    };
    expect(findProductionBootstrapFatal(health, 400_000)).toBe(
      'PROD_BOOTSTRAP_HUB_STALLED:H2:step=local-reserve:H2:Tron:fund-events:idleMs=120001:timeoutMs=120000',
    );
  });

  test('does not turn a completed stage budget into a total bootstrap deadline', () => {
    const health = healthy();
    health.bootstrapTimeline.stages = [{
      key: 'preflight',
      status: 'active',
      startedAt: 1_000,
      completedAt: 40_000,
      budgetMs: 600_000,
    }];
    expect(findProductionBootstrapFatal(health, 700_000)).toBeNull();
  });

  test('does not kill an active stage that exceeds its diagnostic budget', () => {
    const health = healthy();
    health.systemOk = false;
    health.bootstrapTimeline.stages = [{
      key: 'same-chain',
      status: 'active',
      startedAt: 1_000,
      completedAt: null,
      budgetMs: 600_000,
    }];
    expect(findProductionBootstrapFatal(health, 700_000)).toBeNull();
  });

  test('latches a deploy-scoped child fatal across a later green restart', () => {
    const deployStartedAt = Date.parse('2026-07-18T15:00:00.000Z');
    const receipt = {
      recordedAt: '2026-07-18T15:00:01.000Z',
      name: 'MM',
      reasonCode: 'MARKET_MAKER_BOOTSTRAP_STALLED',
      fingerprint: 'fatal-1',
    };

    expect(findDeployScopedChildFatal(receipt, deployStartedAt)).toBe(
      'PROD_BOOTSTRAP_CHILD_FATAL_RECEIPT:MM:MARKET_MAKER_BOOTSTRAP_STALLED:fatal-1',
    );
    expect(isProductionBootstrapReady(healthy())).toBe(true);
    expect(findDeployScopedChildFatal({
      ...receipt,
      recordedAt: '2026-07-18T14:59:59.000Z',
    }, deployStartedAt)).toBeNull();
  });
});
