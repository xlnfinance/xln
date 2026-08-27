import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  resolveWalletBrainVaultFinalizationCommit,
  resolveWalletBrainVaultFinalizationShardOrder,
  resolveWalletBrainVaultFinalizationStart,
} from '../../../frontend/packages/browser/src/wallet-brainvault-finalization';

describe('browser wallet BrainVault finalization', () => {
  test('waits for every shard before finalization starts', () => {
    expect(resolveWalletBrainVaultFinalizationStart({
      completedShardCount: 2,
      shardCount: 3,
      finalizeInProgress: false,
    })).toEqual({ status: 'pending' });
  });

  test('suppresses duplicate finalization while one is in progress', () => {
    expect(resolveWalletBrainVaultFinalizationStart({
      completedShardCount: 3,
      shardCount: 3,
      finalizeInProgress: true,
    })).toEqual({ status: 'in-progress' });
  });

  test('preserves finalization at exact or greater completed counts', () => {
    expect(resolveWalletBrainVaultFinalizationStart({
      completedShardCount: 3,
      shardCount: 3,
      finalizeInProgress: false,
    })).toEqual({ status: 'start' });
    expect(resolveWalletBrainVaultFinalizationStart({
      completedShardCount: 4,
      shardCount: 3,
      finalizeInProgress: false,
    })).toEqual({ status: 'start' });
  });

  test('returns the canonical ascending shard order without mutating membership', () => {
    const completedShardIndexes = new Set([2, 0, 1]);
    expect(resolveWalletBrainVaultFinalizationShardOrder(3, completedShardIndexes))
      .toEqual([0, 1, 2]);
    expect([...completedShardIndexes]).toEqual([2, 0, 1]);
  });

  test('fails loudly on missing shards and invalid shard counts', () => {
    expect(() => resolveWalletBrainVaultFinalizationShardOrder(3, new Set([0, 2])))
      .toThrow('Missing shard 1');
    expect(() => resolveWalletBrainVaultFinalizationShardOrder(0, new Set()))
      .toThrow('BRAINVAULT_FINALIZATION_SHARD_COUNT_INVALID');
  });

  test('cancels an atomic commit after run ownership changes', () => {
    expect(resolveWalletBrainVaultFinalizationCommit({
      isCurrentRun: false,
      name: 'Alice',
      ethereumAddress: '0x1234567890',
    })).toEqual({ status: 'cancelled' });
  });

  test('uses the trimmed wallet name for a current commit', () => {
    expect(resolveWalletBrainVaultFinalizationCommit({
      isCurrentRun: true,
      name: '  Alice Vault  ',
      ethereumAddress: '0x1234567890',
    })).toEqual({ status: 'commit', recoveryLabel: 'Alice Vault' });
  });

  test('preserves the address-derived fallback recovery label', () => {
    expect(resolveWalletBrainVaultFinalizationCommit({
      isCurrentRun: true,
      name: '   ',
      ethereumAddress: '0x1234567890',
    })).toEqual({ status: 'commit', recoveryLabel: 'Wallet 0x1234' });
  });

  test('keeps shard bytes, cryptography, zeroization, persistence, and UI effects in Svelte', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-brainvault-finalization.ts',
      'utf8',
    );
    const view = readFileSync(
      'frontend/src/lib/components/Views/RuntimeCreation.svelte',
      'utf8',
    );

    expect(boundary).not.toContain('Uint8Array');
    expect(boundary).not.toContain('combineShards');
    expect(boundary).not.toContain('deriveKey');
    expect(boundary).not.toContain('entropyToMnemonic');
    expect(boundary).not.toContain('passphrase');
    expect(boundary).not.toContain('vaultOperations');
    expect(view).toContain('resolveWalletBrainVaultFinalizationStart({');
    expect(view).toContain('resolveWalletBrainVaultFinalizationShardOrder(');
    expect(view).toContain('resolveWalletBrainVaultFinalizationCommit({');
    expect(view).toContain('masterKey = await combineShards(orderedResults, run.factor)');
    expect(view).toContain("entropy = await deriveKey(masterKey, 'bip39/entropy/v1.0', 32)");
    expect(view).toContain('for (const shard of orderedResults) shard.fill(0)');
    expect(view).toContain('await prepareRecoveryDecisionFromCurrentSeed(commit.recoveryLabel)');
  });
});
