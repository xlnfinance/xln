import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { deriveSignerAddressSync, prewarmNumericSigners } from '../../../core/account/crypto';
import { generateLazyEntityId } from '../../../core/entity/factory';
import { deriveJurisdictionSignerIndex } from '../../../core/jurisdiction/machine/config/signer-derivation';

export const networks = [
  {
    name: 'Ethereum Sepolia',
    network: 'ethereum-sepolia',
    chainId: 11155111,
    deployment: 'eth-sepolia-ignition-01',
    env: 'ETH_SEPOLIA_RPC',
    path: '/rpc',
    token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    blockTimeMs: 12_000,
  },
  {
    name: 'Arbitrum Sepolia',
    network: 'arbitrum-sepolia',
    chainId: 421614,
    deployment: 'arb-sepolia-ignition-01',
    env: 'ARB_SEPOLIA_RPC',
    path: '/rpc2',
    token: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    blockTimeMs: 250,
  },
] as const;

export const readVaultSeed = (directory: string): string => {
  if ((statSync(directory).mode & 0o077) !== 0) throw new Error('USDC_PREFLIGHT_VAULT_DIRECTORY_PERMISSIONS');
  const path = join(directory, 'vault.seed');
  if ((statSync(path).mode & 0o077) !== 0) throw new Error('USDC_PREFLIGHT_VAULT_PERMISSIONS');
  const seed = readFileSync(path, 'utf8');
  if (!seed.trim()) throw new Error('USDC_PREFLIGHT_VAULT_EMPTY');
  return seed;
};

const vaultSeed = (directory: string): string => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if ((statSync(directory).mode & 0o077) !== 0) throw new Error('USDC_PREFLIGHT_VAULT_DIRECTORY_PERMISSIONS');
  const path = join(directory, 'vault.seed');
  const phrase = Wallet.createRandom().mnemonic?.phrase;
  if (!phrase) throw new Error('USDC_PREFLIGHT_MNEMONIC_MISSING');
  try {
    writeFileSync(path, phrase, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return readVaultSeed(directory);
};

const deriveIdentities = (directory: string, loadSeed: (directory: string) => string, userVault = join(directory, 'user')) =>
  (['user', 'hub', 'mm'] as const).map(role => {
    const seed = loadSeed(role === 'user' ? userVault : join(directory, role));
    const indices = networks.map((chain, index) => (index === 0 ? 0 : deriveJurisdictionSignerIndex(chain.name)));
    const labels = networks.map((chain, index) => (index === 0 ? '1' : `1:${chain.name}`));
    const signers =
      role === 'user'
        ? prewarmNumericSigners(
            seed,
            indices.map(index => String(index + 1)),
          )
        : labels.map(label => deriveSignerAddressSync(seed, label));
    return {
      role,
      chains: networks.map((chain, index) => {
        const signerId = signers[index];
        if (!signerId) throw new Error('USDC_PREFLIGHT_SIGNER_MISSING');
        return {
          chainId: chain.chainId,
          name: chain.name,
          signerId,
          entityId: generateLazyEntityId([signerId], 1n).toLowerCase(),
          ...(role === 'user' ? { signerIndex: indices[index] } : { signerLabel: labels[index] }),
        };
      }),
    };
  });

export const prepareIdentities = (directory: string) => deriveIdentities(directory, vaultSeed);
export const readExistingIdentities = (directory: string, userVault?: string) =>
  deriveIdentities(directory, readVaultSeed, userVault);

export type PreparedIdentities = ReturnType<typeof prepareIdentities>;
