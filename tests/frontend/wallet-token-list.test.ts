import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('wallet token list surfaces balance fetch failures without raw console output', () => {
  const source = readFileSync('frontend/src/lib/components/Wallet/TokenList.svelte', 'utf8');

  expect(source).toContain("import { toasts } from '$lib/stores/toastStore';");
  expect(source).toContain('let loadError: string | null = null;');
  expect(source).toContain('let tokenWarnings: string[] = [];');
  expect(source).toContain('function notifyIssue');
  expect(source).toContain('toasts.error(message, duration)');
  expect(source).toContain('toasts.warning(message, duration)');
  expect(source).toContain('data-testid="wallet-token-error"');
  expect(source).toContain('data-testid="wallet-token-warning"');
  expect(source).toContain('tokenWarnings = warnings;');
  expect(source).not.toContain('console.warn');
  expect(source).not.toContain('console.error');
});
