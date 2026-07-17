import { afterAll, describe, expect, test } from 'bun:test';
import { getIndexedAccountPath, HDNodeWallet, Mnemonic } from 'ethers';

const anvilMnemonic = 'test test test test test test test test test test test junk';
const controlledEnvKeys = [
  'ANVIL_MNEMONIC',
  'E2E_BASE_URL',
  'E2E_RANDOM_MNEMONICS',
  'E2E_ALICE_MNEMONIC',
  'E2E_BOB_MNEMONIC',
  'E2E_CAROL_MNEMONIC',
  'E2E_DAVE_MNEMONIC',
] as const;
const originalEnv = new Map(controlledEnvKeys.map((key) => [key, process.env[key]]));

process.env.ANVIL_MNEMONIC = anvilMnemonic;
process.env.E2E_BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8081';
for (const key of controlledEnvKeys.slice(2)) delete process.env[key];

const {
  deriveSignerAddressFromMnemonic,
  selectDemoMnemonic,
} = await import('../utils/e2e-demo-users');

const demoLabels = ['alice', 'bob', 'carol', 'dave'] as const;

const deriveAnvilSigner = (index: number): string =>
  HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(anvilMnemonic),
    getIndexedAccountPath(index),
  ).address.toLowerCase();

afterAll(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('e2e demo signer identities', () => {
  test('default demo signers are unique and disjoint from Anvil infrastructure signers', () => {
    const demoSigners = demoLabels.map((label) =>
      deriveSignerAddressFromMnemonic(selectDemoMnemonic(label)),
    );
    const infrastructureSigners = new Set([0, 1, 2].map(deriveAnvilSigner));

    expect(new Set(demoSigners).size).toBe(demoLabels.length);
    expect(demoSigners.filter((signer) => infrastructureSigners.has(signer))).toEqual([]);
  });

  test('configured duplicate demo signer fails loudly', () => {
    process.env.E2E_ALICE_MNEMONIC = selectDemoMnemonic('bob');
    expect(() => selectDemoMnemonic('alice')).toThrow('DEMO_SIGNER_DUPLICATE');
    delete process.env.E2E_ALICE_MNEMONIC;
  });

  test('configured Anvil infrastructure signer fails loudly', () => {
    process.env.E2E_ALICE_MNEMONIC = anvilMnemonic;
    expect(() => selectDemoMnemonic('alice')).toThrow('DEMO_SIGNER_RESERVED');
    delete process.env.E2E_ALICE_MNEMONIC;
  });
});
