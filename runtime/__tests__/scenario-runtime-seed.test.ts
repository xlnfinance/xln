import { afterEach, expect, test } from 'bun:test';
import { requireRuntimeSeed, setScenarioStorageEnabled } from '../scenarios/helpers';
import type { Env } from '../types';

const originalXlnRuntimeSeed = process.env['XLN_RUNTIME_SEED'];
const originalRuntimeSeed = process.env['RUNTIME_SEED'];

afterEach(() => {
  if (originalXlnRuntimeSeed === undefined) delete process.env['XLN_RUNTIME_SEED'];
  else process.env['XLN_RUNTIME_SEED'] = originalXlnRuntimeSeed;

  if (originalRuntimeSeed === undefined) delete process.env['RUNTIME_SEED'];
  else process.env['RUNTIME_SEED'] = originalRuntimeSeed;
});

test('requireRuntimeSeed treats an empty env seed as absent and falls back to XLN_RUNTIME_SEED', () => {
  process.env['XLN_RUNTIME_SEED'] = 'scenario-env-seed';
  delete process.env['RUNTIME_SEED'];
  const env = { runtimeSeed: '' } as Env;

  expect(requireRuntimeSeed(env, 'scenario')).toBe('scenario-env-seed');
  expect(env.runtimeSeed).toBe('scenario-env-seed');
});

test('requireRuntimeSeed still fails when no real seed exists', () => {
  delete process.env['XLN_RUNTIME_SEED'];
  delete process.env['RUNTIME_SEED'];
  const env = { runtimeSeed: '   ' } as Env;

  expect(() => requireRuntimeSeed(env, 'scenario')).toThrow(
    'scenario: runtimeSeed missing - unlock vault or set XLN_RUNTIME_SEED',
  );
});

test('setScenarioStorageEnabled disables scenario frame persistence explicitly', () => {
  const env = {
    runtimeConfig: { storage: { snapshotPeriodFrames: 12 } },
    runtimeState: { persistencePaused: false },
  } as Env;

  setScenarioStorageEnabled(env, false);

  expect(env.runtimeConfig?.storage?.enabled).toBe(false);
  expect(env.runtimeConfig?.storage?.snapshotPeriodFrames).toBe(12);
  expect(env.runtimeState?.persistencePaused).toBe(true);
});
