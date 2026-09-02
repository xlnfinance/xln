#!/usr/bin/env bun

import { bytesToHex, combineShardsWithParams, factorForShardCount } from '../../core.ts';
import { BRAINVAULT_V1, createShardSalt } from '../../primitives/spec.ts';

const shardCount = 1_000;
const gpuCount = Number(process.argv[2] ?? '496');
const batch = Number(process.argv[3] ?? '248');
const cpuWorkers = Number(process.argv[4] ?? '30');
const jobsPerBlock = Number(process.argv[5] ?? '1');
if (!Number.isSafeInteger(gpuCount) || gpuCount < 1 || gpuCount >= shardCount) throw new Error('GPU_COUNT_INVALID');
if (!Number.isSafeInteger(batch) || batch < 1 || batch > 344) throw new Error('BATCH_INVALID');
if (!Number.isSafeInteger(cpuWorkers) || cpuWorkers < 1 || cpuWorkers > 64) throw new Error('CPU_WORKERS_INVALID');
if (![1, 2, 4, 8].includes(jobsPerBlock) || batch % jobsPerBlock !== 0) throw new Error('JOBS_PER_BLOCK_INVALID');

const password = new TextEncoder().encode('benchmark-password');
const salts = await Promise.all(Array.from(
  { length: shardCount },
  (_, index) => createShardSalt('benchmark-user', index, shardCount, BRAINVAULT_V1.ALG_ID),
));

function inputFor(first: number, count: number, workers: number): Buffer {
  const input = Buffer.alloc(24 + password.length + (count * 32));
  input.writeUInt32LE(0x32435642, 0);
  input.writeUInt32LE(count, 4);
  input.writeUInt32LE(Math.min(workers, count), 8);
  input.writeUInt32LE(password.length, 12);
  input.writeUInt32LE(0, 16);
  input.writeUInt32LE(BRAINVAULT_V1.SHARD_MEMORY_KB, 20);
  input.set(password, 24);
  for (let index = 0; index < count; index += 1) {
    input.set(salts[first + index]!, 24 + password.length + (index * 32));
  }
  return input;
}

type RunResult = Readonly<{ output: Buffer; timeMs: number }>;

async function run(executable: string, input: Buffer, env: Record<string, string> = {}): Promise<RunResult> {
  const started = performance.now();
  const child = Bun.spawn([executable], {
    env: { ...process.env, ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(input);
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = Buffer.from(stdout);
  if (exitCode !== 0) {
    output.fill(0);
    throw new Error(`${executable}:${exitCode}:${stderr.trim()}`);
  }
  return { output, timeMs: performance.now() - started };
}

const cpuCount = shardCount - gpuCount;
let cpuInput: Buffer | undefined;
let gpuInput: Buffer | undefined;
let cpuOutput: Buffer | undefined;
let gpuOutput: Buffer | undefined;
let output: Buffer | undefined;
let shards: Uint8Array[] = [];
let root: Uint8Array | undefined;
try {
  cpuInput = inputFor(0, cpuCount, cpuWorkers);
  gpuInput = inputFor(cpuCount, gpuCount, gpuCount);
  const started = performance.now();
  const [cpuSettled, gpuSettled] = await Promise.allSettled([
    run('../argon2-c/brainvault-argon2-oversubscribed', cpuInput),
    run('./brainvault-argon2-opencl', gpuInput, {
      BRAINVAULT_OPENCL_BATCH: String(batch),
      BRAINVAULT_OPENCL_JOBS_PER_BLOCK: String(jobsPerBlock),
    }),
  ]);
  const timeMs = performance.now() - started;
  if (cpuSettled.status === 'rejected' || gpuSettled.status === 'rejected') {
    if (cpuSettled.status === 'fulfilled') cpuSettled.value.output.fill(0);
    if (gpuSettled.status === 'fulfilled') gpuSettled.value.output.fill(0);
    throw cpuSettled.status === 'rejected' ? cpuSettled.reason : gpuSettled.reason;
  }
  cpuOutput = cpuSettled.value.output;
  gpuOutput = gpuSettled.value.output;
  output = Buffer.concat([cpuOutput, gpuOutput]);

  shards = Array.from({ length: shardCount }, (_, index) =>
    new Uint8Array(output!.subarray(index * 32, (index + 1) * 32)));
  root = await combineShardsWithParams(shards, factorForShardCount(shardCount), {
    algId: BRAINVAULT_V1.ALG_ID,
    shardMemoryKb: BRAINVAULT_V1.SHARD_MEMORY_KB,
  });
  const rootHex = bytesToHex(root);
  const expected = 'dc2090d65af300c74384ca36adf16ff993c43f4947ee9a0f09e8055f009c3485';
  console.log(JSON.stringify({
    gpuCount,
    cpuCount,
    batch,
    cpuWorkers,
    jobsPerBlock,
    cpuMs: Number(cpuSettled.value.timeMs.toFixed(3)),
    gpuMs: Number(gpuSettled.value.timeMs.toFixed(3)),
    tailDeltaMs: Number((cpuSettled.value.timeMs - gpuSettled.value.timeMs).toFixed(3)),
    timeMs: Number(timeMs.toFixed(3)),
    shardsPerSecond: Number((shardCount / (timeMs / 1_000)).toFixed(3)),
    rootParity: rootHex === expected,
    root: rootHex,
  }, null, 2));
  if (rootHex !== expected) process.exitCode = 1;
} finally {
  root?.fill(0);
  for (const shard of shards) shard.fill(0);
  cpuInput?.fill(0);
  gpuInput?.fill(0);
  cpuOutput?.fill(0);
  gpuOutput?.fill(0);
  output?.fill(0);
  password.fill(0);
  for (const salt of salts) salt.fill(0);
}
