import { describe, expect, test } from 'bun:test';
import {
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
});
