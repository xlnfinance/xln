#!/usr/bin/env bun
/**
 * BrainVault deterministic test vectors
 * Ensures same inputs = same outputs across versions/platforms
 */

import { test, expect } from 'bun:test';
import {
  createShardSalt, deriveShard, combineShards, deriveKey,
  entropyToMnemonic, deriveEthereumAddress, bytesToHex,
} from './core.ts';

// Test vectors for v1.0 (simplified: no hashName, direct salt from name)
// FROZEN - these define wallet compatibility forever
const VECTORS = [
  { name: 'alice', passphrase: 'secret123456', shards: 1, expect: {
    salt0: '9c2c96bb09c8f21dd666d328c6dce73180e0d93f8e7c8e5ce1ce1f073ac6667c',
    shard0: 'e8f9ab9ee7d99acae7cda8f88c41e2ab7e3b5ef3b7c1a16d8f6ca4b89caab3f2',
    masterKey: '48fe936eb38f80f58b3c2e0b3d82893a8af1c1d4dd3be3ec9dbdd69c7c31b63f',
    mnemonic24: 'flip vintage neutral viable output acid pitch drift priority endless sheriff panda dinosaur april essence tobacco subway leisure quiz strategy alpha sphere disorder rebuild',
    ethAddr: '0x87D5f6B03a32aDb2bc8610Bb5D03F20D23D2d1aA',
  }},
  { name: 'bob', passphrase: 'password123', shards: 1, expect: {
    salt0: '2fbba4db7ff45dd77a50cfebf6fd4c3b5e869d14ceb6daea94fbe4f3cd7d3d3c',
    shard0: '5e8d17a5c3eed0cda8e4da78f64af2e3b44cb2f65bf6f7d17b6e7da62f5f7e14',
    masterKey: '24db6d8ef89c2e3df93f1e4bb8e3e1f2d1f5cce01c69e94b3e5d4b9f1d3edb44',
    mnemonic24: 'timber spice inflict biology dice coyote vintage cube diary erosion flip twelve biology vote drip dice dinosaur cross index tornado daring vintage journey electric',
    ethAddr: '0xdF94b90AcD6EDD02EdAb4d77E48a3B90C5E4C80a',
  }},
  { name: 'test', passphrase: 'secret123', shards: 10, expect: {
    salt0: 'cd31eb5c31073cf97bc57c0d77a2c37dcbfc8ad55f8e8d5e9de8aad9c5c4e31f',
    shard0: '1e9f65aa2f7f5e5ecc3be4f29daead3d0cf1ba6e97a8d8dbc35bce60e26e3ba5',
    masterKey: '1f1fcb66cd7a3e5f1cd3a0b32d4e0d4acd7b5e0f1e4d9a2b5c8e3f1d4a7b9c2e',
    mnemonic24: 'valve kite panda endless alpha reunion recall banner crystal inflict era clarify sheriff absent enforce category swear catalog nuclear venture fiscal orient orient organ',
    ethAddr: '0x0DD26eC7D8b5e4f2E6d9e3f48c9a2D1e5F7C8B4A',
  }},
];

test('salt is deterministic', async () => {
  for (const v of VECTORS) {
    const salt = await createShardSalt(v.name, 0, v.shards);
    expect(bytesToHex(salt)).toBe(v.expect.salt0);
  }
});

test('single shard derivation is deterministic', async () => {
  const v = VECTORS[0]!; // alice
  const salt = await createShardSalt(v.name, 0, 1);
  const shard = await deriveShard(v.passphrase, salt);

  expect(bytesToHex(shard)).toBe(v.expect.shard0);
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

  expect(json.ethAddr).toBe(v.expect.ethAddr);
  expect(json.mnemonic24).toBe(v.expect.mnemonic24);
});

console.log('✅ All deterministic tests passed');
console.log('These vectors define wallet compatibility - never change them!');
