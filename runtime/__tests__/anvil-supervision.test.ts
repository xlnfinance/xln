import { describe, expect, test } from 'bun:test';
import { validateAnvilSupervision } from '../../scripts/check-anvil-supervision';

const healthyEntries = () => ['anvil', 'anvil2'].map((name, index) => ({
  name,
  pid: 1_000 + index,
  pm2_env: {
    args: [],
    kill_timeout: 60_000,
    max_memory_restart: 0,
    restart_delay: 2_000,
    status: 'online',
  },
}));

describe('Anvil PM2 supervision contract', () => {
  test('accepts direct, non-destructive Anvil processes without memory restarts', () => {
    expect(validateAnvilSupervision(healthyEntries(), () => 'anvil\n')).toEqual([
      { name: 'anvil', pid: 1_000, memoryRestart: 'disabled' },
      { name: 'anvil2', pid: 1_001, memoryRestart: 'disabled' },
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

  test('rejects any memory-triggered restart of a stateful RPC dependency', () => {
    const entries = healthyEntries();
    entries[0]!.pm2_env.max_memory_restart = 768 * 1024 * 1024;
    expect(() => validateAnvilSupervision(entries, () => 'anvil')).toThrow(
      'ANVIL_PM2_MEMORY_RESTART_ENABLED:anvil:805306368',
    );
  });
});
