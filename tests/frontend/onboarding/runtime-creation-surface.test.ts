import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assertDemoNetwork } from '../../../frontend/src/lib/config/demo-accounts';

const source = readFileSync('frontend/src/lib/components/Views/RuntimeCreation.svelte', 'utf8');
const testnet = readFileSync('frontend/src/routes/testnet/+page.svelte', 'utf8');

test('wallet entry contains only the canonical Brain Vault and mnemonic choices', () => {
  expect(source).toContain('id="wallet-mode-brainvault"');
  expect(source).toContain('id="wallet-mode-mnemonic"');
  expect(source).not.toContain('id="wallet-mode-testnet"');
  expect(source).not.toContain("acceptRecoveryRehearsal('brainvault'");
  expect(source).not.toContain('Download sheet');
});

test('the testnet page keeps disposable identity shortcuts and the explicit destructive reset', () => {
  expect(testnet).toContain('DEMO_ACCOUNTS');
  expect(testnet).toContain('Delete local testnet data');
  expect(testnet).toContain("reason: 'testnet-tools'");
});

test('device-unlocked test wallets reject real and unknown jurisdictions, including mixed stacks', () => {
  expect(() => assertDemoNetwork([31337, 31338])).not.toThrow();
  expect(() => assertDemoNetwork([11155111])).not.toThrow();
  for (const chains of [[], [1], [31337, 1], [8453], ['31337'], [NaN]]) {
    expect(() => assertDemoNetwork(chains)).toThrow('Test wallets require');
  }
});
