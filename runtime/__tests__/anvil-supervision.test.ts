import { describe, expect, test } from 'bun:test';
import { validateAnvilSupervision } from '../../scripts/check-anvil-supervision';

const healthyEntries = () => ['anvil', 'anvil2'].map((name, index) => ({
  name,
  pid: 1_000 + index,
  pm2_env: {
    args: [],
    kill_timeout: 60_000,
    max_memory_restart: 768 * 1024 * 1024,
    restart_delay: 2_000,
    status: 'online',
  },
}));

describe('Anvil PM2 supervision contract', () => {
  test('accepts direct, bounded, non-destructive Anvil processes', () => {
    expect(validateAnvilSupervision(healthyEntries(), () => 'anvil\n')).toEqual([
      { name: 'anvil', pid: 1_000, maxMemoryBytes: 768 * 1024 * 1024 },
      { name: 'anvil2', pid: 1_001, maxMemoryBytes: 768 * 1024 * 1024 },
    ]);
  });

  test('rejects a persisted reset before production save', () => {
    const entries = healthyEntries();
    entries[0]!.pm2_env.args = ['--reset'];
    expect(() => validateAnvilSupervision(entries, () => 'anvil')).toThrow(
      'ANVIL_PM2_DESTRUCTIVE_ARG:anvil',
    );
  });

  test('rejects the shell wrapper that hid Anvil RSS from PM2', () => {
    expect(() => validateAnvilSupervision(healthyEntries(), () => 'bash')).toThrow(
      'ANVIL_PM2_WRONG_PROCESS:anvil:pid=1000:comm=bash',
    );
  });

  test('rejects the former ceiling that killed RPC during authenticated replay', () => {
    const entries = healthyEntries();
    entries[0]!.pm2_env.max_memory_restart = 512 * 1024 * 1024;
    expect(() => validateAnvilSupervision(entries, () => 'anvil')).toThrow(
      'ANVIL_PM2_MEMORY_LIMIT_INVALID:anvil:536870912',
    );
  });
});
