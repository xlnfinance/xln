import { describe, expect, test } from 'bun:test';

import {
  BRAINVAULT_SHARD_TIME_MAX_MS,
  countMnemonicWords,
  estimateBrainVaultWork,
  formatLiveRuntimeImportStatus,
  hasSupportedMnemonicWordCount,
  normalizeBrainVaultShardTimeSample,
  normalizeMnemonicPhrase,
  parseLiveRuntimeChoices,
} from '../../frontend/src/lib/components/Views/runtime-creation-model';

describe('runtime creation live runtime discovery', () => {
  const token = `xlnra1.full.${Date.now() + 60_000}.aud.kid.jti.sig`;

  test('formats runtime-import readiness as an explicit visible status', () => {
    expect(formatLiveRuntimeImportStatus({
      ready: false,
      partial: true,
      code: 'MARKET_MAKER_CHILD_INACTIVE',
      reason: 'degraded:marketMaker,custody',
      degraded: ['marketMaker', 'custody'],
    }, 3)).toBe(
      'Runtime network still converging; showing 3 import targets. code=MARKET_MAKER_CHILD_INACTIVE · reason=degraded:marketMaker,custody · degraded=marketMaker,custody',
    );

    expect(formatLiveRuntimeImportStatus({ ready: true }, 0)).toBe('');
  });

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

  test('parses suggested H/MM/Custody runtime choices through the shared import parser', () => {
    const choices = parseLiveRuntimeChoices({
      ok: true,
      ready: true,
      manifest: {
        entries: [
          ['H1', 8092],
          ['H2', 8093],
          ['H3', 8094],
          ['MM', 8095],
          ['Custody', 8088],
        ].map(([label, port]) => ({
          label,
          access: 'admin',
          wsUrl: `ws://localhost:${port}/rpc`,
          token,
        })),
      },
    });

    expect(choices.map(choice => choice.label)).toEqual(['H1', 'H2', 'H3', 'MM', 'Custody']);
    expect(choices.map(choice => choice.access)).toEqual(['admin', 'admin', 'admin', 'admin', 'admin']);
    expect(choices.map(choice => choice.wsUrl)).toEqual([
      'ws://127.0.0.1:8092/rpc',
      'ws://127.0.0.1:8093/rpc',
      'ws://127.0.0.1:8094/rpc',
      'ws://127.0.0.1:8095/rpc',
      'ws://127.0.0.1:8088/rpc',
    ]);
  });

  test('keeps empty startup import payloads visible as readiness status instead of fake choices', () => {
    const payload = { ready: false, retryable: true, reason: 'mesh starting', manifest: { entries: [] } };
    expect(parseLiveRuntimeChoices(payload)).toEqual([]);
    expect(formatLiveRuntimeImportStatus(payload, 0)).toContain('Runtime import is not ready.');
  });

});
