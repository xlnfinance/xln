import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  assertWalletNodeBrainVaultResult,
  nextWalletNodeShardTimeMs,
  resolveWalletNodeBrainVaultAccess,
  validateWalletNodeBrainVaultProgress,
} from '../../../frontend/packages/browser/src/wallet-node-brainvault-validation';

describe('browser wallet node BrainVault validation', () => {
  test('blocks missing, embedded, and disconnected adapters before derivation', () => {
    const expected = {
      status: 'blocked',
      message: 'The selected node is not connected. Reconnect it before BrainVault recovery.',
    };

    expect(resolveWalletNodeBrainVaultAccess(null)).toEqual(expected);
    expect(resolveWalletNodeBrainVaultAccess({
      mode: 'embedded',
      status: 'connected',
      authLevel: 'admin',
    })).toEqual(expected);
    expect(resolveWalletNodeBrainVaultAccess({
      mode: 'remote',
      status: 'disconnected',
      authLevel: 'admin',
    })).toEqual(expected);
  });

  test('requires admin authority on a connected remote node', () => {
    expect(resolveWalletNodeBrainVaultAccess({
      mode: 'remote',
      status: 'connected',
      authLevel: 'inspect',
    })).toEqual({
      status: 'blocked',
      message: 'Admin access to the selected node is required for BrainVault recovery.',
    });
  });

  test('accepts a connected remote admin adapter', () => {
    const adapter = {
      mode: 'remote',
      status: 'connected',
      authLevel: 'admin',
      adapterOnlyMethod: () => 'preserved',
    };

    const access = resolveWalletNodeBrainVaultAccess(adapter);
    expect(access).toEqual({ status: 'ready', adapter });
    if (access.status !== 'ready') throw new Error('NODE_ACCESS_UNEXPECTEDLY_BLOCKED');
    expect(access.adapter.adapterOnlyMethod()).toBe('preserved');
  });

  test('accepts inclusive progress boundaries for the expected shard count', () => {
    expect(validateWalletNodeBrainVaultProgress({
      completed: 0,
      total: 10,
      lastShardMs: 100,
      workers: 4,
    }, 10)).toEqual({ valid: true });
    expect(validateWalletNodeBrainVaultProgress({
      completed: 10,
      total: 10,
      lastShardMs: 100,
      workers: 4,
    }, 10)).toEqual({ valid: true });
  });

  test('rejects mismatched totals and out-of-bounds progress', () => {
    const expected = {
      valid: false,
      message: 'The node returned invalid BrainVault progress and was cancelled.',
    };

    expect(validateWalletNodeBrainVaultProgress({
      completed: 1,
      total: 9,
      lastShardMs: 100,
      workers: 4,
    }, 10)).toEqual(expected);
    expect(validateWalletNodeBrainVaultProgress({
      completed: -1,
      total: 10,
      lastShardMs: 100,
      workers: 4,
    }, 10)).toEqual(expected);
    expect(validateWalletNodeBrainVaultProgress({
      completed: 11,
      total: 10,
      lastShardMs: 100,
      workers: 4,
    }, 10)).toEqual(expected);
  });

  test('requires the exact BrainVault spec and shard count in the node receipt', () => {
    expect(() => assertWalletNodeBrainVaultResult({
      specId: 'brainvault-v1',
      shardCount: 10,
    }, 'brainvault-v1', 10)).not.toThrow();
    expect(() => assertWalletNodeBrainVaultResult({
      specId: 'wrong-spec',
      shardCount: 10,
    }, 'brainvault-v1', 10)).toThrow('BRAINVAULT_NODE_RESULT_SPEC_MISMATCH');
    expect(() => assertWalletNodeBrainVaultResult({
      specId: 'brainvault-v1',
      shardCount: 9,
    }, 'brainvault-v1', 10)).toThrow('BRAINVAULT_NODE_RESULT_SPEC_MISMATCH');
  });

  test('preserves initial timing and the existing 70/30 smoothing', () => {
    expect(nextWalletNodeShardTimeMs(0, 1000)).toBe(1000);
    expect(nextWalletNodeShardTimeMs(1000, 2000)).toBe(1300);
  });

  test('keeps adapter, abort, secret, and publication effects in Svelte', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-node-brainvault-validation.ts',
      'utf8',
    );
    const view = readFileSync(
      'frontend/src/lib/components/Views/RuntimeCreation.svelte',
      'utf8',
    );
    const accessIndex = view.indexOf('const access = resolveWalletNodeBrainVaultAccess(adapter)');
    const deriveIndex = view.indexOf('const result = await nodeAdapter.deriveBrainVault({');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('AbortController');
    expect(boundary).not.toContain('deriveBrainVault(');
    expect(boundary).not.toContain('passphrase');
    expect(view).toContain('const adapter = getRuntimeControllerAdapter()');
    expect(view).toContain('const nodeAdapter = access.adapter');
    expect(view).toContain('const abort = new AbortController()');
    expect(view).toContain('name: run.name');
    expect(view).toContain('passphrase: run.passphrase');
    expect(view).toContain('const progressValidation = validateWalletNodeBrainVaultProgress(');
    expect(view).toContain('nodeShardTimeMs = nextWalletNodeShardTimeMs(');
    expect(view).toContain('assertWalletNodeBrainVaultResult(');
    expect(accessIndex).toBeGreaterThan(-1);
    expect(deriveIndex).toBeGreaterThan(accessIndex);
  });
});
