import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  cleanupFoundryIfOverBudget,
  DEFAULT_FOUNDRY_MAX_BYTES,
  FOUNDRY_HOME_ENV,
  FOUNDRY_MAX_BYTES_ENV,
} from '../scripts/test-artifact-cleanup';

const roots: string[] = [];
const makeRoot = (): string => {
  const root = join(tmpdir(), `xln-foundry-budget-${process.pid}-${roots.length}`);
  roots.push(root);
  mkdirSync(join(root, 'anvil', 'tmp', 'stale-state'), { recursive: true });
  mkdirSync(join(root, 'bin', 'versions', 'stable'), { recursive: true });
  writeFileSync(join(root, 'bin', 'versions', 'stable', 'forge'), 'preserve');
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Foundry artifact budget', () => {
  test('cleans only stale Anvil tmp state when Foundry exceeds its cap', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'anvil', 'tmp', 'stale-state', 'state.bin'), Buffer.alloc(200_000));

    const result = cleanupFoundryIfOverBudget({
      [FOUNDRY_HOME_ENV]: root,
      [FOUNDRY_MAX_BYTES_ENV]: '100000',
    }, () => {});

    expect(result.cleaned).toBe(true);
    expect(existsSync(join(root, 'anvil', 'tmp', 'stale-state'))).toBe(false);
    expect(existsSync(join(root, 'bin', 'versions', 'stable', 'forge'))).toBe(true);
  });

  test('preserves Anvil state below the cap', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'anvil', 'tmp', 'stale-state', 'state.bin'), Buffer.alloc(1_000));
    const result = cleanupFoundryIfOverBudget({
      [FOUNDRY_HOME_ENV]: root,
      [FOUNDRY_MAX_BYTES_ENV]: '100000',
    }, () => {});
    expect(result.cleaned).toBe(false);
    expect(existsSync(join(root, 'anvil', 'tmp', 'stale-state'))).toBe(true);
  });

  test('defaults to a 50 GiB cap', () => {
    expect(DEFAULT_FOUNDRY_MAX_BYTES).toBe(50 * 1024 * 1024 * 1024);
  });
});
