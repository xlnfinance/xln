import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from '../../frontend/node_modules/react-dom/server.browser.js';

import { WalletOnboarding } from '../../frontend/apps/wallet/src/WalletOnboarding';
import {
  normalizeMnemonicPhrase,
  validateWalletOnboarding,
} from '../../frontend/packages/runtime-client/wallet-onboarding';

const words12 = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

test('normalizes secret input and validates create/import boundaries without echoing it in errors', () => {
  expect(normalizeMnemonicPhrase(`  ${words12.replaceAll(' ', '  ')}  `)).toBe(words12);
  const incomplete = validateWalletOnboarding({
    mode: 'create',
    label: '',
    mnemonic: 'private phrase',
    recoveryConfirmed: false,
  });
  expect(incomplete.errors).toEqual([
    'Name your wallet.',
    'Enter a complete 12-word or 24-word recovery phrase.',
    'Confirm that the recovery phrase is stored safely.',
  ]);
  expect(incomplete.errors.join(' ')).not.toContain('private phrase');

  expect(validateWalletOnboarding({
    mode: 'import',
    label: 'Imported',
    mnemonic: words12,
    recoveryConfirmed: false,
  }).errors).toEqual([]);
});

test('first-run UI keeps the secret field private and the submit action gated', () => {
  const html = renderToStaticMarkup(
    <WalletOnboarding
      onSubmit={async () => undefined}
      onGenerateMnemonic={async () => words12}
    />,
  );
  expect(html).toContain('Create xln wallet');
  expect(html).toContain('data-testid="wallet-mnemonic-input"');
  expect(html).toContain('autoComplete="off"');
  expect(html).toContain('spellCheck="false"');
  expect(html).toContain('disabled=""');
  expect(html).not.toContain(words12);
});
