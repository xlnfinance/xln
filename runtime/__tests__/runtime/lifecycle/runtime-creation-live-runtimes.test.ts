import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BRAINVAULT_SHARD_TIME_MAX_MS,
  countMnemonicWords,
  estimateBrainVaultWork,
  hasSupportedMnemonicWordCount,
  normalizeBrainVaultShardTimeSample,
  normalizeMnemonicPhrase,
} from '../../../../frontend/src/lib/components/Views/runtime-creation-model';

describe('runtime creation', () => {
  test('accepts only the supported 12-word and 24-word mnemonic lengths', () => {
    const words12 = Array.from({ length: 12 }, (_, index) => `word${index + 1}`).join(' ');
    const words24 = Array.from({ length: 24 }, (_, index) => `word${index + 1}`).join('\n');

    expect(normalizeMnemonicPhrase(`  ${words12}  `)).toBe(words12);
    expect(countMnemonicWords(words24)).toBe(24);
    expect(hasSupportedMnemonicWordCount(words12)).toBe(true);
    expect(hasSupportedMnemonicWordCount(words24)).toBe(true);
    expect(hasSupportedMnemonicWordCount(`${words12} extra`)).toBe(false);
  });

  test('reports BrainVault time and memory work without password entropy claims', () => {
    expect(estimateBrainVaultWork(100, 256, 3_000, 4)).toEqual({
      recoveryMs: 75_000,
      totalMemoryWorkMb: 25_600,
    });
    expect(() => estimateBrainVaultWork(1.5, 256, 3_000, 1))
      .toThrow('BRAINVAULT_SHARD_COUNT_INVALID');
  });

  test('keeps shard timing telemetry bounded without failing valid derivation work', () => {
    expect(normalizeBrainVaultShardTimeSample(Number.NaN)).toBeNull();
    expect(normalizeBrainVaultShardTimeSample('3000')).toBeNull();
    expect(normalizeBrainVaultShardTimeSample(1)).toBe(100);
    expect(normalizeBrainVaultShardTimeSample(750_000)).toBe(750_000);
    expect(normalizeBrainVaultShardTimeSample(BRAINVAULT_SHARD_TIME_MAX_MS * 2))
      .toBe(BRAINVAULT_SHARD_TIME_MAX_MS);
  });

  test('keeps production wallet creation focused on Brain Vault and mnemonic inputs', () => {
    const source = readFileSync(
      join(process.cwd(), 'frontend/src/lib/components/Views/RuntimeCreation.svelte'),
      'utf8',
    );

    expect(source).toContain("type InputMode = 'brainvault' | 'mnemonic';");
    expect(source).toContain('id="wallet-panel-brainvault"');
    expect(source).toContain('id="wallet-panel-mnemonic"');
    expect(source).not.toContain('wallet-panel-testnet');
    expect(source).not.toContain('live-runtime-section');
    expect(source).not.toContain('quick-login-section');
    expect(source).toContain('detachWorkerHandlers(worker);');
    expect(source).toContain('worker.onmessage = null;');
    expect(source).toContain('Timing is telemetry: invalid or extreme samples must never discard valid Argon2 output.');
  });
});
