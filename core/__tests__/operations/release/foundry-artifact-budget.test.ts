import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  cleanupFoundryIfOverBudget,
  DEFAULT_FOUNDRY_MAX_BYTES,
  FOUNDRY_HOME_ENV,
  FOUNDRY_MAX_BYTES_ENV,
} from '../../../scripts/e2e/harness/test-artifact-cleanup';

const roots: string[] = [];
const repoRoot = resolve(import.meta.dir, '../../../..');
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

  test('startup guard clears only its isolated Anvil temp when its size probe exceeds the deadline', () => {
    const root = makeRoot();
    const fakeBin = join(root, 'fake-bin');
    const shellHome = join(root, 'shell-home');
    const isolatedTemp = join(root, 'isolated-anvil');
    const staleFile = join(isolatedTemp, 'stale-state', 'state.bin');
    const unrelatedFoundryFile = join(shellHome, '.foundry', 'anvil', 'tmp', 'active-state', 'state.bin');
    mkdirSync(join(isolatedTemp, 'stale-state'), { recursive: true });
    mkdirSync(join(shellHome, '.foundry', 'anvil', 'tmp', 'active-state'), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(staleFile, 'stale');
    writeFileSync(unrelatedFoundryFile, 'active');
    writeFileSync(join(fakeBin, 'du'), '#!/bin/sh\nsleep 30\n');
    chmodSync(join(fakeBin, 'du'), 0o755);

    const startedAt = Date.now();
    const result = spawnSync(join(repoRoot, 'scripts/operations/enforce-anvil-storage-budget.sh'), [], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        HOME: shellHome,
        XLN_JDB_ROOT: join(root, 'jdb'),
        ANVIL_TMPDIR: isolatedTemp,
        ANVIL_FOUNDRY_DIR: join(root, 'isolated-foundry'),
        ANVIL_STORAGE_ALLOW_CLEANUP: '1',
        ANVIL_STORAGE_PROBE_TIMEOUT_SECONDS: '1',
      },
      encoding: 'utf8',
      timeout: 5_000,
    });

    expect(result.status).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(result.stderr).toContain('anvil storage probe exceeded 1s before startup; clearing isolated temp path');
    expect(existsSync(staleFile)).toBe(false);
    expect(existsSync(unrelatedFoundryFile)).toBe(true);
  });

  test('live storage guard fails loud instead of deleting active Anvil temp', () => {
    const root = makeRoot();
    const fakeBin = join(root, 'fake-bin');
    const isolatedTemp = join(root, 'active-anvil');
    const activeFile = join(isolatedTemp, 'active-state', 'state.bin');
    mkdirSync(join(isolatedTemp, 'active-state'), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(activeFile, 'active');
    writeFileSync(join(fakeBin, 'du'), '#!/bin/sh\nsleep 30\n');
    chmodSync(join(fakeBin, 'du'), 0o755);

    const result = spawnSync(join(repoRoot, 'scripts/operations/enforce-anvil-storage-budget.sh'), [], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        XLN_JDB_ROOT: join(root, 'jdb'),
        ANVIL_TMPDIR: isolatedTemp,
        ANVIL_FOUNDRY_DIR: join(root, 'isolated-foundry'),
        ANVIL_STORAGE_PROBE_TIMEOUT_SECONDS: '1',
      },
      encoding: 'utf8',
      timeout: 5_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ANVIL_STORAGE_TEMP_PROBE_TIMEOUT');
    expect(existsSync(activeFile)).toBe(true);
  });
});
