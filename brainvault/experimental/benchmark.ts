#!/usr/bin/env bun

import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { hashRaw as argon2Native } from '@node-rs/argon2';
import {
  bytesToHex,
  combineShardsWithParams,
  factorForShardCount,
  hexToBytes,
} from '../core.ts';
import { BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID, createShardSalt } from '../primitives/spec.ts';
import { verifyBundledExecutable } from '../binary-integrity.ts';

type Backend = 'baseline' | 'sync' | 'wasm' | 'direct-async' | 'c-neon' | 'c-neon-wipe' | 'rust-pool' | 'rust-pool-no-wipe';

const readFlag = (name: string, fallback: string): string => {
  const prefix = `--${name}=`;
  return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};

const backend = readFlag('backend', 'baseline') as Backend;
const shardCount = Number(readFlag('shards', '1000'));
const requestedWorkers = Number(readFlag('workers', '8'));
const multiplier = Number(readFlag('multiplier', '1'));
if (process.argv.some(argument => argument.startsWith('--name=') || argument.startsWith('--passphrase='))) {
  throw new Error('BRAINVAULT_BENCHMARK_SECRET_ARGV_FORBIDDEN');
}
const name = 'benchmark-user';
const passphrase = 'benchmark-password';

if (!['baseline', 'sync', 'wasm', 'direct-async', 'c-neon', 'c-neon-wipe', 'rust-pool', 'rust-pool-no-wipe'].includes(backend)) {
  throw new Error(`Unknown backend: ${backend}`);
}
if (!Number.isSafeInteger(shardCount) || shardCount < 1) throw new Error(`Invalid shard count: ${shardCount}`);
if (!Number.isSafeInteger(requestedWorkers) || requestedWorkers < 1 || requestedWorkers > 32) {
  throw new Error(`Workers must be an integer in 1..32: ${requestedWorkers}`);
}
if (!Number.isSafeInteger(multiplier) || multiplier < 1) {
  throw new Error(`Multiplier must be a positive integer: ${multiplier}`);
}

const workers = Math.min(requestedWorkers, shardCount);
const factor = factorForShardCount(shardCount);
const shardMemoryKb = BRAINVAULT_V1.SHARD_MEMORY_KB * multiplier;
const kdfAlgId = multiplier === 1 ? BRAINVAULT_V1.ALG_ID : `${BRAINVAULT_V1.ALG_ID}|custom`;
const startedAt = performance.now();

if (backend === 'direct-async') {
  const password = new TextEncoder().encode(passphrase.normalize('NFKD'));
  const directShards = new Array<Uint8Array>(shardCount);
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = next++;
      if (index >= shardCount) return;
      const salt = await createShardSalt(name, index, shardCount, kdfAlgId);
      directShards[index] = new Uint8Array(await argon2Native(password, {
        salt,
        memoryCost: shardMemoryKb,
        timeCost: BRAINVAULT_V1.ARGON_TIME_COST,
        parallelism: BRAINVAULT_V1.ARGON_PARALLELISM,
        outputLen: BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
        algorithm: 2,
        version: 1,
      }));
    }
  }));
  password.fill(0);
  const derivationTimeMs = performance.now() - startedAt;
  const root = await combineShardsWithParams(directShards, factor, { algId: kdfAlgId, shardMemoryKb });
  const totalTimeMs = performance.now() - startedAt;
  console.log(JSON.stringify({
    backend,
    specId: BRAINVAULT_V1_SPEC_ID,
    shardCount,
    factor,
    workers,
    memoryKiBPerShard: shardMemoryKb,
    multiplier,
    derivationTimeMs: Number(derivationTimeMs.toFixed(3)),
    totalTimeMs: Number(totalTimeMs.toFixed(3)),
    shardsPerSecond: Number((shardCount / (derivationTimeMs / 1000)).toFixed(3)),
    root: bytesToHex(root),
  }, null, 2));
  root.fill(0);
  for (const shard of directShards) shard.fill(0);
  process.exit(0);
}

if (backend === 'c-neon' || backend === 'c-neon-wipe' || backend === 'rust-pool' || backend === 'rust-pool-no-wipe') {
  const password = new TextEncoder().encode(passphrase.normalize('NFKD'));
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0x32435642, 0);
  header.writeUInt32LE(shardCount, 4);
  header.writeUInt32LE(workers, 8);
  header.writeUInt32LE(password.length, 12);
  header.writeUInt32LE(backend === 'c-neon-wipe' ? 1 : 0, 16);
  header.writeUInt32LE(shardMemoryKb, 20);
  const input = Buffer.alloc(header.length + password.length + (shardCount * 32));
  header.copy(input, 0);
  input.set(password, header.length);
  for (let index = 0; index < shardCount; index += 1) {
    input.set(await createShardSalt(name, index, shardCount, kdfAlgId), header.length + password.length + (index * 32));
  }
  const isAppleM3 = cpus().some(cpu => cpu.model.toLowerCase().includes('apple m3'));
  const cExecutable = process.platform === 'darwin' && process.arch === 'arm64'
    ? [
      ...(isAppleM3 ? [`${import.meta.dir}/../prebuilds/darwin-arm64/brainvault-argon2-m3`] : []),
      `${import.meta.dir}/../prebuilds/darwin-arm64/brainvault-argon2`,
      `${import.meta.dir}/argon2-c/brainvault-argon2`,
    ].find(candidate => existsSync(candidate))
    : undefined;
  const rustPrebuilds = process.platform === 'darwin' && process.arch === 'arm64';
  const executable = backend === 'c-neon' || backend === 'c-neon-wipe'
    ? cExecutable
    : backend === 'rust-pool'
      ? [
        ...(rustPrebuilds ? [`${import.meta.dir}/../prebuilds/darwin-arm64/brainvault-argon2-rust`] : []),
        `${import.meta.dir}/argon2-rust/target/release/brainvault-argon2-rust`,
      ].find(candidate => existsSync(candidate))
      : [
        ...(rustPrebuilds ? [`${import.meta.dir}/../prebuilds/darwin-arm64/brainvault-argon2-rust-no-wipe`] : []),
        `${import.meta.dir}/argon2-rust/target-no-wipe/release/brainvault-argon2-rust`,
      ].find(candidate => existsSync(candidate));
  if (executable === undefined) throw new Error(`Backend executable unavailable: ${backend}`);
  verifyBundledExecutable(executable, `${import.meta.dir}/..`);
  const native = spawnSync(executable, [], {
    input,
    maxBuffer: Math.max(1024 * 1024, shardCount * 64),
  });
  password.fill(0);
  input.fill(0);
  if (native.status !== 0) throw new Error(`C backend failed (${native.status}): ${native.stderr.toString()}`);
  if (native.stdout.length !== shardCount * 32) {
    throw new Error(`C backend returned ${native.stdout.length} bytes, expected ${shardCount * 32}`);
  }
  const derivationTimeMs = performance.now() - startedAt;
  const nativeShards = Array.from({ length: shardCount }, (_, index) =>
    new Uint8Array(native.stdout.subarray(index * 32, (index + 1) * 32)));
  const root = await combineShardsWithParams(nativeShards, factor, { algId: kdfAlgId, shardMemoryKb });
  const totalTimeMs = performance.now() - startedAt;
  console.log(JSON.stringify({
    backend,
    specId: BRAINVAULT_V1_SPEC_ID,
    shardCount,
    factor,
    workers,
    memoryKiBPerShard: shardMemoryKb,
    multiplier,
    derivationTimeMs: Number(derivationTimeMs.toFixed(3)),
    totalTimeMs: Number(totalTimeMs.toFixed(3)),
    shardsPerSecond: Number((shardCount / (derivationTimeMs / 1000)).toFixed(3)),
    root: bytesToHex(root),
  }, null, 2));
  root.fill(0);
  for (const shard of nativeShards) shard.fill(0);
  process.exit(0);
}

const workerPath = backend === 'baseline'
  ? `${import.meta.dir}/../worker-native.ts`
  : backend === 'wasm'
    ? `${import.meta.dir}/../worker-wasm.ts`
    : `${import.meta.dir}/worker-sync.ts`;
const shards = new Array<Uint8Array>(shardCount);
const pool: Worker[] = [];
let nextShard = 0;
let completed = 0;

await new Promise<void>((resolve, reject) => {
  let settled = false;
  const terminate = (): Promise<void> => Promise.all(pool.map(worker => worker.terminate())).then(() => undefined);
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    const cause = error instanceof Error ? error : new Error(String(error));
    void terminate().then(() => reject(cause), terminationError => {
      reject(new AggregateError([cause, terminationError], 'Benchmark worker failure'));
    });
  };
  const dispatch = (worker: Worker): void => {
    if (nextShard >= shardCount) return;
    worker.postMessage({
      specId: BRAINVAULT_V1_SPEC_ID,
      name,
      passphrase,
      shardIndex: nextShard++,
      shardCount,
      shardMemoryKb,
      algId: kdfAlgId,
    });
  };

  for (let index = 0; index < workers; index += 1) {
    const worker = new Worker(workerPath);
    pool.push(worker);
    worker.on('error', fail);
    worker.on('exit', code => {
      if (!settled && completed < shardCount) fail(new Error(`Worker exited early: ${code}`));
    });
    worker.on('message', (message: unknown) => {
      if (settled) return;
      const record = message as { specId?: unknown; shardIndex?: unknown; result?: unknown };
      if (record.specId !== BRAINVAULT_V1_SPEC_ID) return fail(new Error('Worker spec mismatch'));
      if (!Number.isSafeInteger(record.shardIndex)) return fail(new Error('Invalid worker shard index'));
      const shardIndex = Number(record.shardIndex);
      if (shardIndex < 0 || shardIndex >= shardCount || shards[shardIndex] !== undefined) {
        return fail(new Error(`Invalid or duplicate shard: ${shardIndex}`));
      }
      if (typeof record.result !== 'string' || record.result.length !== BRAINVAULT_V1.SHARD_OUTPUT_BYTES * 2) {
        return fail(new Error(`Invalid shard result: ${shardIndex}`));
      }
      shards[shardIndex] = hexToBytes(record.result);
      completed += 1;
      if (completed === shardCount) {
        settled = true;
        void terminate().then(resolve, reject);
      } else {
        dispatch(worker);
      }
    });
    dispatch(worker);
  }
});

const derivationTimeMs = performance.now() - startedAt;
const root = await combineShardsWithParams(shards, factor, { algId: kdfAlgId, shardMemoryKb });
const totalTimeMs = performance.now() - startedAt;

console.log(JSON.stringify({
  backend,
  specId: BRAINVAULT_V1_SPEC_ID,
  shardCount,
  factor,
  workers,
  memoryKiBPerShard: shardMemoryKb,
  multiplier,
  derivationTimeMs: Number(derivationTimeMs.toFixed(3)),
  totalTimeMs: Number(totalTimeMs.toFixed(3)),
  shardsPerSecond: Number((shardCount / (derivationTimeMs / 1000)).toFixed(3)),
  root: bytesToHex(root),
}, null, 2));

root.fill(0);
for (const shard of shards) shard.fill(0);
