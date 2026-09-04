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
import { cpus, tmpdir, totalmem } from 'node:os';
import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  createShardSalt, deriveShard, deriveShardWithParams, combineShards, combineShardsWithParams, deriveKey,
  entropyToMnemonic, deriveEthereumAddress, deriveEthereumAddressMatrix,
  deriveEthereumPrivateKeyAtPath, bytesToHex,
  deriveSitePassword, factorForShardCount, getShardCount, hexToBytes, validateInputs, rootDomain,
} from './core.ts';
import { BIP39_ENGLISH } from './bip39-english.ts';
import { resolveKdfParams } from './primitives/kdf.ts';
import { copyAndWipe } from './primitives/encoding.ts';
import { BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID, shardRequestFingerprint } from './primitives/spec.ts';
import { acceptShard, createShardSlots, finalizeShards } from './shard-collector.ts';
import {
  cliCreationCharacterError, cliDomainError, cliPasswordError, cliProgressStatusLine,
  publicErrorCode, publicErrorMessage,
} from './cli-policy.ts';
import { deriveBrainVaultNative } from './native.ts';
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

test('public errors retain codes without disclosing diagnostics', () => {
  expect(publicErrorCode(
    new Error('BRAINVAULT_NATIVE_FAILURE:/Users/example/SENSITIVE-PATH'),
    'BRAINVAULT_UNEXPECTED_FAILURE',
  )).toBe('BRAINVAULT_NATIVE_FAILURE');
  expect(publicErrorCode(
    new Error('failure at /Users/example/SENSITIVE-PATH'),
    'BRAINVAULT_UNEXPECTED_FAILURE',
  )).toBe('BRAINVAULT_UNEXPECTED_FAILURE');
  expect(publicErrorMessage(
    new Error('BRAINVAULT_PASSWORD_MODE_TERMINAL_REQUIRED:/Users/example/SENSITIVE-PATH'),
    'BRAINVAULT_UNEXPECTED_FAILURE',
  )).toBe('BRAINVAULT_PASSWORD_MODE_TERMINAL_REQUIRED: site passwords require alternate-screen support');
});

test('site-password domains reject terminal control bytes before display', () => {
  expect(cliDomainError('example.com')).toBeUndefined();
  expect(cliDomainError('bücher.example')).toBeUndefined();
  for (const domain of ['evil\x1b[?1049l.example', 'evil\u009b31m.example', 'evil\x07.example']) {
    expect(cliDomainError(domain)).toBe('Domain cannot contain terminal control characters.');
  }
});

test('backend-owned secret bytes are copied for the caller and wiped', () => {
  const owned = Uint8Array.of(1, 2, 3, 255);
  const copy = copyAndWipe(owned);
  expect(copy).toEqual(Uint8Array.of(1, 2, 3, 255));
  expect(owned).toEqual(Uint8Array.of(0, 0, 0, 0));
});

test('full progress status never wraps at its non-compact terminal boundary', () => {
  const line = cliProgressStatusLine(10_000, 10_000, 99.9, 'ETA 16m 59s', 32, 72);
  expect(line.length).toBeLessThanOrEqual(72);
});

test('promo banner stays inside an ultra-narrow terminal', () => {
  const script = [
    'set timeout 5',
    'spawn env COLUMNS=20 NO_COLOR=1 TERM=xterm-256color bun cli.ts --promo',
    'expect "brainvault.sh"',
    'exec kill -INT [exp_pid]',
    'expect eof',
  ].join('\n');
  const result = Bun.spawnSync({
    cmd: ['expect', '-c', script], cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe',
  });
  const lines = result.stdout.toString()
    .replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/[\r\n]+/)
    .filter(line => line !== '' && !line.startsWith('spawn '));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
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
    'native-hybrid.ts',
    'prebuilds/darwin-arm64/brainvault-argon2',
    'prebuilds/darwin-arm64/brainvault-argon2-m3',
    'prebuilds/darwin-arm64/brainvault-argon2-rust',
    'prebuilds/darwin-arm64/brainvault-argon2-rust-m3',
    'prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe',
    'prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe-m3',
    'prebuilds/darwin-arm64/brainvault-argon2-metal',
    'prebuilds/darwin-arm64/argon2.metallib',
    'prebuilds/darwin-arm64/brainvault-argon2-opencl',
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
  expect(factorForShardCount(0xffff_ffff)).toBe(11);
  expect(() => factorForShardCount(0x1_0000_0000)).toThrow('BRAINVAULT_SHARD_COUNT_INVALID:4294967296');
  expect(() => rootDomain(11, 0x1_0000_0000)).toThrow('BRAINVAULT_SHARD_COUNT_INVALID:4294967296');
  expect(() => shardRequestFingerprint(
    0,
    0x1_0000_0000,
    BRAINVAULT_V1.ALG_ID,
    BRAINVAULT_V1.SHARD_MEMORY_KB,
  )).toThrow('BRAINVAULT_WORKER_REQUEST_INVALID');
  expect(() => getShardCount(Number.NaN)).toThrow('Factor must be 1-9');
  expect(() => getShardCount(1.5)).toThrow('Factor must be 1-9');
  expect(validateInputs('a', 'a', 1).valid).toBe(true);
  expect(validateInputs('a', 'aaaaaa', Number.NaN).valid).toBe(false);
});

test('user levels skip 10 shards without renumbering the frozen V1 factor', () => {
  expect(BRAINVAULT_DEFAULT_LEVEL).toBe(4);
  expect([...BRAINVAULT_LEVEL_NAMES]).toEqual(['test', 'unsafe', 'quick', 'standard', 'hard', 'million']);
  expect([...BRAINVAULT_LEVEL_SHARDS]).toEqual([1, 100, 1_000, 10_000, 100_000, 1_000_000]);
  for (const [index, shardCount] of BRAINVAULT_LEVEL_SHARDS.entries()) {
    expect(getShardCountForLevel(index + 1)).toBe(shardCount);
  }
  expect(factorForShardCount(getShardCountForLevel(4))).toBe(5);
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
  expect(() => resolveKdfParams({ algId: null as unknown as string })).toThrow('BRAINVAULT_ALG_ID_INVALID');
  expect(() => resolveKdfParams({ shardMemoryKb: null as unknown as number }))
    .toThrow('BRAINVAULT_KDF_PARAMETER_INVALID:shardMemoryKb');
  await expect(createShardSalt('alice', 0, 1, null as unknown as string)).rejects.toThrow('BRAINVAULT_ALG_ID_INVALID');
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
  const expectedRequest = (index: number) => shardRequestFingerprint(index, 2, BRAINVAULT_V1.ALG_ID, BRAINVAULT_V1.SHARD_MEMORY_KB);
  const requestId = expectedRequest(1);
  expect(acceptShard(slots, { specId: BRAINVAULT_V1_SPEC_ID, requestId, shardIndex: 1, result }, BRAINVAULT_V1_SPEC_ID, 32, expectedRequest)).toBe(1);
  expect(() => acceptShard(slots, { specId: BRAINVAULT_V1_SPEC_ID, requestId, shardIndex: 1, result }, BRAINVAULT_V1_SPEC_ID, 32, expectedRequest))
    .toThrow('BRAINVAULT_WORKER_SHARD_DUPLICATE:1');
  expect(() => acceptShard(slots, { specId: BRAINVAULT_V1_SPEC_ID, requestId, shardIndex: -1, result }, BRAINVAULT_V1_SPEC_ID, 32, expectedRequest))
    .toThrow('BRAINVAULT_WORKER_SHARD_INDEX_INVALID');
  expect(() => acceptShard(slots, { specId: 'wrong', requestId, shardIndex: 0, result }, BRAINVAULT_V1_SPEC_ID, 32, expectedRequest))
    .toThrow('BRAINVAULT_WORKER_SPEC_MISMATCH');
  expect(() => acceptShard(slots, { specId: BRAINVAULT_V1_SPEC_ID, requestId: 'wrong', shardIndex: 0, result }, BRAINVAULT_V1_SPEC_ID, 32, expectedRequest))
    .toThrow('BRAINVAULT_WORKER_REQUEST_MISMATCH:0');
  expect(() => acceptShard(slots, { specId: BRAINVAULT_V1_SPEC_ID, requestId: expectedRequest(0), shardIndex: 0, result: result.slice(2) }, BRAINVAULT_V1_SPEC_ID, 32, expectedRequest))
    .toThrow('BRAINVAULT_WORKER_RESULT_INVALID:0');
  expect(() => finalizeShards(slots)).toThrow('BRAINVAULT_WORKER_SHARD_MISSING:0');
});

test('malformed worker output never reflects attacker-controlled bytes in errors', () => {
  const marker = 'SENSITIVE1234567';
  const expectedRequest = (index: number) => shardRequestFingerprint(
    index, 1, BRAINVAULT_V1.ALG_ID, BRAINVAULT_V1.SHARD_MEMORY_KB,
  );
  const capture = (message: Parameters<typeof acceptShard>[1]): string => {
    try {
      acceptShard(createShardSlots(1), message, BRAINVAULT_V1_SPEC_ID, 32, expectedRequest);
      throw new Error('worker message unexpectedly accepted');
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const base = { requestId: expectedRequest(0), shardIndex: 0, result: '00'.repeat(32) };
  expect(capture({ ...base, specId: marker })).not.toContain(marker);
  expect(capture({ ...base, specId: BRAINVAULT_V1_SPEC_ID, shardIndex: marker })).not.toContain(marker);
  expect(capture({
    ...base,
    specId: BRAINVAULT_V1_SPEC_ID,
    result: `${marker}${'0'.repeat(48)}`,
  })).not.toContain(marker);
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

test('browser worker rejects malformed KDF fields without returning a stack', async () => {
  const worker = new globalThis.Worker(new URL('./worker-browser.ts', import.meta.url));
  try {
    const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
      worker.onmessage = event => resolve(event.data as Record<string, unknown>);
      worker.onerror = reject;
      worker.postMessage({
        type: 'derive_shard',
        id: 'malformed-kdf',
        data: {
          name: 'alice', passphrase: 'secret123456', shardIndex: 0, shardCount: 1,
          shardMemoryKb: 8, algId: 123,
        },
      });
    });
    expect(message['type']).toBe('error');
    const data = message['data'] as Record<string, unknown>;
    expect(data['message']).toBe('BRAINVAULT_ALG_ID_INVALID');
    expect(data['stack']).toBeUndefined();
  } finally {
    worker.terminate();
  }
});

test('native orchestration rejects worker crash, truncation, and unsafe concurrency', async () => {
  const input = { name: 'alice', passphrase: 'secret123456', shardInput: 1, workers: 1 };
  await expect(deriveBrainVaultNative(input, {
    workerPath: `${import.meta.dir}/test-fixtures/worker-crash.ts`,
  })).rejects.toThrow('BRAINVAULT_TEST_WORKER_CRASH');
  await expect(deriveBrainVaultNative(input, {
    workerPath: `${import.meta.dir}/test-fixtures/worker-truncated.ts`,
  })).rejects.toThrow('BRAINVAULT_WORKER_RESULT_INVALID:0');
  const unsafeWorkers = cpus().length + 1;
  await expect(deriveBrainVaultNative({
    name: 'alice', passphrase: 'secret123456', shardInput: unsafeWorkers, workers: unsafeWorkers,
  })).rejects.toThrow('BRAINVAULT_WORKERS_EXCEED_MEMORY_LIMIT');
});

test('native worker reuse preserves output across worker counts', async () => {
  const workerPath = `${import.meta.dir}/test-fixtures/worker-deterministic.ts`;
  const input = { name: 'reuse-audit', passphrase: 'secret123456', shardInput: 6 };
  const progress: number[] = [];
  const sequential = await deriveBrainVaultNative({ ...input, workers: 1 }, { workerPath });
  const parallel = await deriveBrainVaultNative({ ...input, workers: 2 }, {
    workerPath,
    onProgress: state => progress.push(state.completed),
  });
  expect(parallel.ethereumAddress).toBe(sequential.ethereumAddress);
  expect(parallel.mnemonic24).toBe(sequential.mnemonic24);
  expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
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
    combineShardsWithParams([shard], 1, { algId: `${BRAINVAULT_V1.ALG_ID}|mutated` }),
    combineShardsWithParams([shard], 1, { shardMemoryKb: BRAINVAULT_V1.SHARD_MEMORY_KB * 2 }),
    combineShardsWithParams([shard], 1, { argonTimeCost: 2 }),
    combineShardsWithParams([shard], 1, { argonParallelism: 2 }),
  ];
  for (const mutation of mutations) expect(bytesToHex(await mutation)).not.toBe(canonical);
  await expect(combineShardsWithParams([shard], 2)).rejects.toThrow('BRAINVAULT_FACTOR_SHARD_MISMATCH:2:1:1');
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
      requestId: shardRequestFingerprint(index, 32, BRAINVAULT_V1.ALG_ID, BRAINVAULT_V1.SHARD_MEMORY_KB),
      shardIndex: index,
      result: bytesToHex(source[index]!),
    }, BRAINVAULT_V1_SPEC_ID, 32,
    value => shardRequestFingerprint(value, 32, BRAINVAULT_V1.ALG_ID, BRAINVAULT_V1.SHARD_MEMORY_KB));
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

test('frozen primary and secondary wallet projections require an empty BIP-39 passphrase', async () => {
  const root = hexToBytes(VECTORS[0]!.expect.masterKey);
  let entropy24: Uint8Array | undefined;
  let entropy12: Uint8Array | undefined;
  let deviceKey: Uint8Array | undefined;
  try {
    entropy24 = await deriveKey(root, 'bip39/entropy/v1.0', 32);
    entropy12 = await deriveKey(root, 'bip39/entropy-128/v1.0', 16);
    deviceKey = await deriveKey(root, 'bip39/passphrase/v1.0', 32);
    expect(bytesToHex(entropy24)).toBe('8c85565c5b802462d9192ed6f214c9c87bee6f815d80e5d550cfc585a38fb2db');
    expect(bytesToHex(entropy12)).toBe('ae9bf95d7efd2d6fc90b6bd946987cb0');
    expect(bytesToHex(deviceKey)).toBe('11df7157aca9601b068f4d1db9250c8cf57280e67cb2d0613272d237957bdf79');

    const mnemonic24 = await entropyToMnemonic(entropy24);
    const mnemonic12 = await entropyToMnemonic(entropy12);
    expect(mnemonic24).toBe(VECTORS[0]!.expect.mnemonic24);
    expect(mnemonic12).toBe('purse thank firm worth spot retire category hope sun crumble busy genre');
    expect(await deriveEthereumAddressMatrix(mnemonic24, '', 2)).toEqual({
      standard: [
        '0x93bAb14eD871462D414a7c0357BF1a76DE741397',
        '0x1793b08bf6e9c0799a42549675d76C5A83b5d594',
      ],
      ledgerLive: [
        '0x93bAb14eD871462D414a7c0357BF1a76DE741397',
        '0xd2eF9B8B9D4bc50402699568934090213191755E',
      ],
    });
    expect(await deriveEthereumAddressMatrix(mnemonic12, '', 2)).toEqual({
      standard: [
        '0xA46b8748D14619c77DC1f12eBD6bE4c4cE4cfF5a',
        '0xa4D112B638ABe3c4bA85b804C4631FB1FB0e0f90',
      ],
      ledgerLive: [
        '0xA46b8748D14619c77DC1f12eBD6bE4c4cE4cfF5a',
        '0x27fB8485414AC7188a0182F3C82d36955C437E90',
      ],
    });
    expect(await deriveEthereumPrivateKeyAtPath(mnemonic24, "m/44'/60'/0'/0/0", ''))
      .toBe('0x341c055336e121ee7b59c44a17a14ab54c7fbe91af3b863fcf034436dfd0e1bc');
    expect(await deriveEthereumPrivateKeyAtPath(mnemonic12, "m/44'/60'/0'/0/0", ''))
      .toBe('0x0629efa17a38592ea767eb43c679da13f7d28248ed518c7b3f400e5a09871264');
    expect(await deriveEthereumAddress(mnemonic24, 'BrainVault password'))
      .toBe('0x4F1557BCc80C24b23A58D88e690a405597601cfB');
    expect(await deriveEthereumAddress(mnemonic24, '')).toBe(VECTORS[0]!.expect.ethAddr);
  } finally {
    root.fill(0);
    entropy24?.fill(0);
    entropy12?.fill(0);
    deviceKey?.fill(0);
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

test('two-shard frozen smoke vector pins the public wallet projection', async () => {
  const v = VECTORS.find(x => x.shards === 2)!;
  const shards = await Promise.all(Array.from({ length: v.shards }, async (_, index) => {
    const salt = await createShardSalt(v.name, index, v.shards);
    const shard = await deriveShard(v.passphrase, salt);
    if (index === 0) expect(bytesToHex(shard)).toBe(v.expect.shard0);
    return shard;
  }));
  const masterKey = await combineShards(shards, v.factor);
  expect(bytesToHex(masterKey)).toBe(v.expect.masterKey);
  const mnemonic = await entropyToMnemonic(await deriveKey(masterKey, 'bip39/entropy/v1.0', 32));
  expect(mnemonic).toBe(v.expect.mnemonic24);
  expect(await deriveEthereumAddress(mnemonic)).toBe(v.expect.ethAddr);
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

function runCliInputTty(
  extraArgs: readonly string[],
  interactions: readonly string[],
  commandPrefix = 'env TERM=xterm-256color COLUMNS=80 ',
) {
  const command = `${commandPrefix}${['bun', 'cli.ts', ...extraArgs].join(' ')}`;
  const columns = Number(commandPrefix.match(/COLUMNS=(\d+)/)?.[1] ?? 80);
  const rows = Number(commandPrefix.match(/LINES=(\d+)/)?.[1] ?? 24);
  const script = [
    'set timeout 10',
    `set stty_init "rows ${rows} cols ${columns}"`,
    `spawn ${command}`,
    ...interactions,
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n');
  return Bun.spawnSync({
    cmd: ['expect', '-c', script], cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe',
  });
}

function runCliTty(extraArgs: readonly string[], confirmation = '') {
  const command = ['env', 'TERM=xterm-256color', 'COLUMNS=80', 'bun', 'cli.ts', '--shards', '1', '--workers', '1', '--engine', 'native', ...extraArgs].join(' ');
  const script = [
    'set timeout 10',
    'set stty_init "rows 24 cols 80"',
    `spawn ${command}`,
    'expect "Username: "',
    'send "alice\\r"',
    'expect "Password (hidden; typing works): "',
    'send "secret123456\\r"',
    'expect "Re-enter password to show recovery words (hidden; typing works), or press Enter to exit: "',
    `send "${confirmation}\\r"`,
    ...(confirmation !== 'secret123456' ? [] : [
      'expect "Press Enter for the SECONDARY wallet: "',
      'send "\\r"',
      'expect "Press Enter to clear and exit: "',
      'send "\\r"',
    ]),
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n');
  return Bun.spawnSync({
    cmd: ['expect', '-c', script],
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
}

function runSensitivePreflight(
  term: string,
  columns: number,
  rows: number,
  modeArgs: readonly string[] = ['--password'],
) {
  const script = [
    'set timeout 3',
    `set stty_init "rows ${rows} cols ${columns}"`,
    `spawn env -u COLUMNS -u LINES NO_COLOR=1 TERM=${term} bun cli.ts ${modeArgs.join(' ')}`,
    'expect {',
    '  "site passwords require alternate-screen support" {}',
    '  "suggested passwords require a reliable interactive terminal" {}',
    '  "Username: " { send "\\003" }',
    '}',
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n');
  return Bun.spawnSync({
    cmd: ['expect', '-c', script], cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe',
  });
}

function runAnimatedCliTty(noColor: boolean, columns = 80) {
  const environment = noColor
    ? `env NO_COLOR=1 TERM=xterm-256color COLUMNS=${columns}`
    : `env -u NO_COLOR TERM=xterm-256color COLUMNS=${columns}`;
  const script = [
    'set timeout 10',
    `set stty_init "rows 24 cols ${columns}"`,
    `spawn ${environment} bun cli.ts --shards 100 --workers 32 --engine c-neon`,
    'expect "Username: "',
    'send "progress-audit\\r"',
    'expect "Password (hidden; typing works): "',
    'send "secret123456\\r"',
    'expect "Re-enter password to show recovery words (hidden; typing works), or press Enter to exit: "',
    'send "\\r"',
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n');
  return Bun.spawnSync({
    cmd: ['expect', '-c', script],
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
}

function runBrokenAcceleratorCliTty() {
  const temp = mkdtempSync(join(tmpdir(), 'brainvault-broken-accelerator-tty-'));
  try {
    const packed = Bun.spawnSync({
      cmd: ['bun', 'pm', 'pack', '--ignore-scripts', '--destination', temp, '--quiet'],
      cwd: import.meta.dir,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    if (packed.exitCode !== 0) throw new Error(`BRAINVAULT_TEST_PACK_FAILED:${packed.stderr.toString()}`);
    const tarball = packed.stdout.toString().trim();
    const archive = tarball.startsWith('/') ? tarball : join(temp, tarball);
    const extract = join(temp, 'extract');
    mkdirSync(extract);
    const unpacked = Bun.spawnSync({ cmd: ['tar', '-xzf', archive, '-C', extract], stderr: 'pipe' });
    if (unpacked.exitCode !== 0) throw new Error(`BRAINVAULT_TEST_UNPACK_FAILED:${unpacked.stderr.toString()}`);

    const packageRoot = join(extract, 'package');
    const localModules = join(import.meta.dir, 'node_modules');
    symlinkSync(existsSync(localModules) ? localModules : join(import.meta.dir, '..'), join(packageRoot, 'node_modules'));
    const executablePath = join(packageRoot, 'prebuilds/darwin-arm64/brainvault-argon2-metal');
    const failureFixture = join(import.meta.dir, 'test-fixtures/native-failure.ts');
    copyFileSync(failureFixture, executablePath);
    chmodSync(executablePath, 0o755);
    const digest = new Bun.CryptoHasher('sha256').update(readFileSync(executablePath)).digest('hex');
    const manifestPath = join(packageRoot, 'MANIFEST.sha256');
    const manifest = readFileSync(manifestPath, 'utf8').replace(
      /^[0-9a-f]{64}  prebuilds\/darwin-arm64\/brainvault-argon2-metal$/m,
      `${digest}  prebuilds/darwin-arm64/brainvault-argon2-metal`,
    );
    writeFileSync(manifestPath, manifest);

    const script = [
      'set timeout 30',
      `spawn env NO_COLOR=1 TERM=xterm-256color COLUMNS=80 bun ${join(packageRoot, 'cli.ts')} --shards 1000 --workers 32`,
      'expect "Username: "', 'send "broken-accelerator-audit\\r"',
      'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
      // A broken accelerator ends the CLI before any prompt; a healthy one reaches the reveal prompt.
      'expect { "or press Enter to exit: " { send "\\r"; exp_continue } eof {} }',
      'catch wait result',
      'exit [lindex $result 3]',
    ].join('\n');
    return Bun.spawnSync({
      cmd: ['expect', '-c', script], cwd: packageRoot, stderr: 'pipe', stdout: 'pipe',
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function runMissingNativeWorkerCliTty() {
  const temp = mkdtempSync(join(tmpdir(), 'brainvault-missing-worker-'));
  try {
    const packed = Bun.spawnSync({
      cmd: ['bun', 'pm', 'pack', '--ignore-scripts', '--destination', temp, '--quiet'],
      cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe',
    });
    if (packed.exitCode !== 0) throw new Error(`BRAINVAULT_TEST_PACK_FAILED:${packed.stderr.toString()}`);
    const reported = packed.stdout.toString().trim();
    const archive = reported.startsWith('/') ? reported : join(temp, reported);
    const extract = join(temp, 'extract');
    mkdirSync(extract);
    const unpacked = Bun.spawnSync({ cmd: ['tar', '-xzf', archive, '-C', extract], stderr: 'pipe' });
    if (unpacked.exitCode !== 0) throw new Error(`BRAINVAULT_TEST_UNPACK_FAILED:${unpacked.stderr.toString()}`);
    const packageRoot = join(extract, 'package');
    const localModules = join(import.meta.dir, 'node_modules');
    symlinkSync(existsSync(localModules) ? localModules : join(import.meta.dir, '..'), join(packageRoot, 'node_modules'));
    rmSync(join(packageRoot, 'worker-native.ts'));
    const script = [
      'set timeout 10',
      'spawn env TERM=xterm-256color COLUMNS=80 bun cli.ts --shards 1 --workers 1 --engine native',
      'expect "Username: "', 'send "alice\\r"',
      'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
      'expect eof', 'catch wait result', 'exit [lindex $result 3]',
    ].join('\n');
    return Bun.spawnSync({ cmd: ['expect', '-c', script], cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function runSignalDuringNativeDerivation(signal: 'TERM' | 'HUP') {
  const temp = mkdtempSync(join(tmpdir(), 'brainvault-signal-child-'));
  try {
    const packed = Bun.spawnSync({
      cmd: ['bun', 'pm', 'pack', '--ignore-scripts', '--destination', temp, '--quiet'],
      cwd: import.meta.dir,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    if (packed.exitCode !== 0) throw new Error(`BRAINVAULT_TEST_PACK_FAILED:${packed.stderr.toString()}`);
    const packedPath = packed.stdout.toString().trim();
    const archive = packedPath.startsWith('/') ? packedPath : join(temp, packedPath);
    const extract = join(temp, 'extract');
    mkdirSync(extract);
    const unpacked = Bun.spawnSync({ cmd: ['tar', '-xzf', archive, '-C', extract], stderr: 'pipe' });
    if (unpacked.exitCode !== 0) throw new Error(`BRAINVAULT_TEST_UNPACK_FAILED:${unpacked.stderr.toString()}`);

    const packageRoot = join(extract, 'package');
    const localModules = join(import.meta.dir, 'node_modules');
    symlinkSync(existsSync(localModules) ? localModules : join(import.meta.dir, '..'), join(packageRoot, 'node_modules'));
    const executablePaths = [
      join(packageRoot, 'prebuilds/darwin-arm64/brainvault-argon2'),
      join(packageRoot, 'prebuilds/darwin-arm64/brainvault-argon2-m3'),
    ];
    const fixturePath = join(import.meta.dir, 'test-fixtures/native-hang.ts');
    for (const executablePath of executablePaths) {
      copyFileSync(fixturePath, executablePath);
      chmodSync(executablePath, 0o755);
    }
    const digest = new Bun.CryptoHasher('sha256').update(readFileSync(fixturePath)).digest('hex');
    const manifestPath = join(packageRoot, 'MANIFEST.sha256');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8')
      .replace(
        /^[0-9a-f]{64}  prebuilds\/darwin-arm64\/brainvault-argon2$/m,
        `${digest}  prebuilds/darwin-arm64/brainvault-argon2`,
      )
      .replace(
        /^[0-9a-f]{64}  prebuilds\/darwin-arm64\/brainvault-argon2-m3$/m,
        `${digest}  prebuilds/darwin-arm64/brainvault-argon2-m3`,
      ));
    const cliPidFile = join(temp, 'cli.pid');
    const nativePidFile = join(temp, 'native.pid');
    const wrapper = join(import.meta.dir, 'test-fixtures/cli-signal-wrapper.ts');
    const script = [
      'set timeout 10',
      `spawn env NO_COLOR=1 TERM=xterm-256color bun ${wrapper} ${join(packageRoot, 'cli.ts')} ${cliPidFile} ${nativePidFile} --shards 100 --workers 32 --engine c-neon`,
      'expect "Username: "', 'send "signal-audit\\r"',
      'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
      'expect { "1 / 100 shards" {} timeout { exit 99 } }',
      `set handle [open ${cliPidFile} r]`,
      'set cli_pid [string trim [read $handle]]',
      'close $handle',
      `exec kill -${signal} $cli_pid`,
      'expect "NATIVE_ALIVE:"',
      'exit 0',
    ].join('\n');
    const result = Bun.spawnSync({
      cmd: ['expect', '-c', script], cwd: packageRoot, stderr: 'pipe', stdout: 'pipe',
    });
    const childAlive = result.stdout.toString().includes('NATIVE_ALIVE:1');
    return { result, childAlive };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function runAskCliTty() {
  const script = [
    'set timeout 10',
    'set stty_init "rows 24 cols 80"',
    'spawn env TERM=xterm-256color COLUMNS=80 bun cli.ts --ask --engine native --workers 1 --multiplier 1',
    'expect "Username: "',
    'send "alice\\r"',
    'expect "Password (hidden; typing works): "',
    'send "secret123456\\r"',
    'expect "work level (up/down or j/k, Enter confirms)"',
    // The default is level 4. Three k presses select level 1 before Enter.
    'send "kkk\\r"',
    'expect "Re-enter password to show recovery words (hidden; typing works), or press Enter to exit: "',
    'send "\\r"',
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n');
  return Bun.spawnSync({
    cmd: ['expect', '-c', script],
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
}

function publicSummary(output: string): { fingerprint: string; address: string } {
  const fingerprint = output.match(/Wallet fingerprint:\s+([0-9a-f]{8})/)?.[1];
  const address = output.match(/First receiving address:\s+(0x[0-9A-Fa-f]{40})/)?.[1];
  if (fingerprint === undefined || address === undefined) throw new Error(`BRAINVAULT_PUBLIC_SUMMARY_MISSING:${output}`);
  return { fingerprint, address };
}

test('CLI keeps secrets off argv and prints only public summary by default', () => {
  const positional = runCli(['alice', 'secret123456', '1']);
  expect(positional.exitCode).toBe(1);
  expect(positional.stderr.toString()).toContain('unsupported or secret-bearing argv');

  for (const secretArgs of [
    ['--unsafe-password', 'secret123456'],
    ['--unsafe-password=secret123456'],
    ['--password=secret123456'],
    ['--password', 'secret123456'],
    ['--passphrase=secret123456'],
    ['--bench', 'secret123456'],
    ['--unknown=secret123456'],
  ]) {
    const rejected = runCli(secretArgs);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).toContain('unsupported or secret-bearing argv');
    expect(rejected.stderr.toString()).not.toContain('secret123456');
  }

  for (const recognizedValue of ['engine', 'workers']) {
    const rejected = runCli([`--${recognizedValue}`, 'secret123456']);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).not.toContain('secret123456');
  }

  const duplicateRecoverySetting = runCli(['--shards', '1', '--shards', '2']);
  expect(duplicateRecoverySetting.exitCode).toBe(1);
  expect(duplicateRecoverySetting.stderr.toString()).toContain('duplicate CLI option');

  const launched = runCliTty([]);
  const output = launched.stdout.toString();
  const vector = VECTORS[0]!;
  expect(launched.exitCode).toBe(0);
  expect(output).toContain('fresh independent derivation and compare the complete first receiving address');
  expect(publicSummary(output)).toEqual({ fingerprint: vector.expect.masterKey.slice(0, 8), address: vector.expect.ethAddr });
  expect(output).toContain('1 / 1 shards  ·  1 workers');
  expect(output).not.toContain('secret123456');
  expect(output).not.toContain(vector.expect.mnemonic24);
  expect(output).not.toContain('Private Key 1:');

  const nonInteractiveRawKey = runCli(['--show-private-key']);
  expect(nonInteractiveRawKey.exitCode).toBe(1);
  expect(nonInteractiveRawKey.stderr.toString()).toContain('reliable interactive terminal');

  const piped = runCli(['--shards', '1', '--workers', '1', '--engine', 'native'], 'alice\nsecret123456\n');
  expect(piped.exitCode).toBe(1);
  expect(piped.stderr.toString()).toContain('interactive password input requires a TTY');
  expect(piped.stdout.toString()).not.toContain('secret123456');

  const pipedPasswordMode = runCli(['--password'], 'alice\nsecret123456\n');
  expect(pipedPasswordMode.exitCode).toBe(1);
  expect(pipedPasswordMode.stderr.toString()).toContain('interactive password input requires a TTY');
  expect(pipedPasswordMode.stdout.toString()).not.toContain('secret123456');
});

test('--show-password visibly echoes password input only when explicitly requested', () => {
  const visible = runCliInputTty([
    '--show-password', '--shards', '1', '--workers', '1', '--engine', 'native',
  ], [
    'expect "Username: "', 'send "alice\\r"',
    'expect "Password (VISIBLE): "', 'send "visible-secret-123\\r"',
    'expect "Re-enter password to show recovery words (VISIBLE), or press Enter to exit: "', 'send "\\r"',
  ]);
  const output = visible.stdout.toString();
  expect(visible.exitCode).toBe(0);
  expect(output).toContain('visible password input is ON');
  expect(output).toContain('visible-secret-123');
  expect(output).not.toContain('PRIMARY (24-word)');
});

test('hidden password cannot be recalled into a later visible prompt', () => {
  const secret = 'SYNTHETIC-HISTORY-SECRET-123';
  const passwordMode = runCliInputTty(['--password', '--engine', 'native'], [
    'expect "Username: "', 'send "alice\\r"',
    'expect "Password (hidden; typing works): "', `send "${secret}\\r"`,
    'expect "Level (4): "', 'send "\\033\\[A"', 'after 100', 'send "\\003"',
  ]);
  expect(passwordMode.exitCode).toBe(130);
  expect(passwordMode.stdout.toString()).not.toContain(secret);

  const advanced = runCliInputTty([
    '--ask', '--shards', '1', '--workers', '1', '--engine', 'native',
  ], [
    'expect "Username: "', 'send "alice\\r"',
    'expect "Password (hidden; typing works): "', `send "${secret}\\r"`,
    'expect "Shard multiplier (1): "', 'send "\\033\\[A"', 'after 100', 'send "\\003"',
  ]);
  expect(advanced.exitCode).toBe(130);
  expect(advanced.stdout.toString()).not.toContain(secret);
});

test('--show-password covers repeat and password-manager confirmation explicitly', async () => {
  const repeated = runCliInputTty([
    '--show-password', '--repeat', '--shards', '1', '--workers', '1', '--engine', 'native',
  ], [
    'expect "Username: "', 'send "alice\\r"',
    'expect "Repeat Username: "', 'send "alice\\r"',
    'expect "Password (VISIBLE): "', 'send "visible-secret-123\\r"',
    'expect "Repeat Password (VISIBLE): "', 'send "visible-secret-123\\r"',
    'expect "Re-enter password to show recovery words (VISIBLE), or press Enter to exit: "', 'send "\\r"',
  ]);
  expect(repeated.exitCode).toBe(0);
  expect(repeated.stdout.toString()).toContain('visible-secret-123');

  const suggested = runCliInputTty(['--show-password', '--suggest-password'], [
    'expect "Username: "', 'send "alice\\r"',
    'expect "Generated recovery password"',
    'expect "Repeat generated password (VISIBLE): "', 'send "deliberately-wrong\\r"',
  ]);
  expect(suggested.exitCode).toBe(1);
  const suggestedOutput = suggested.stdout.toString();
  expect(suggestedOutput).toContain('Suggested password was not repeated exactly');
  expect(suggestedOutput).toContain('\x1b[?1049h');
  expect(suggestedOutput).toContain('\x1b[?1049l');
  expect(suggestedOutput.indexOf('\x1b[?1049l')).toBeLessThan(
    suggestedOutput.indexOf('Suggested password was not repeated exactly'),
  );

  const expectedSitePassword = await deriveSitePassword(VECTORS[0]!.expect.masterKey, 'example.com');
  const managed = runCliInputTty(['--password', '--show-password', '--engine', 'native'], [
    'expect "Username: "', 'send "alice\\r"',
    'expect "Password (VISIBLE): "', 'send "secret123456\\r"',
    'expect "Level (4): "', 'send "1\\r"',
    'expect "Re-enter password to enable site-password output (VISIBLE): "', 'send "secret123456\\r"',
    'expect "Domain (hidden; typing works; Enter exits): "', 'send "example.com\\r"',
    'expect "Press Enter to clear and continue: "', 'send "\\r"',
    'expect "Domain (hidden; typing works; Enter exits): "', 'send "\\r"',
  ]);
  const managedOutput = managed.stdout.toString();
  expect(managed.exitCode).toBe(0);
  expect(managedOutput).toContain(expectedSitePassword);
  expect(managedOutput).toContain('\x1b[?1049h');
  expect(managedOutput).toContain('\x1b[?1049l');
  expect(managedOutput.indexOf('\x1b[?1049h')).toBeLessThan(managedOutput.indexOf('example.com'));
});

test('password mode honors inline exact recovery work instead of prompting for a level', async () => {
  const expectedSitePassword = await deriveSitePassword(VECTORS[0]!.expect.masterKey, 'example.com');
  const script = [
    'set timeout 10',
    'set stty_init "rows 24 cols 80"',
    'spawn env TERM=xterm-256color COLUMNS=80 bun cli.ts --password --shards 1 --workers 1 --engine native',
    'expect "Username: "', 'send "alice\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
    'expect {',
    '  "Level (4): " { send "\\003"; expect eof; exit 42 }',
    '  "Re-enter password to enable site-password output (hidden; typing works): " {}',
    '}',
    'send "secret123456\\r"',
    'expect "Domain (hidden; typing works; Enter exits): "', 'send "example.com\\r"',
    'expect "Press Enter to clear and continue: "', 'send "\\r"',
    'expect "Domain (hidden; typing works; Enter exits): "', 'send "\\r"',
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n');
  const result = Bun.spawnSync({
    cmd: ['expect', '-c', script], cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe',
  });
  const output = result.stdout.toString();
  expect(result.exitCode).toBe(0);
  expect(output).not.toContain('Level (4):');
  expect(output).toContain(expectedSitePassword);
});

test('interactive validation failures return a nonzero status', () => {
  const emptyName = runCliInputTty([], [
    'expect "Username: "', 'send "\\r"',
  ]);
  expect(emptyName.exitCode).toBe(1);
  expect(emptyName.stdout.toString()).toContain('Username cannot be empty');
  expect(emptyName.stdout.toString()).not.toContain('Password (hidden; typing works)');

  const emptyPasswordModeName = runCliInputTty(['--password'], [
    'expect "Username: "', 'send "\\r"',
  ]);
  expect(emptyPasswordModeName.exitCode).toBe(1);
  expect(emptyPasswordModeName.stdout.toString()).toContain('Username cannot be empty');
  expect(emptyPasswordModeName.stdout.toString()).not.toContain('BRAINVAULT_ASCII_CREATION_REQUIRED');

  const shortPassword = runCliInputTty([], [
    'expect "Username: "', 'send "alice\\r"',
    'expect "Password (hidden; typing works): "', 'send "short\\r"',
  ]);
  expect(shortPassword.exitCode).toBe(1);
  expect(shortPassword.stdout.toString()).toContain('not a security recommendation');

  const repeatedName = runCliInputTty(['--repeat'], [
    'expect "Username: "', 'send "alice\\r"',
    'expect "Repeat Username: "', 'send "bob\\r"',
  ]);
  expect(repeatedName.exitCode).toBe(1);
  expect(repeatedName.stdout.toString()).toContain('Username entries do not match');

  const repeatedPasswordModeName = runCliInputTty(['--password', '--repeat'], [
    'expect "Username: "', 'send "alice\\r"',
    'expect "Repeat Username: "', 'send "bob\\r"',
  ]);
  expect(repeatedPasswordModeName.exitCode).toBe(1);
  expect(repeatedPasswordModeName.stdout.toString()).toContain('Username entries do not match');

  for (const mode of [[], ['--password']] as const) {
    const emptyRepeatedName = runCliInputTty([...mode, '--repeat'], [
      'expect "Username: "', 'send "\\r"',
      'expect {',
      '  "Username cannot be empty" {}',
      '  "Repeat Username: " { send "not-empty\\r" }',
      '}',
    ]);
    expect(emptyRepeatedName.exitCode).toBe(1);
    expect(emptyRepeatedName.stdout.toString()).toContain('Username cannot be empty');
    expect(emptyRepeatedName.stdout.toString()).not.toContain('Repeat Username:');
  }

  const excessiveWorkers = runCliInputTty(['--shards', '1', '--workers', '2'], [
    'expect "Username: "', 'send "alice\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
  ]);
  expect(excessiveWorkers.exitCode).toBe(1);
  expect(excessiveWorkers.stdout.toString()).toContain('workers exceed the safe hardware limit');
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

  const passwordScript = [
    'set timeout 5',
    'set stty_init "rows 24 cols 80"',
    'spawn env TERM=xterm-256color COLUMNS=80 bun cli.ts --password',
    'expect "Username: "',
    'send "alice\\r"',
    'expect "Password (hidden; typing works): "',
    'send "\\003"',
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n');
  const passwordAbort = Bun.spawnSync({
    cmd: ['expect', '-c', passwordScript], cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe',
  });
  expect(passwordAbort.exitCode).toBe(130);
  expect(passwordAbort.stdout.toString()).toContain('Exited.');
  expect(passwordAbort.stdout.toString()).not.toContain('AbortError');

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

test('known-corrupt same-isolate engine is research-only outside benchmark modes', () => {
  const blocked = runCli(['--shards', '1', '--workers', '1', '--engine', 'native-direct']);
  expect(blocked.exitCode).toBe(1);
  expect(blocked.stderr.toString()).toContain('BRAINVAULT_ENGINE_RESEARCH_ONLY:native-direct');
});

test('CLI advanced menu accepts keyboard navigation and derives the selected level', () => {
  const selected = runAskCliTty();
  const output = selected.stdout.toString();
  expect(selected.exitCode).toBe(0);
  expect(output).toContain('work level (up/down or j/k, Enter confirms)');
  expect(output).toContain('4. standard');
  expect(output).toContain('recommended default');
  expect(output).toContain('1 shards × 1 workers');
  expect(output).toContain('Using native isolated workers (1 workers)');
  expect(publicSummary(output)).toEqual({
    fingerprint: VECTORS[0]!.expect.masterKey.slice(0, 8),
    address: VECTORS[0]!.expect.ethAddr,
  });

  const narrow = runCliInputTty([
    '--ask', '--engine', 'native', '--workers', '1', '--multiplier', '1',
  ], [
    'expect "Username: "', 'send "alice\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
    'expect "work level (up/down or j/k, Enter confirms)"', 'send "kkk\\r"',
    'expect "Re-enter password to show recovery words (hidden; typing works), or press Enter to exit: "',
    'send "\\r"',
  ], 'env COLUMNS=40 NO_COLOR=1 TERM=xterm-256color ');
  expect(narrow.exitCode).toBe(0);
  expect(narrow.stdout.toString()).toContain('1 shards × 1 workers');
});

test('advanced engine menu defaults only the measured M3 Ultra profile to Metal', () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const measuredM3Ultra = totalmem() >= 500 * 1024 ** 3
    && cpus().length === 32
    && cpus().some(cpu => cpu.model.toLowerCase().includes('apple m3'));
  const expectedDefault = measuredM3Ultra
    ? '> 1. Metal V1 + C/NEON hybrid (measured M3 Ultra default)'
    : '> 1. C/NEON final wipe (portable Apple Silicon default)';
  const result = runCliInputTty([
    '--ask', '--shards', '1000', '--workers', '1', '--multiplier', '1',
  ], [
    'expect "Username: "', 'send "engine-menu-audit\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
    `expect "${expectedDefault}"`, 'send "\\003"',
  ], 'env COLUMNS=100 NO_COLOR=1 TERM=xterm-256color ');
  const output = result.stdout.toString();
  expect(output).not.toContain('DERIVING');
  expect(output).toContain(expectedDefault);
  expect(output).not.toContain('(fastest)');
});

test('inline unsafe work levels are visibly marked DO NOT FUND', () => {
  for (const [level, workers] of [[1, 1], [2, 32]] as const) {
    const selected = runCliInputTty([
      '--level', String(level), '--workers', String(workers),
      '--engine', level === 1 ? 'native' : 'c-neon',
    ], [
      'expect "Username: "', 'send "unsafe-level-audit\\r"',
      'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
      'expect "Re-enter password to show recovery words (hidden; typing works), or press Enter to exit: "',
      'send "\\r"',
    ]);
    expect(selected.exitCode).toBe(0);
    expect(selected.stdout.toString()).toContain('DO NOT FUND');
  }
});

test('exact password confirmation reveals sensitive output without a reveal command', () => {
  const revealed = runCliTty([], 'secret123456');
  const output = revealed.stdout.toString();
  expect(revealed.exitCode).toBe(0);
  expect(output).toContain('RECOVERY WORDS · SECRET');
  expect(output.replaceAll(/\s+/g, ' ')).toContain(VECTORS[0]!.expect.mnemonic24);
  expect(output).toContain('\x1b[?1049h');
  expect(output).toContain('\x1b[3J');
  expect(output).toContain('\x1b[?1049l');
  expect(output).toContain('Sensitive view erased.');
});

test('24-row sensitive output pages before the secondary wallet can displace the primary', () => {
  const script = [
    'set timeout 10',
    'set stty_init "rows 24 cols 80"',
    'spawn env TERM=xterm-256color COLUMNS=80 LINES=24 bun cli.ts --shards 1 --workers 1 --engine native',
    'expect "Username: "', 'send "alice\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
    'expect "Re-enter password to show recovery words (hidden; typing works), or press Enter to exit: "',
    'send "secret123456\\r"',
    'expect "Press Enter for the SECONDARY wallet: "', 'send "\\r"',
    'expect "Press Enter to clear and exit: "', 'send "\\r"',
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n');
  const result = Bun.spawnSync({
    cmd: ['expect', '-c', script], cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe',
  });
  const output = result.stdout.toString();
  expect(result.exitCode).toBe(0);
  expect(output.indexOf('PRIMARY WALLET')).toBeLessThan(output.indexOf('Press Enter for the SECONDARY wallet'));
  expect(output.indexOf('Press Enter for the SECONDARY wallet')).toBeLessThan(output.indexOf('SECONDARY WALLET'));
  expect(output).toContain('\x1b[2J\x1b[H');
});

test('input typed during derivation is neither echoed nor accepted as confirmation', () => {
  const result = runCliInputTty([
    '--shards', '100', '--workers', '32', '--engine', 'c-neon',
  ], [
    'expect "Username: "', 'send "typeahead-audit\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
    'expect "DERIVING"', 'send "secret123456\\r"',
    'expect "Re-enter password to show recovery words (hidden; typing works), or press Enter to exit: "',
    'after 100', 'send "\\r"',
  ]);
  const output = result.stdout.toString();
  expect(result.exitCode).toBe(0);
  expect(output).not.toContain('secret123456');
  expect(output).not.toContain('RECOVERY WORDS · SECRET');
});

test('Ctrl+C inside sensitive view erases it and exits the entire CLI', () => {
  const command = ['env', 'TERM=xterm-256color', 'COLUMNS=80', 'bun', 'cli.ts', '--shards', '1', '--workers', '1', '--engine', 'native'].join(' ');
  const script = [
    'set timeout 10',
    'set stty_init "rows 24 cols 80"',
    `spawn ${command}`,
    'expect "Username: "',
    'send "alice\\r"',
    'expect "Password (hidden; typing works): "',
    'send "secret123456\\r"',
    'expect "Re-enter password to show recovery words (hidden; typing works), or press Enter to exit: "',
    'send "secret123456\\r"',
    'expect "Press Enter for the SECONDARY wallet: "',
    'send "\\003"',
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n');
  const result = Bun.spawnSync({
    cmd: ['expect', '-c', script], cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe',
  });
  const output = result.stdout.toString();
  expect(result.exitCode).toBe(130);
  expect(output).toContain('\x1b[?1049h');
  expect(output).toContain('\x1b[3J');
  expect(output).toContain('\x1b[?1049l');
  expect(output).toContain('Exited.');
  expect(output).not.toContain('AbortError');
});

test('SIGTERM and SIGHUP erase the sensitive screen before exiting', () => {
  for (const [signal, exitCode] of [['TERM', 143], ['HUP', 129]] as const) {
    const script = [
      'set timeout 10',
      'set stty_init "rows 24 cols 80"',
      'spawn env TERM=xterm-256color COLUMNS=80 bun cli.ts --shards 1 --workers 1 --engine native',
      'expect "Username: "', 'send "alice\\r"',
      'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
      'expect "Re-enter password to show recovery words (hidden; typing works), or press Enter to exit: "',
      'send "secret123456\\r"',
      'expect "Press Enter for the SECONDARY wallet: "',
      `exec kill -${signal} [exp_pid]`,
      'expect eof',
      'catch wait result',
      'exit [lindex $result 3]',
    ].join('\n');
    const result = Bun.spawnSync({
      cmd: ['expect', '-c', script], cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe',
    });
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(exitCode);
    expect(output).toContain('\x1b[?1049h');
    expect(output).toContain('\x1b[3J');
    expect(output).toContain('\x1b[?1049l');
  }
});

test('SIGTERM and SIGHUP terminate an active native child', () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  for (const signal of ['TERM', 'HUP'] as const) {
    const { result, childAlive } = runSignalDuringNativeDerivation(signal);
    expect(result.stdout.toString()).toContain('NATIVE_ALIVE:');
    expect(childAlive).toBe(false);
  }
}, 30_000);

test('native hang fixture emits the canonical progress protocol', () => {
  expect(readFileSync(`${import.meta.dir}/test-fixtures/native-hang.ts`, 'utf8')).toContain("'BVP1 1\\n'");
});

test('TERM=dumb refuses recovery-word disclosure after a public derivation', () => {
  const script = [
    'set timeout 10',
    'spawn env TERM=dumb NO_COLOR=1 bun cli.ts --shards 1 --workers 1 --engine native',
    'expect "Username: "', 'send "alice\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
    'expect "Recovery words unavailable"',
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n');
  const result = Bun.spawnSync({
    cmd: ['expect', '-c', script], cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).not.toContain(VECTORS[0]!.expect.mnemonic24);

  const passwordMode = runCliInputTty(['--password'], [], 'env TERM=dumb NO_COLOR=1 ');
  expect(passwordMode.exitCode).toBe(1);
  expect(passwordMode.stdout.toString()).toContain('site passwords require alternate-screen support');

  const progress = runCliInputTty([
    '--shards', '100', '--workers', '32', '--engine', 'c-neon',
  ], [
    'expect "Username: "', 'send "dumb-progress-audit\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
    'expect "Recovery words unavailable"',
  ], 'env TERM=dumb NO_COLOR=1 ');
  expect(progress.exitCode).toBe(0);
  expect(progress.stdout.toString()).not.toContain('\x1b[2A');
  expect(progress.stdout.toString()).not.toContain('\x1b[2K');

  const menu = runCliInputTty([
    '--ask', '--engine', 'native', '--workers', '1', '--multiplier', '1',
  ], [
    'expect "Username: "', 'send "dumb-menu-audit\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
    'expect "work level (enter a number; default 4): "', 'send "1\\r"',
    'expect "Recovery words unavailable"',
  ], 'env TERM=dumb NO_COLOR=1 ');
  expect(menu.exitCode).toBe(0);
  expect(menu.stdout.toString()).not.toContain('\x1b[2A');
  expect(menu.stdout.toString()).not.toContain('\x1b[2K');
  expect(menu.stdout.toString()).not.toMatch(/(?:^|\n)1\. 1\./);

  const suggested = runCliInputTty(['--suggest-password'], [
    'expect {',
    '  "suggested passwords require a reliable interactive terminal" {}',
    '  "Username: " { send "alice\\r"; exp_continue }',
    '  "Generated recovery password" { exp_continue }',
    '  "Repeat generated password (hidden; typing works): " { send "wrong-password\\r" }',
    '}',
  ], 'env TERM=dumb NO_COLOR=1 ');
  expect(suggested.exitCode).toBe(1);
  expect(suggested.stdout.toString()).toContain('suggested passwords require a reliable interactive terminal');
  expect(suggested.stdout.toString()).not.toContain('Generated recovery password');
});

test('missing TERM refuses recovery-word disclosure after a public derivation', () => {
  const script = [
    'set timeout 10',
    'spawn env -u TERM NO_COLOR=1 bun cli.ts --shards 1 --workers 1 --engine native',
    'expect "Username: "', 'send "alice\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
    'expect {',
    '  "Recovery words unavailable" {}',
    '  "Re-enter password to show recovery words" { send "\\r" }',
    '}',
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n');
  const result = Bun.spawnSync({
    cmd: ['expect', '-c', script], cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe',
  });
  const output = result.stdout.toString();
  expect(result.exitCode).toBe(0);
  expect(output).toContain('Recovery words unavailable');
  expect(output).not.toContain('Re-enter password to show recovery words');
  expect(output).not.toContain(VECTORS[0]!.expect.mnemonic24);
});

test('sensitive modes reject terminals without trusted alternate-screen geometry', () => {
  for (const [term, columns, rows] of [
    ['vt100', 80, 24],
    ['xterm-256color', 19, 24],
    ['xterm-256color', 80, 9],
    ['xterm-256color', 80, 10],
    ['xterm-256color', 20, 10],
    ['xterm-256color', 0, 0],
  ] as const) {
    const result = runSensitivePreflight(term, columns, rows);
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(output).toContain('site passwords require alternate-screen support');
    expect(output).not.toContain('Username:');
  }

  const suggested = runSensitivePreflight('xterm-256color', 20, 10, ['--suggest-password']);
  expect(suggested.exitCode).toBe(1);
  expect(suggested.stdout.toString()).toContain('suggested passwords require a reliable interactive terminal');
  expect(suggested.stdout.toString()).not.toContain('Username:');
});

test('a short terminal keeps public recovery usable but refuses the private view', () => {
  const result = runCliInputTty([
    '--shards', '1', '--workers', '1', '--engine', 'native',
  ], [
    'expect "Username: "', 'send "alice\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
    'expect {',
    '  "Recovery words unavailable" {}',
    '  "Re-enter password to show recovery words" { send "secret123456\\r" }',
    '}',
  ], 'env TERM=xterm-256color COLUMNS=80 LINES=10 NO_COLOR=1 ');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('Recovery words unavailable');
  expect(result.stdout.toString()).not.toContain('BRAINVAULT_SENSITIVE_TERMINAL_TOO_SHORT');
});

test('wrong reveal confirmation fails closed without a runtime stack trace', () => {
  const rejected = runCliTty([], 'wrong-password');
  const output = rejected.stdout.toString();
  expect(rejected.exitCode).toBe(1);
  expect(output).toContain('Password did not match. Nothing was revealed.');
  expect(output).not.toContain(VECTORS[0]!.expect.mnemonic24);
  expect(output).not.toContain('BRAINVAULT_REHEARSAL_MISMATCH');
  expect(output).not.toContain('cli.ts:');
});

test('derivation failures print one safe line without Bun code frames or paths', () => {
  const rejected = runCliInputTty([
    '--shards', '1', '--workers', '1', '--multiplier', '2', '--engine', 'metal',
  ], [
    'expect "Username: "', 'send "alice\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
  ]);
  const output = rejected.stdout.toString();
  expect(rejected.exitCode).toBe(1);
  expect(output).toContain('Derivation failed: BRAINVAULT_ENGINE_MULTIPLIER_UNSUPPORTED');
  expect(output).not.toContain('cli.ts:');
  expect(output).not.toContain('throw new Error');

  const missingWorker = runMissingNativeWorkerCliTty();
  const missingOutput = missingWorker.stdout.toString() + missingWorker.stderr.toString();
  expect(missingWorker.exitCode).toBe(1);
  expect(missingOutput).toContain('Derivation failed: BRAINVAULT_DERIVATION_FAILED');
  expect(missingOutput).not.toContain('/private/');
  expect(missingOutput).not.toContain('worker-native.ts');
});

test('native progress animates, completes exactly, and respects NO_COLOR', () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const colored = runAnimatedCliTty(false);
  const coloredOutput = colored.stdout.toString();
  expect(colored.exitCode).toBe(0);
  expect(coloredOutput).toContain('◇ DERIVING');
  expect(coloredOutput).toContain('shards/s  ·  ETA ');
  expect(coloredOutput).toMatch(/(?:[1-9]|[1-9][0-9])%.*[1-9][0-9]* \/ 100 shards/s);
  expect(coloredOutput).toContain('100 / 100 shards  ·  32 workers');
  expect(coloredOutput).toContain('\x1b[38;5;45m');

  const plain = runAnimatedCliTty(true);
  const plainOutput = plain.stdout.toString();
  expect(plain.exitCode).toBe(0);
  expect(plainOutput).toContain('◇ DERIVING');
  expect(plainOutput).toContain('shards/s  ·  ETA ');
  expect(plainOutput).toMatch(/(?:[1-9]|[1-9][0-9])%.*[1-9][0-9]* \/ 100 shards/s);
  expect(plainOutput).toContain('100 / 100 shards  ·  32 workers');
  expect(plainOutput).not.toContain('\x1b[38;5;45m');

  const edge = runAnimatedCliTty(true, 72);
  expect(edge.exitCode).toBe(0);
  const edgeRows = edge.stdout.toString()
    .replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/[\r\n]+/)
    .filter(line => line.includes('shards/s'));
  expect(edgeRows.length).toBeGreaterThan(0);
  for (const row of edgeRows) expect(row.length).toBeLessThanOrEqual(72);

  const narrow = runCliInputTty([
    '--shards', '100', '--workers', '32', '--engine', 'c-neon',
  ], [
    'expect "Username: "', 'send "narrow-audit\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
    'expect "Re-enter password to show recovery words (hidden; typing works), or press Enter to exit: "',
    'send "\\r"',
  ], 'env COLUMNS=40 NO_COLOR=1 TERM=xterm-256color ');
  expect(narrow.exitCode).toBe(0);
  expect(narrow.stdout.toString()).toContain('100/100');
  expect(narrow.stdout.toString()).not.toContain('shards/s');

  const ultraNarrow = runCliInputTty([
    '--shards', '100', '--workers', '32', '--engine', 'c-neon',
  ], [
    'expect "Username: "', 'send "ultra-narrow-audit\\r"',
    'expect "Password (hidden; typing works): "', 'send "secret123456\\r"',
    'expect "Re-enter password to show recovery words (hidden; typing works), or press Enter to exit: "',
    'send "\\r"',
  ], 'env COLUMNS=20 NO_COLOR=1 TERM=xterm-256color ');
  expect(ultraNarrow.exitCode).toBe(0);
  const visibleFrames = ultraNarrow.stdout.toString()
    .replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/[\r\n]+/)
    .filter(line => line.includes('%'));
  expect(visibleFrames.length).toBeGreaterThan(0);
  for (const frame of visibleFrames) expect(frame.length).toBeLessThanOrEqual(20);
}, 30_000);

test('a broken accelerator fails loudly instead of switching engines', () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64'
    || totalmem() < 500 * 1024 ** 3 || cpus().length !== 32
    || !cpus().some(cpu => cpu.model.toLowerCase().includes('apple m3'))) return;
  const broken = runBrokenAcceleratorCliTty();
  const output = broken.stdout.toString() + broken.stderr.toString();
  expect(broken.exitCode).not.toBe(0);
  expect(output).toContain('Derivation failed: BRAINVAULT_ACCELERATOR_CHILD_FAILED');
  expect(output).not.toContain('using C/NEON backend');
  expect(output).not.toContain('│ Engine used:');
}, 30_000);

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
  expect(launched.stdout.toString()).toContain('bun ./brainvault');
  expect(launched.stdout.toString()).not.toContain('bun run bv');
  expect(launched.stdout.toString()).toContain('Leave the optional BIP-39 passphrase empty');
  expect(launched.stdout.toString()).toContain('Never enter your BrainVault password into that field');
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
    const output = child.stdout.toString().match(/(?:Root parity|Frozen root check): PASS \(([0-9a-f]{64})\)/)?.[1];
    expect(output).toBeDefined();
    expected ??= output;
    expect(output).toBe(expected);
  }
}, 20_000);

console.log('✅ All deterministic tests passed');
console.log('These vectors define wallet compatibility - never change them!');
