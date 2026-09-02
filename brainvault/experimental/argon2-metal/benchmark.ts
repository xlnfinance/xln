#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { combineShardsWithParams, bytesToHex, factorForShardCount } from '../../core.ts';
import { BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID, createShardSalt } from '../../primitives/spec.ts';

type Mode = 'cpu' | 'metal' | 'hybrid' | 'parity';

const args = process.argv.slice(2);
const allowed = ['--mode=', '--shards=', '--cpu-workers=', '--metal-workers=', '--gpu-shards='];
if (args.some(value => !allowed.some(prefix => value.startsWith(prefix)) || value.endsWith('='))) {
  throw new Error('BRAINVAULT_METAL_BENCHMARK_ARGV_INVALID');
}

function flag(name: string, fallback: string): string {
  return args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}

function integerFlag(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(flag(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`BRAINVAULT_METAL_BENCHMARK_${name.toUpperCase().replaceAll('-', '_')}_INVALID:${String(value)}`);
  }
  return value;
}

const mode = flag('mode', 'hybrid') as Mode;
if (!['cpu', 'metal', 'hybrid', 'parity'].includes(mode)) throw new Error(`BRAINVAULT_METAL_MODE_INVALID:${mode}`);
const explicitShards = args.some(value => value.startsWith('--shards='));
const shardCount = integerFlag('shards', mode === 'parity' && !explicitShards ? 2 : 1_000, 1, 1_000_000);
const cpuWorkers = integerFlag('cpu-workers', 36, 1, 64);
const metalWorkers = integerFlag('metal-workers', 256, 1, 256);
const defaultGpuShards = Math.min(shardCount - 1, Math.round(shardCount * 0.2));
const gpuShards = integerFlag('gpu-shards', Math.max(0, defaultGpuShards), 0, shardCount);

const cpuExecutable = `${import.meta.dir}/../argon2-c/brainvault-argon2-oversubscribed`;
const metalExecutable = `${import.meta.dir}/brainvault-argon2-metal`;
if ((mode === 'cpu' || mode === 'hybrid' || mode === 'parity') && !existsSync(cpuExecutable)) {
  throw new Error('BRAINVAULT_METAL_CPU_EXECUTABLE_MISSING:run make -C ../argon2-c oversubscribed');
}
if ((mode === 'metal' || mode === 'hybrid' || mode === 'parity') && !existsSync(metalExecutable)) {
  throw new Error('BRAINVAULT_METAL_EXECUTABLE_MISSING:run make first');
}

const password = new TextEncoder().encode('benchmark-password');
const salts = await Promise.all(Array.from(
  { length: shardCount },
  (_, index) => createShardSalt('benchmark-user', index, shardCount, BRAINVAULT_V1.ALG_ID),
));

function makeInput(first: number, count: number, workers: number): Buffer {
  const input = Buffer.alloc(24 + password.length + (count * 32));
  input.writeUInt32LE(0x32435642, 0);
  input.writeUInt32LE(count, 4);
  input.writeUInt32LE(Math.min(workers, count), 8);
  input.writeUInt32LE(password.length, 12);
  input.writeUInt32LE(0, 16);
  input.writeUInt32LE(BRAINVAULT_V1.SHARD_MEMORY_KB, 20);
  input.set(password, 24);
  for (let offset = 0; offset < count; offset += 1) {
    input.set(salts[first + offset]!, 24 + password.length + (offset * 32));
  }
  return input;
}

type Run = Readonly<{ output: Buffer; timeMs: number }>;

async function runExecutable(executable: string, input: Buffer, environment: Record<string, string> = {}): Promise<Run> {
  const started = performance.now();
  const child = Bun.spawn([executable], {
    env: { ...process.env, ...environment },
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
  const timeMs = performance.now() - started;
  if (exitCode !== 0) throw new Error(`BRAINVAULT_METAL_CHILD_FAILED:${exitCode}:${stderr.trim()}`);
  const output = Buffer.from(stdout);
  const expected = input.readUInt32LE(4) * BRAINVAULT_V1.SHARD_OUTPUT_BYTES;
  if (output.length !== expected) throw new Error(`BRAINVAULT_METAL_OUTPUT_INVALID:${output.length}:${expected}`);
  return { output, timeMs };
}

async function rootFor(output: Buffer): Promise<string> {
  const shards = Array.from({ length: shardCount }, (_, index) =>
    new Uint8Array(output.subarray(index * 32, (index + 1) * 32)));
  try {
    const root = await combineShardsWithParams(shards, factorForShardCount(shardCount), {
      algId: BRAINVAULT_V1.ALG_ID,
      shardMemoryKb: BRAINVAULT_V1.SHARD_MEMORY_KB,
    });
    try {
      return bytesToHex(root);
    } finally {
      root.fill(0);
    }
  } finally {
    for (const shard of shards) shard.fill(0);
  }
}

let output: Buffer;
let timeMs: number;
let rawParity: boolean | undefined;

if (mode === 'parity') {
  const cpuInput = makeInput(0, shardCount, cpuWorkers);
  const metalInput = makeInput(0, shardCount, metalWorkers);
  try {
    const [cpu, metal] = await Promise.all([
      runExecutable(cpuExecutable, cpuInput),
      runExecutable(metalExecutable, metalInput, { BRAINVAULT_METAL_SIMDGROUPS: '4' }),
    ]);
    rawParity = Buffer.compare(cpu.output, metal.output) === 0;
    if (!rawParity) throw new Error('BRAINVAULT_METAL_RAW_PARITY_FAILED');
    output = metal.output;
    timeMs = metal.timeMs;
    cpu.output.fill(0);
  } finally {
    cpuInput.fill(0);
    metalInput.fill(0);
  }
} else if (mode === 'hybrid') {
  if (gpuShards === 0 || gpuShards === shardCount) throw new Error('BRAINVAULT_METAL_HYBRID_SPLIT_INVALID');
  const cpuCount = shardCount - gpuShards;
  const cpuInput = makeInput(0, cpuCount, cpuWorkers);
  const metalInput = makeInput(cpuCount, gpuShards, metalWorkers);
  const started = performance.now();
  try {
    const [cpu, metal] = await Promise.all([
      runExecutable(cpuExecutable, cpuInput),
      runExecutable(metalExecutable, metalInput, { BRAINVAULT_METAL_SIMDGROUPS: '4' }),
    ]);
    output = Buffer.concat([cpu.output, metal.output]);
    timeMs = performance.now() - started;
    cpu.output.fill(0);
    metal.output.fill(0);
  } finally {
    cpuInput.fill(0);
    metalInput.fill(0);
  }
} else {
  const input = makeInput(0, shardCount, mode === 'cpu' ? cpuWorkers : metalWorkers);
  try {
    const run = await runExecutable(
      mode === 'cpu' ? cpuExecutable : metalExecutable,
      input,
      mode === 'metal' ? { BRAINVAULT_METAL_SIMDGROUPS: '4' } : {},
    );
    output = run.output;
    timeMs = run.timeMs;
  } finally {
    input.fill(0);
  }
}

try {
  const root = await rootFor(output!);
  console.log(JSON.stringify({
    mode,
    specId: BRAINVAULT_V1_SPEC_ID,
    shardCount,
    cpuWorkers,
    metalWorkers,
    gpuShards: mode === 'hybrid' ? gpuShards : undefined,
    timeMs: Number(timeMs!.toFixed(3)),
    shardsPerSecond: Number((shardCount / (timeMs! / 1_000)).toFixed(3)),
    rawParity,
    root,
  }, null, 2));
} finally {
  output!.fill(0);
  password.fill(0);
}
