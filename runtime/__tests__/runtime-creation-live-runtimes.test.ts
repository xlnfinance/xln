import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  countMnemonicWords,
  estimatePasswordStrength,
  formatLiveRuntimeImportStatus,
  hasSupportedMnemonicWordCount,
  normalizeMnemonicPhrase,
  parseLiveRuntimeChoices,
} from '../../frontend/src/lib/components/Views/runtime-creation-model';

describe('runtime creation live runtime discovery', () => {
  const token = `xlnra1.read.${Date.now() + 60_000}.aud.kid.jti.sig`;

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

  test('keeps password strength estimation exported for RuntimeCreation', () => {
    expect(estimatePasswordStrength('').rating).toBe('weak');
    expect(estimatePasswordStrength('correct horse battery staple').bits).toBeGreaterThan(100);
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
          access: 'read',
          wsUrl: `ws://localhost:${port}/rpc`,
          token,
        })),
      },
    });

    expect(choices.map(choice => choice.label)).toEqual(['H1', 'H2', 'H3', 'MM', 'Custody']);
    expect(choices.map(choice => choice.access)).toEqual(['read', 'read', 'read', 'read', 'read']);
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

  test('RuntimeCreation does not mask reachable runtime-import failures as an empty list', () => {
    const source = readFileSync(
      join(process.cwd(), 'frontend/src/lib/components/Views/RuntimeCreation.svelte'),
      'utf8',
    );

    expect(source).toContain('formatLiveRuntimeImportStatus(payload, next.length)');
    expect(source).toContain('const next = parseLiveRuntimeChoices(payload);');
    expect(source).toContain('data-testid="live-runtime-select"');
    expect(source).toContain('data-testid="live-runtime-connect"');
    expect(source).toContain('liveRuntimesLoaded && !liveRuntimesError');
    expect(source).toContain("url.searchParams.set('access', 'admin')");
    expect(source).not.toContain("url.searchParams.set('access', 'read')");
    expect(source).toContain('Auto-discovery suppresses transport failures only');
    expect(source).not.toContain('swallows errors');
    expect(source).not.toContain('next.length === 0 && payload.ready === false');
  });

  test('keeps demo, remote-runtime, and reset controls behind the Testnet tab', () => {
    const source = readFileSync(
      join(process.cwd(), 'frontend/src/lib/components/Views/RuntimeCreation.svelte'),
      'utf8',
    );
    const testnetPanelIndex = source.indexOf('id="wallet-panel-testnet"');

    expect(source).toContain("type InputMode = 'brainvault' | 'mnemonic' | 'testnet';");
    expect(source).toContain("selectInputMode('testnet')");
    expect(source).toContain("if (next !== 'testnet' || liveRuntimesLoaded || liveRuntimesLoading) return;");
    expect(source).toContain('src="/img/logo.png"');
    expect(testnetPanelIndex).toBeGreaterThan(0);
    expect(source.indexOf('class="quick-login-section"')).toBeGreaterThan(testnetPanelIndex);
    expect(source.indexOf('data-testid="live-runtime-section"')).toBeGreaterThan(testnetPanelIndex);
    expect(source.indexOf('class="testnet-reset-btn"')).toBeGreaterThan(testnetPanelIndex);
  });
});
