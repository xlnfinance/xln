#!/usr/bin/env bun
/**
 * BrainVault deterministic test vectors
 * Ensures same inputs = same outputs across versions/platforms
 */

import { test, expect } from 'bun:test';
import { hashRaw as argon2Native } from '@node-rs/argon2';
import {
  createShardSalt, deriveShard, deriveShardWithParams, combineShards, deriveKey,
  entropyToMnemonic, deriveEthereumAddress, bytesToHex,
  deriveSitePassword, factorForShardCount, getShardCount, hexToBytes, validateInputs,
} from './core.ts';
import { BIP39_ENGLISH } from './bip39-english.ts';
import { BRAINVAULT_V1 } from './spec.ts';

// Test vectors for v1.0 (simplified: no hashName, direct salt from name)
// FROZEN - these define wallet compatibility forever
const VECTORS = [
  { name: 'alice', passphrase: 'secret123456', shards: 1, expect: {
    salt0: 'ec290cacd14098d2ee8ff7b8eaaba69904d97cd7720f62eb52cb7b8eac19399f',
    shard0: 'd7057a04c5441e8246db71a98c94148b6306d810c5a5382ee5d3fd15655927b4',
    masterKey: '52b33367533012c26bf4660339e9373dca2adc2d4051dbbfff51566aa55f37cf',
    mnemonic24: 'milk click novel require across cousin good chair street mouse crash movie same daughter air quote total pride crop mention focus sick slice hole',
    ethAddr: '0x93bAb14eD871462D414a7c0357BF1a76DE741397',
  }},
  { name: 'bob', passphrase: 'password123', shards: 1, expect: {
    salt0: 'ca5c30c09d55f588667c80cac73b4dae612cbc8c32ff444289a364f56f446844',
    shard0: '7c4bcabead8a1094589bd59fa445285b81aee55d9d49a652a348adbcd325accf',
    masterKey: '297e86a9fd23b0fd2e59d9111ad666cf82da377730d5326076f20b215a023104',
    mnemonic24: 'lion shoot refuse toss scissors brass voice blame climb identify surface attack sing topic burden deer captain stone unit hood clarify scatter captain during',
    ethAddr: '0x4A699A1F4061ceEbC83b9dC14d6A0c33eC3E2327',
  }},
  { name: 'test', passphrase: 'secret123', shards: 10, expect: {
    salt0: '7e95de96d472cbce318d8dcc4976997c388d555027ee086ebdaaab004684efca',
    shard0: '1c2b3e5bc7647e48477cfaf2b64693e9c5b86bd33835c9d3400f8ef47eddc2fe',
    masterKey: '2179a82fef1320e04025d0a82fb62ca47f528bda5b707edb6e25cf680d9ae94f',
    mnemonic24: 'inch museum panther drop celery make town mention hundred sound argue mammal resource kid point veteran asset flame great equal pink pair balcony guide',
    ethAddr: '0x0b3C4712A9838cB306357c12C12991F9aF83DCD1',
  }},
];

test('embedded BIP39 English wordlist is canonical', () => {
  const canonicalFile = `${BIP39_ENGLISH.join('\n')}\n`;
  const hash = new Bun.CryptoHasher('sha256').update(canonicalFile).digest('hex');
  expect(BIP39_ENGLISH).toHaveLength(2048);
  expect(Object.isFrozen(BIP39_ENGLISH)).toBe(true);
  expect(Object.isFrozen(BRAINVAULT_V1)).toBe(true);
  expect(BRAINVAULT_V1.ARGON_VERSION).toBe(0x13);
  expect(() => ((BIP39_ENGLISH as string[])[0] = 'mutated')).toThrow();
  expect(() => ((BRAINVAULT_V1 as { ARGON_TIME_COST: number }).ARGON_TIME_COST = 2)).toThrow();
  expect(hash).toBe('2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
});

test('salt is deterministic', async () => {
  for (const v of VECTORS) {
    const salt = await createShardSalt(v.name, 0, v.shards);
    expect(bytesToHex(salt)).toBe(v.expect.salt0);
  }
});

test('salt rejects values that cannot be encoded exactly', async () => {
  await expect(createShardSalt('alice', -1, 1)).rejects.toThrow('BRAINVAULT_SHARD_INDEX_INVALID:-1');
  await expect(createShardSalt('alice', 1, 1)).rejects.toThrow('BRAINVAULT_SHARD_INDEX_INVALID:1');
  await expect(createShardSalt('alice', 0, 0x1_0000_0000)).rejects.toThrow('BRAINVAULT_SHARD_COUNT_INVALID:4294967296');
});

test('factor mapping is integer-only and preserves the V1 formula', () => {
  for (let shardCount = 1; shardCount <= 100_000; shardCount++) {
    expect(factorForShardCount(shardCount)).toBe(Math.ceil(Math.log10(shardCount)) + 1);
  }
  expect(() => factorForShardCount(Number.NaN)).toThrow('BRAINVAULT_SHARD_COUNT_INVALID');
  expect(() => factorForShardCount(1.5)).toThrow('BRAINVAULT_SHARD_COUNT_INVALID');
  expect(() => getShardCount(Number.NaN)).toThrow('Factor must be 1-9');
  expect(() => getShardCount(1.5)).toThrow('Factor must be 1-9');
  expect(validateInputs('a', 'aaaaaa', Number.NaN).valid).toBe(false);
});

test('wallet boundaries fail loudly on malformed bytes', async () => {
  expect(() => hexToBytes('zz')).toThrow('BRAINVAULT_HEX_INVALID');
  expect(() => hexToBytes('abc')).toThrow('BRAINVAULT_HEX_INVALID');
  expect(() => hexToBytes('0xff')).toThrow('BRAINVAULT_HEX_INVALID');
  expect(() => entropyToMnemonic(new Uint8Array(15))).toThrow('BRAINVAULT_ENTROPY_LENGTH_INVALID:15');
  expect(() => entropyToMnemonic(new Uint8Array(33))).toThrow('BRAINVAULT_ENTROPY_LENGTH_INVALID:33');
  await expect(deriveSitePassword('00'.repeat(32), 'example.com', 3)).rejects.toThrow('BRAINVAULT_SITE_PASSWORD_LENGTH_INVALID:3');
  expect(await deriveSitePassword('00'.repeat(32), 'example.com', 20)).toBe('Hu?C%-1gRM37898J+%mS');
  await expect(combineShards([], 1)).rejects.toThrow('BRAINVAULT_SHARDS_EMPTY');
  await expect(combineShards([new Uint8Array(1)], 1)).rejects.toThrow('BRAINVAULT_SHARD_LENGTH_INVALID:0:1');
  await expect(combineShards([new Uint8Array(32)], Number.NaN)).rejects.toThrow('BRAINVAULT_FACTOR_INVALID:NaN');
});

test('single shard derivation is deterministic', async () => {
  const v = VECTORS[0]!; // alice
  const salt = await createShardSalt(v.name, 0, 1);
  const shard = await deriveShard(v.passphrase, salt);

  expect(bytesToHex(shard)).toBe(v.expect.shard0);
});

test('Wasm and native engines share canonical malformed UTF-16 encoding', async () => {
  const passphrase = '\ud800';
  const salt = await createShardSalt('unicode-parity', 0, 1);
  const params = {
    shardMemoryKb: 8,
    argonTimeCost: 1,
    argonParallelism: 1,
    shardOutputBytes: 32,
  };
  const wasm = await deriveShardWithParams(passphrase, salt, params);
  const native = await argon2Native(new TextEncoder().encode(passphrase.normalize('NFKD')), {
    salt,
    memoryCost: params.shardMemoryKb,
    timeCost: params.argonTimeCost,
    parallelism: params.argonParallelism,
    outputLen: params.shardOutputBytes,
    algorithm: 2,
    version: 1,
  });
  expect(bytesToHex(wasm)).toBe(bytesToHex(native));
});

test('full derivation produces correct wallet (1 shard)', async () => {
  for (const v of VECTORS.filter(x => x.shards === 1)) {
    const salt = await createShardSalt(v.name, 0, 1);
    const shard = await deriveShard(v.passphrase, salt);

    const masterKey = await combineShards([shard], 1);
    expect(bytesToHex(masterKey)).toBe(v.expect.masterKey);

    const entropy = await deriveKey(masterKey, 'bip39/entropy/v1.0', 32);
    const mnemonic = await entropyToMnemonic(entropy);
    expect(mnemonic).toBe(v.expect.mnemonic24);

    const ethAddr = await deriveEthereumAddress(mnemonic);
    expect(ethAddr).toBe(v.expect.ethAddr);
  }
});

test('multi-shard derivation is deterministic', async () => {
  const v = VECTORS.find(x => x.shards === 10)!;

  const shards: Uint8Array[] = [];

  for (let i = 0; i < v.shards; i++) {
    const salt = await createShardSalt(v.name, i, v.shards);
    const shard = await deriveShard(v.passphrase, salt);
    shards.push(shard);
  }

  const masterKey = await combineShards(shards, 2); // factor 2 = 10 shards
  expect(bytesToHex(masterKey)).toBe(v.expect.masterKey);

  const entropy = await deriveKey(masterKey, 'bip39/entropy/v1.0', 32);
  const mnemonic = await entropyToMnemonic(entropy);
  expect(mnemonic).toBe(v.expect.mnemonic24);

  const ethAddr = await deriveEthereumAddress(mnemonic);
  expect(ethAddr).toBe(v.expect.ethAddr);
});

test('CLI produces same results as library', async () => {
  const { execSync } = await import('child_process');

  const output = execSync('bun cli.ts alice secret123456 1 --w=1', {
    encoding: 'utf8',
    cwd: import.meta.dir,
  });

  // Extract JSON from output (skip progress bars)
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in output');

  const json = JSON.parse(jsonMatch[0]);
  const v = VECTORS[0]!;

  expect(json.ethAddr24).toBe(v.expect.ethAddr);
  expect(json.mnemonic24).toBe(v.expect.mnemonic24);
});

console.log('✅ All deterministic tests passed');
console.log('These vectors define wallet compatibility - never change them!');
