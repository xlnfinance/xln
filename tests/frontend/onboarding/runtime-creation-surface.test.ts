import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('frontend/src/lib/components/Views/RuntimeCreation.svelte', 'utf8');
const testnet = readFileSync('frontend/src/routes/testnet/+page.svelte', 'utf8');
const reactTestnet = readFileSync('frontend/apps/wallet/src/testnet-page.tsx', 'utf8');

test('wallet entry contains only the canonical Brain Vault and mnemonic choices', () => {
  expect(source).toContain('id="wallet-mode-brainvault"');
  expect(source).toContain('id="wallet-mode-mnemonic"');
  expect(source).not.toContain('id="wallet-mode-testnet"');
  expect(source).not.toContain("acceptRecoveryRehearsal('brainvault'");
  expect(source).not.toContain('Download sheet');
});

test('disposable identities and destructive reset live on the dedicated testnet page', () => {
  expect(testnet).toContain('DEMO_ACCOUNTS');
  expect(testnet).toContain('Delete local testnet data');
  expect(testnet).toContain("reason: 'testnet-tools'");
  expect(reactTestnet).toContain('DEMO_ACCOUNTS');
  expect(reactTestnet).toContain('Delete local testnet data');
  expect(reactTestnet).toContain("reason: 'testnet-tools'");
});
