#!/usr/bin/env bun
/**
 * BrainVault deterministic test vectors
 * Ensures same inputs = same outputs across versions/platforms.
 *
 * These vectors define wallet compatibility, but not the whole security bar:
 * auditors must also look for leakage, resource exhaustion, cancellation and
 * boundary failures that can remain invisible while output bytes stay equal.
 */

import { test, expect } from 'bun:test';
import { hashRaw as argon2Native } from '@node-rs/argon2';
import { Worker } from 'node:worker_threads';
import {
  createShardSalt, deriveShard, deriveShardWithParams, combineShards, combineShardsWithParams, deriveKey,
  entropyToMnemonic, deriveEthereumAddress, bytesToHex,
  deriveSitePassword, factorForShardCount, getShardCount, hexToBytes, validateInputs, rootDomain,
} from './core.ts';
import { BIP39_ENGLISH } from './bip39-english.ts';
import { BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID } from './primitives/spec.ts';
import { acceptShard, createShardSlots, finalizeShards } from './shard-collector.ts';
import { cliCreationCharacterError, cliPasswordError } from './cli-policy.ts';
import {
  BRAINVAULT_DEFAULT_LEVEL,
  BRAINVAULT_LEVEL_NAMES,
  BRAINVAULT_LEVEL_SHARDS,
  getShardCountForLevel,
} from './presets.ts';
import {
  generateSuggestedPassword,
  passwordFromIndexes,
  SUGGESTED_PASSWORD_ALPHABET,
  SUGGESTED_PASSWORD_BITS,
  SUGGESTED_PASSWORD_CHARACTERS,
} from './suggestion.ts';

type VectorFile = Readonly<{
  format: string;
  specId: string;
  vectors: ReadonlyArray<{
    id: string;
    input: {
      name: string;
      nameNfkdUtf8Hex: string;
      passphrase: string;
      passphraseNfkdUtf8Hex: string;
      shardCount: number;
      factor: number;
      multiplier: number;
    };
    expected: {
      salt0: string;
      shard0: string;
      root: string;
      mnemonic24: string;
      ethereumAddress0: string;
    };
  }>;
}>;

const VECTOR_FILE = await Bun.file(`${import.meta.dir}/vectors-v1.json`).json() as VectorFile;
const VECTORS = VECTOR_FILE.vectors.map(vector => ({
  name: vector.input.name,
  passphrase: vector.input.passphrase,
  shards: vector.input.shardCount,
  factor: vector.input.factor,
  normalized: {
    name: vector.input.nameNfkdUtf8Hex,
    passphrase: vector.input.passphraseNfkdUtf8Hex,
  },
  expect: {
    salt0: vector.expected.salt0,
    shard0: vector.expected.shard0,
    masterKey: vector.expected.root,
    mnemonic24: vector.expected.mnemonic24,
    ethAddr: vector.expected.ethereumAddress0,
  },
}));

test('embedded BIP39 English wordlist is canonical', () => {
  const canonicalFile = `${BIP39_ENGLISH.join('\n')}\n`;
  const hash = new Bun.CryptoHasher('sha256').update(canonicalFile).digest('hex');
  expect(BIP39_ENGLISH).toHaveLength(2048);
  expect(Object.isFrozen(BIP39_ENGLISH)).toBe(true);
  expect(Object.isFrozen(BRAINVAULT_V1)).toBe(true);
  expect(BRAINVAULT_V1.ARGON_VERSION).toBe(0x13);
  expect(BRAINVAULT_V1_SPEC_ID).toBe('brainvault/argon2id-sharded/v1.0|argon2id-v19-m262144-t1-p1|out32|nfkd-utf8');
  expect(() => ((BIP39_ENGLISH as string[])[0] = 'mutated')).toThrow();
  expect(() => ((BRAINVAULT_V1 as { ARGON_TIME_COST: number }).ARGON_TIME_COST = 2)).toThrow();
  expect(hash).toBe('2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
});

test('external V1 vectors freeze input bytes and spec identity', () => {
  expect(VECTOR_FILE.format).toBe('brainvault-v1-vectors/1');
  expect(VECTOR_FILE.specId).toBe(BRAINVAULT_V1_SPEC_ID);
  for (const vector of VECTORS) {
    expect(bytesToHex(new TextEncoder().encode(vector.name.normalize('NFKD')))).toBe(vector.normalized.name);
    expect(bytesToHex(new TextEncoder().encode(vector.passphrase.normalize('NFKD')))).toBe(vector.normalized.passphrase);
    expect(factorForShardCount(vector.shards)).toBe(vector.factor);
  }
});

test('canonical manifest authenticates every listed source and native binary', async () => {
  const manifest = await Bun.file(`${import.meta.dir}/MANIFEST.sha256`).text();
  const entries = manifest.trim().split('\n').map(line => {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (match === null) throw new Error(`BRAINVAULT_MANIFEST_LINE_INVALID:${line}`);
    return { expected: match[1]!, path: match[2]! };
  });
  expect(new Set(entries.map(entry => entry.path)).size).toBe(entries.length);
  for (const required of [
    'SPEC-V1.md',
    'vectors-v1.json',
    'primitives/spec.ts',
    'primitives/kdf.ts',
    'core.ts',
    'prebuilds/darwin-arm64/brainvault-argon2',
    'prebuilds/darwin-arm64/brainvault-argon2-rust',
  ]) {
    expect(entries.some(entry => entry.path === required)).toBe(true);
  }
  for (const entry of entries) {
    expect(entry.path.startsWith('/')).toBe(false);
    expect(entry.path.split('/')).not.toContain('..');
    const bytes = new Uint8Array(await Bun.file(`${import.meta.dir}/${entry.path}`).arrayBuffer());
    const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    expect(actual).toBe(entry.expected);
  }
});

test('salt is deterministic', async () => {
  for (const v of VECTORS) {
    const salt = await createShardSalt(v.name, 0, v.shards);
    expect(bytesToHex(salt)).toBe(v.expect.salt0);
  }
});

test('salt rejects values that cannot be encoded exactly', async () => {
  await expect(createShardSalt('', 0, 1)).rejects.toThrow('BRAINVAULT_NAME_INVALID');
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
  expect(validateInputs('a', 'a', 1).valid).toBe(true);
  expect(validateInputs('a', 'aaaaaa', Number.NaN).valid).toBe(false);
});

test('user levels skip 10 shards without renumbering the frozen V1 factor', () => {
  expect(BRAINVAULT_DEFAULT_LEVEL).toBe(3);
  expect([...BRAINVAULT_LEVEL_NAMES]).toEqual(['test', 'quick', 'standard', 'strong', 'vault', 'million']);
  expect([...BRAINVAULT_LEVEL_SHARDS]).toEqual([1, 100, 1_000, 10_000, 100_000, 1_000_000]);
  for (const [index, shardCount] of BRAINVAULT_LEVEL_SHARDS.entries()) {
    expect(getShardCountForLevel(index + 1)).toBe(shardCount);
  }
  expect(factorForShardCount(getShardCountForLevel(3))).toBe(4);
  expect(getShardCount(2)).toBe(10);
  expect(() => getShardCountForLevel(0)).toThrow('BRAINVAULT_LEVEL_INVALID:0');
  expect(() => getShardCountForLevel(7)).toThrow('BRAINVAULT_LEVEL_INVALID:7');
});

test('suggested passwords use ten unbiased alphanumeric CSPRNG choices', () => {
  expect(SUGGESTED_PASSWORD_CHARACTERS).toBe(10);
  expect(SUGGESTED_PASSWORD_ALPHABET).toBe('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  expect(SUGGESTED_PASSWORD_BITS).toBeCloseTo(59.5419631039, 8);
  expect(passwordFromIndexes(Array(10).fill(0))).toBe('aaaaaaaaaa');
  expect(passwordFromIndexes(Array(10).fill(61))).toBe('9999999999');
  expect(() => passwordFromIndexes(Array(9).fill(0))).toThrow('BRAINVAULT_SUGGESTION_LENGTH_INVALID');
  expect(() => passwordFromIndexes([...Array(9).fill(0), 62])).toThrow('BRAINVAULT_SUGGESTION_INDEX_INVALID:62');
  expect(generateSuggestedPassword()).toMatch(/^[a-zA-Z0-9]{10}$/);
});

test('wallet boundaries fail loudly on malformed bytes', async () => {
  const salt = await createShardSalt('alice', 0, 1);
  await expect(deriveShard('', salt)).rejects.toThrow('BRAINVAULT_PASSPHRASE_INVALID');
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

test('worker shard collection fails closed on malformed scheduling results', () => {
  const result = '00'.repeat(32);
  const slots = createShardSlots(2);
  expect(acceptShard(slots, { specId: BRAINVAULT_V1_SPEC_ID, shardIndex: 1, result }, BRAINVAULT_V1_SPEC_ID, 32)).toBe(1);
  expect(() => acceptShard(slots, { specId: BRAINVAULT_V1_SPEC_ID, shardIndex: 1, result }, BRAINVAULT_V1_SPEC_ID, 32))
    .toThrow('BRAINVAULT_WORKER_SHARD_DUPLICATE:1');
  expect(() => acceptShard(slots, { specId: BRAINVAULT_V1_SPEC_ID, shardIndex: -1, result }, BRAINVAULT_V1_SPEC_ID, 32))
    .toThrow('BRAINVAULT_WORKER_SHARD_INDEX_INVALID:-1');
  expect(() => acceptShard(slots, { specId: 'wrong', shardIndex: 0, result }, BRAINVAULT_V1_SPEC_ID, 32))
    .toThrow('BRAINVAULT_WORKER_SPEC_MISMATCH:wrong');
  expect(() => acceptShard(slots, { specId: BRAINVAULT_V1_SPEC_ID, shardIndex: 0, result: result.slice(2) }, BRAINVAULT_V1_SPEC_ID, 32))
    .toThrow('BRAINVAULT_WORKER_RESULT_INVALID:0');
  expect(() => finalizeShards(slots)).toThrow('BRAINVAULT_WORKER_SHARD_MISSING:0');
});

test('native worker crashes closed on a wrong spec handshake', async () => {
  const worker = new Worker(`${import.meta.dir}/worker-native.ts`);
  const error = await new Promise<Error>((resolve, reject) => {
    worker.once('error', resolve);
    worker.once('message', () => reject(new Error('worker accepted wrong spec')));
    worker.postMessage({
      specId: 'wrong', name: 'alice', passphrase: 'secret123456', shardIndex: 0, shardCount: 1,
    });
  });
  expect(error.message).toContain('BRAINVAULT_WORKER_SPEC_MISMATCH');
  await worker.terminate();
});

async function tinyRoot(name: string, passphrase: string, shardCount = 1): Promise<string> {
  const params = {
    algId: `${BRAINVAULT_V1.ALG_ID}|test-8kib`,
    shardMemoryKb: 8,
    argonTimeCost: 1,
    argonParallelism: 1,
    shardOutputBytes: 32,
  };
  const shards = await Promise.all(Array.from({ length: shardCount }, async (_, index) => {
    const salt = await createShardSalt(name, index, shardCount, params.algId);
    return deriveShardWithParams(passphrase, salt, params);
  }));
  return bytesToHex(await combineShardsWithParams(shards, factorForShardCount(shardCount), params));
}

test('Unicode corpus is byte-exact and NFKD-equivalent where specified', async () => {
  expect(await tinyRoot('café', 'secrét-password')).toBe(await tinyRoot('cafe\u0301', 'secre\u0301t-password'));
  const corpus = [
    ['Case', 'passwordA'],
    ['case', 'passworda'],
    [' leading ', ' password '],
    ['emoji-🧠', 'vault-🔐'],
    ['nul\0name', 'nul\0password'],
    ['lone-\ud800', 'lone-\udfff-password'],
    ['x'.repeat(16_384), 'y'.repeat(16_384)],
  ] as const;
  const roots = await Promise.all(corpus.map(([name, passphrase]) => tinyRoot(name, passphrase)));
  expect(new Set(roots).size).toBe(corpus.length);
});

test('every semantic input and KDF domain parameter separates the root', async () => {
  const base = await tinyRoot('alice', 'secret123456');
  for (const changed of [
    tinyRoot('Alice', 'secret123456'),
    tinyRoot(' alice', 'secret123456'),
    tinyRoot('alice', 'Secret123456'),
    tinyRoot('alice', ' secret123456'),
    tinyRoot('alice', 'secret123456', 2),
  ]) expect(await changed).not.toBe(base);

  const shard = new Uint8Array(32).fill(7);
  const canonical = bytesToHex(await combineShardsWithParams([shard], 1));
  const mutations = [
    combineShardsWithParams([shard], 2),
    combineShardsWithParams([shard], 1, { algId: `${BRAINVAULT_V1.ALG_ID}|mutated` }),
    combineShardsWithParams([shard], 1, { shardMemoryKb: BRAINVAULT_V1.SHARD_MEMORY_KB * 2 }),
    combineShardsWithParams([shard], 1, { argonTimeCost: 2 }),
    combineShardsWithParams([shard], 1, { argonParallelism: 2 }),
  ];
  for (const mutation of mutations) expect(bytesToHex(await mutation)).not.toBe(canonical);
  expect(rootDomain(1, 1)).toContain('|shards=1|factor=1');
});

test('completion order is irrelevant but final shard order is canonical', async () => {
  const source = Array.from({ length: 32 }, (_, index) => new Uint8Array(32).fill(index));
  const expected = bytesToHex(await combineShards(source, 3));
  const completionOrder = Array.from({ length: 32 }, (_, index) => (index * 13) % 32);
  const slots = createShardSlots(32);
  for (const index of completionOrder) {
    acceptShard(slots, {
      specId: BRAINVAULT_V1_SPEC_ID,
      shardIndex: index,
      result: bytesToHex(source[index]!),
    }, BRAINVAULT_V1_SPEC_ID, 32);
  }
  expect(bytesToHex(await combineShards(finalizeShards(slots), 3))).toBe(expected);
  expect(bytesToHex(await combineShards([...source].reverse(), 3))).not.toBe(expected);
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

function runCli(cliArgs: readonly string[], input = '') {
  return Bun.spawnSync({
    cmd: ['bun', 'cli.ts', ...cliArgs],
    cwd: import.meta.dir,
    stdin: Buffer.from(input),
    stderr: 'pipe',
    stdout: 'pipe',
  });
}

function runCliTty(extraArgs: readonly string[], reveal = false) {
  const command = ['bun', 'cli.ts', '--shards', '1', '--workers', '1', '--engine', 'native', ...extraArgs].join(' ');
  const script = [
    'set timeout 10',
    `spawn ${command}`,
    'expect "Username: "',
    'send "alice\\r"',
    'expect "Password: "',
    'send "secret123456\\r"',
    reveal ? 'expect "Repeat the exact password: "' : 'expect "Type reveal"',
    reveal ? 'send "secret123456\\r"' : 'send "\\r"',
    'expect eof',
  ].join('\n');
  return Bun.spawnSync({
    cmd: ['expect', '-c', script],
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
}

function publicSummary(output: string): { fingerprint: string; address: string } {
  const fingerprint = output.match(/Root fingerprint: ([0-9a-f]{8})/)?.[1];
  const address = output.match(/First address:\s+(0x[0-9A-Fa-f]{40})/)?.[1];
  if (fingerprint === undefined || address === undefined) throw new Error(`BRAINVAULT_PUBLIC_SUMMARY_MISSING:${output}`);
  return { fingerprint, address };
}

test('CLI keeps secrets off argv and prints only public summary by default', () => {
  const positional = runCli(['alice', 'secret123456', '1']);
  expect(positional.exitCode).toBe(1);
  expect(positional.stderr.toString()).toContain('positional username/password arguments are forbidden');

  const unsafe = runCli(['--unsafe-password', 'secret123456']);
  expect(unsafe.exitCode).toBe(1);
  expect(unsafe.stderr.toString()).toContain('password argv is forbidden');

  const launched = runCliTty([]);
  const output = launched.stdout.toString();
  const vector = VECTORS[0]!;
  expect(launched.exitCode).toBe(0);
  expect(publicSummary(output)).toEqual({ fingerprint: vector.expect.masterKey.slice(0, 8), address: vector.expect.ethAddr });
  expect(output).not.toContain(vector.expect.mnemonic24);
  expect(output).not.toContain('Private Key 1:');

  const rawKeyWithoutReveal = runCli(['--show-private-key']);
  expect(rawKeyWithoutReveal.exitCode).toBe(1);
  expect(rawKeyWithoutReveal.stderr.toString()).toContain('--show-private-key requires --reveal');
});

test('Ctrl+C exits the entire CLI and impossible RAM plans fail before allocation', () => {
  const script = [
    'set timeout 5',
    'spawn bun cli.ts --shards 1 --workers 1',
    'expect "Username: "',
    'send "\\003"',
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n');
  const aborted = Bun.spawnSync({ cmd: ['expect', '-c', script], cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe' });
  expect(aborted.exitCode).toBe(130);
  expect(aborted.stdout.toString()).toContain('Exited.');

  const oversized = runCli(['--bench', '--shards', '1', '--workers', '1', '--multiplier', '10000']);
  expect(oversized.exitCode).toBe(1);
  expect(oversized.stderr.toString()).toContain('BRAINVAULT_WORKERS_EXCEED_MEMORY_LIMIT');
});

test('CLI defaults to printable ASCII while preserving explicit Unicode recovery', () => {
  expect(cliCreationCharacterError('alice', 'secret123456', false)).toBeUndefined();
  expect(cliCreationCharacterError('café', 'secret123456', false)).toContain('BRAINVAULT_ASCII_CREATION_REQUIRED');
  expect(cliCreationCharacterError('café', 'secrét-password', true)).toBeUndefined();
  expect(cliPasswordError('1234567', false)).toContain('BRAINVAULT_PASSPHRASE_TOO_SHORT');
  expect(cliPasswordError('1234567', true)).toBeUndefined();
});

test('reveal requires exact password rehearsal before sensitive output', () => {
  const revealed = runCliTty(['--reveal'], true);
  const output = revealed.stdout.toString();
  expect(revealed.exitCode).toBe(0);
  expect(output).toContain('SENSITIVE OUTPUT');
  expect(output).toContain(VECTORS[0]!.expect.mnemonic24);
});

test('CLI benchmark honors inline advanced parameters', () => {
  const benchmark = Bun.spawnSync({
    cmd: [
      'bun', 'cli.ts', '--bench', '--shards', '1', '--multiplier', '2',
      '--workers', '1', '--engine', 'native',
    ],
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const output = benchmark.stdout.toString();
  expect(benchmark.exitCode).toBe(0);
  expect(output).toContain('1 shards | factor 1 | multiplier 2 | 1 workers');
  expect(output).toContain('Native isolated workers');
  expect(output).toContain('Root[0..4]');
  expect(output).not.toContain('[1/1] C/NEON');
});

test('npm launcher preserves the BrainVault v1 CLI entrypoint', () => {
  const launched = Bun.spawnSync({
    cmd: ['bun', 'brainvault', '--help'],
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  expect(launched.exitCode).toBe(0);
  expect(launched.stdout.toString()).toStartWith('BrainVault v1 (bv)');
});

test('every available wallet engine reproduces the same smoke root', () => {
  const smoke = runCli(['--smoke', '--workers', '32']);
  expect(smoke.exitCode).toBe(0);
  expect(smoke.stdout.toString()).toContain('Root parity: PASS');
}, 15_000);

test('exact --shards remains distinct from legacy --factor in benchmark parsing', () => {
  const exact = Bun.spawnSync({
    cmd: ['bun', 'cli.ts', '--bench', '--shards', '2', '--workers', '1', '--engine', 'native'],
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  expect(exact.exitCode).toBe(0);
  expect(exact.stdout.toString()).toContain('2 shards | factor 2 | multiplier 1 | 1 workers');

  const level = Bun.spawnSync({
    cmd: ['bun', 'cli.ts', '--bench', '--level', '1', '--workers', '1', '--engine', 'native'],
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  expect(level.exitCode).toBe(0);
  expect(level.stdout.toString()).toContain('1 shards | factor 1 | multiplier 1 | 1 workers');
});

test('custom multiplier preserves final wallet parity across compatible engines', () => {
  const engines = ['c-neon', 'c-neon-wipe', 'native-direct', 'native-sync', 'native', 'rust', 'rust-no-wipe', 'wasm'];
  let expected: string | undefined;
  for (const engine of engines) {
    const child = runCli(['--bench', '--shards', '1', '--workers', '1', '--multiplier', '2', '--engine', engine]);
    expect(child.exitCode).toBe(0);
    const output = child.stdout.toString().match(/Root parity: PASS \(([0-9a-f]{64})\)/)?.[1];
    expect(output).toBeDefined();
    expected ??= output;
    expect(output).toBe(expected);
  }
});

console.log('✅ All deterministic tests passed');
console.log('These vectors define wallet compatibility - never change them!');
