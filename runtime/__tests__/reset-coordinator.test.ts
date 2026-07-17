import { expect, test } from 'bun:test';
import {
  createResetCoordinator,
  resolveActiveResetOptions,
  resolveResetCapabilityHealth,
} from '../orchestrator/reset-coordinator';

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
};

test('same reset options coalesce into one destructive reset', async () => {
  const gate = deferred();
  let runs = 0;
  const coordinator = createResetCoordinator(async () => {
    runs += 1;
    await gate.promise;
  });

  const first = coordinator.ensure({ enableMarketMaker: false, enableCustody: false });
  const second = coordinator.ensure({ enableMarketMaker: false, enableCustody: false });
  await Promise.resolve();
  expect(runs).toBe(1);
  gate.resolve();
  await Promise.all([first, second]);
  expect(runs).toBe(1);
});

test('one market-maker upgrade follows a shared hub-only reset', async () => {
  const hubGate = deferred();
  const mmGate = deferred();
  const runs: boolean[] = [];
  const coordinator = createResetCoordinator(async options => {
    runs.push(options.enableMarketMaker);
    await (options.enableMarketMaker ? mmGate.promise : hubGate.promise);
  });

  const hub = coordinator.ensure({ enableMarketMaker: false, enableCustody: false });
  const firstMm = coordinator.ensure({ enableMarketMaker: true, enableCustody: false });
  const secondMm = coordinator.ensure({ enableMarketMaker: true, enableCustody: false });
  let hubResolved = false;
  void hub.then(() => { hubResolved = true; });
  await Promise.resolve();
  expect(runs).toEqual([false]);
  hubGate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(runs).toEqual([false, true]);
  expect(hubResolved).toBe(false);
  mmGate.resolve();
  await Promise.all([hub, firstMm, secondMm]);
  expect(runs).toEqual([false, true]);
});

test('market-maker reset also satisfies a concurrent hub-only caller', async () => {
  const gate = deferred();
  let runs = 0;
  const coordinator = createResetCoordinator(async () => {
    runs += 1;
    await gate.promise;
  });

  const marketMaker = coordinator.ensure({ enableMarketMaker: true, enableCustody: false });
  const hubOnly = coordinator.ensure({ enableMarketMaker: false, enableCustody: false });
  await Promise.resolve();
  expect(runs).toBe(1);
  gate.resolve();
  await Promise.all([marketMaker, hubOnly]);
  expect(runs).toBe(1);
});

test('one custody upgrade follows a shared hub-only reset', async () => {
  const hubGate = deferred();
  const custodyGate = deferred();
  const runs: boolean[] = [];
  const coordinator = createResetCoordinator(async options => {
    runs.push(options.enableCustody);
    await (options.enableCustody ? custodyGate.promise : hubGate.promise);
  });

  const hub = coordinator.ensure({ enableMarketMaker: false, enableCustody: false });
  const firstCustody = coordinator.ensure({ enableMarketMaker: false, enableCustody: true });
  const secondCustody = coordinator.ensure({ enableMarketMaker: false, enableCustody: true });
  let hubResolved = false;
  void hub.then(() => { hubResolved = true; });
  await Promise.resolve();
  expect(runs).toEqual([false]);
  hubGate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(runs).toEqual([false, true]);
  expect(hubResolved).toBe(false);
  custodyGate.resolve();
  await Promise.all([hub, firstCustody, secondCustody]);
  expect(runs).toEqual([false, true]);
});

test('orthogonal upgrades merge into one stable reset before any waiter resolves', async () => {
  const baseGate = deferred();
  const fullGate = deferred();
  const runs: string[] = [];
  const coordinator = createResetCoordinator(async options => {
    const key = `${Number(options.enableMarketMaker)}${Number(options.enableCustody)}`;
    runs.push(key);
    await (key === '00' ? baseGate.promise : fullGate.promise);
  });

  const base = coordinator.ensure({ enableMarketMaker: false, enableCustody: false });
  const marketMaker = coordinator.ensure({ enableMarketMaker: true, enableCustody: false });
  const custody = coordinator.ensure({ enableMarketMaker: false, enableCustody: true });
  const resolved: string[] = [];
  void base.then(() => { resolved.push('base'); });
  void marketMaker.then(() => { resolved.push('market-maker'); });
  void custody.then(() => { resolved.push('custody'); });

  await Promise.resolve();
  expect(runs).toEqual(['00']);
  baseGate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(runs).toEqual(['00', '11']);
  expect(resolved).toEqual([]);

  fullGate.resolve();
  await Promise.all([base, marketMaker, custody]);
  expect(runs).toEqual(['00', '11']);
  expect(new Set(resolved)).toEqual(new Set(['base', 'market-maker', 'custody']));
});

test('health reflects completed reset capabilities instead of configured optional services', () => {
  const active = resolveActiveResetOptions(
    { enableMarketMaker: true, enableCustody: true },
    { enableMarketMaker: false, enableCustody: false },
  );
  expect(active).toEqual({ enableMarketMaker: false, enableCustody: false });
  expect(resolveResetCapabilityHealth(active, {
    marketMakerOnline: false,
    custodyOnline: false,
  })).toEqual({
    marketMakerEnabled: false,
    marketMakerActive: false,
    custodyEnabled: false,
    custodyOk: true,
  });
});
