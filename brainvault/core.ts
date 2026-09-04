/**
 * BrainVault v1 - Memory-Hard Brain Wallet
 *
 * Problem: Traditional mnemonics require secure storage (paper/hardware wallet).
 * Solution: Derive wallet from memorable (name + passphrase + shard count).
 *
 * Algorithm: Argon2id (memory-hard) + BLAKE3 (fast hash)
 * - Each shard: 256 MiB Argon2id (forces attacker to use RAM, not just CPU)
 * - Parallelizable: phone sequential, workstation parallel
 * - Deterministic: same V1 semantic inputs = same wallet on every conforming implementation
 *
 * Security: every guess pays for every shard. Attackers can parallelize too,
 * but each concurrent shard needs another 256 MiB of RAM.
 *
 * FROZEN SPEC - DO NOT CHANGE PARAMETERS (breaks all existing wallets)
 */

import { blake3 } from '@noble/hashes/blake3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { HDNodeWallet } from 'ethers';
import { BIP39_ENGLISH } from './bip39-english.ts';
import { hexToBytes } from './primitives/encoding.ts';
import { BRAINVAULT_V1 } from './primitives/spec.ts';

export { bytesToHex, hexToBytes } from './primitives/encoding.ts';
export { deriveShard, deriveShardWithParams } from './primitives/kdf.ts';
export type { BrainvaultKdfParams } from './primitives/kdf.ts';
export {
  BRAINVAULT_MAX_SHARD_COUNT,
  BRAINVAULT_V1,
  BRAINVAULT_V1_SPEC_ID,
  createShardSalt,
} from './primitives/spec.ts';
export { combineShards, combineShardsWithParams, factorForShardCount, rootDomain, rootFingerprint } from './canonical.ts';

/**
 * Calculate number of shards for a frozen legacy factor.
 * New CLI creation uses explicit levels from presets.ts; this mapping remains
 * unchanged because factor is committed into every V1 root.
 * Formula: 10^(factor-1)
 *
 * Factor 1: 1 shard
 * Factor 2: 10 shards
 * Factor 3: 100 shards
 * Factor 4: 1,000 shards
 * Factor 5: 10,000 shards
 */
export function getShardCount(factor: number): number {
  if (
    !Number.isSafeInteger(factor)
    || factor < BRAINVAULT_V1.MIN_FACTOR
    || factor > BRAINVAULT_V1.MAX_FACTOR
  ) {
    throw new Error(`Factor must be ${BRAINVAULT_V1.MIN_FACTOR}-${BRAINVAULT_V1.MAX_FACTOR}`);
  }
  return Math.pow(10, factor - 1);
}

/**
 * Format milliseconds to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) {
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(ms / 3600000);
  const mins = Math.round((ms % 3600000) / 60000);
  return `${hours}h ${mins}m`;
}

/**
 * Validate inputs before derivation
 */
export function validateInputs(name: string, passphrase: string, factor: number): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (name.length < BRAINVAULT_V1.MIN_NAME_LENGTH) {
    errors.push(`Name must be at least ${BRAINVAULT_V1.MIN_NAME_LENGTH} characters`);
  }
  if (passphrase.length < BRAINVAULT_V1.MIN_PASSPHRASE_LENGTH) {
    errors.push(`Passphrase must be at least ${BRAINVAULT_V1.MIN_PASSPHRASE_LENGTH} characters`);
  }
  if (
    !Number.isSafeInteger(factor)
    || factor < BRAINVAULT_V1.MIN_FACTOR
    || factor > BRAINVAULT_V1.MAX_FACTOR
  ) {
    errors.push(`Factor must be between ${BRAINVAULT_V1.MIN_FACTOR} and ${BRAINVAULT_V1.MAX_FACTOR}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * HKDF-like key derivation using BLAKE3
 */
export async function deriveKey(
  masterKey: Uint8Array,
  context: string,
  length: number = 32
): Promise<Uint8Array> {
  const contextBytes = new TextEncoder().encode(context);
  const input = new Uint8Array(masterKey.length + contextBytes.length);
  input.set(masterKey, 0);
  input.set(contextBytes, masterKey.length);

  try {
    // BLAKE3 can output variable length.
    return blake3(input, { dkLen: length });
  } finally {
    input.fill(0);
    contextBytes.fill(0);
  }
}

/**
 * Convert entropy to BIP39 mnemonic
 */
export async function entropyToMnemonic(entropy: Uint8Array): Promise<string> {
  if (![16, 20, 24, 28, 32].includes(entropy.length)) {
    throw new Error(`BRAINVAULT_ENTROPY_LENGTH_INVALID:${entropy.length}`);
  }

  // Add checksum: SHA256 of entropy, take first entropy.length/32 bits
  const checksumHash = sha256(entropy);
  try {
    const checksumBits = bytesToBits(checksumHash).slice(0, entropy.length * 8 / 32);

    // Combine entropy bits + checksum bits
    const entropyBits = bytesToBits(entropy);
    const allBits = entropyBits + checksumBits;

    // Split into 11-bit chunks, each maps to a word
    const words: string[] = [];
    for (let i = 0; i < allBits.length; i += 11) {
      const chunk = allBits.slice(i, i + 11);
      const index = parseInt(chunk, 2);
      words.push(BIP39_ENGLISH[index]!);
    }

    return words.join(' ');
  } finally {
    checksumHash.fill(0);
  }
}

/**
 * Derive Ethereum address from mnemonic + optional passphrase
 */
export async function deriveEthereumAddress(
  mnemonic: string,
  passphrase: string = ''
): Promise<string> {
  return deriveEthereumAddressAtPath(mnemonic, "m/44'/60'/0'/0/0", passphrase);
}

/**
 * Derive Ethereum address at a specific derivation path
 */
async function deriveEthereumAddressAtPath(
  mnemonic: string,
  path: string,
  passphrase: string = ''
): Promise<string> {
  const wallet = HDNodeWallet.fromPhrase(mnemonic, passphrase, path);
  return wallet.address;
}

/**
 * Derive raw private key at a specific path (hex, 0x-prefixed).
 * Use carefully: exposing raw keys increases operational risk.
 */
export async function deriveEthereumPrivateKeyAtPath(
  mnemonic: string,
  path: string,
  passphrase: string = ''
): Promise<string> {
  const wallet = HDNodeWallet.fromPhrase(mnemonic, passphrase, path);
  return wallet.privateKey;
}

/**
 * Derive address matrix for wallet discovery UX.
 * - standard: m/44'/60'/0'/0/i
 * - ledgerLive: m/44'/60'/i'/0/0
 */
export async function deriveEthereumAddressMatrix(
  mnemonic: string,
  passphrase: string = '',
  count: number = 5
): Promise<{ standard: string[]; ledgerLive: string[] }> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('Address matrix count must be a positive integer');
  }

  const standard: string[] = [];
  const ledgerLive: string[] = [];

  for (let i = 0; i < count; i++) {
    const standardPath = `m/44'/60'/0'/0/${i}`;
    const ledgerLivePath = `m/44'/60'/${i}'/0/0`;
    standard.push(HDNodeWallet.fromPhrase(mnemonic, passphrase, standardPath).address);
    ledgerLive.push(HDNodeWallet.fromPhrase(mnemonic, passphrase, ledgerLivePath).address);
  }

  return { standard, ledgerLive };
}

/**
 * Derive site-specific password for password manager
 */
export async function deriveSitePassword(
  masterKeyInput: string | Uint8Array,
  domain: string,
  length: number = 20
): Promise<string> {
  if (!Number.isSafeInteger(length) || length < 4) {
    throw new Error(`BRAINVAULT_SITE_PASSWORD_LENGTH_INVALID:${length}`);
  }
  const masterKey = typeof masterKeyInput === 'string'
    ? hexToBytes(masterKeyInput)
    : new Uint8Array(masterKeyInput);
  let raw: Uint8Array | undefined;
  try {
    raw = await deriveKey(masterKey, `site-password:${domain}`, length * 2);

  // Convert to password with all character classes
  const lowers = 'abcdefghijklmnopqrstuvwxyz';
  const uppers = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const specials = '!@#$%^&*()-_=+[]{}:,./?';
  const all = lowers + uppers + digits + specials;

  // Ensure at least one of each class
  const password: string[] = [
    lowers[raw[0]! % lowers.length]!,
    uppers[raw[1]! % uppers.length]!,
    digits[raw[2]! % digits.length]!,
    specials[raw[3]! % specials.length]!,
  ];

  // Fill rest
  for (let i = 4; i < length; i++) {
    password.push(all[raw[i]! % all.length]!);
  }

  // Shuffle deterministically using remaining bytes
  for (let i = password.length - 1; i > 0; i--) {
    const j = raw[length + i]! % (i + 1);
    [password[i], password[j]] = [password[j]!, password[i]!];
  }

    return password.join('');
  } finally {
    masterKey.fill(0);
    raw?.fill(0);
  }
}
function bytesToBits(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(2).padStart(8, '0')).join('');
}
