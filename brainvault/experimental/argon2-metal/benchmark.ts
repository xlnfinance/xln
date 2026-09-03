#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { combineShardsWithParams, bytesToHex, factorForShardCount } from '../../core.ts';
import { BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID, createShardSalt } from '../../primitives/spec.ts';

type Mode = 'cpu' | 'metal' | 'hybrid' | 'parity';

const args = process.argv.slice(2);
const allowed = [
  '--mode=',
  '--shards=',
  '--cpu-workers=',
  '--metal-workers=',
  '--gpu-shards=',
  '--simdgroups=',
  '--kernel=',
  '--memory=',
  '--metal-processes=',
];
if (args.some(value => !allowed.some(prefix => value.startsWith(prefix)) || value.endsWith('='))) {
  throw new Error('BRAINVAULT_METAL_BENCHMARK_ARGV_INVALID');
}

function flag(name: string, defaultValue: string): string {
  return args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? defaultValue;
}

function integerFlag(name: string, defaultValue: number, minimum: number, maximum: number): number {
  const value = Number(flag(name, String(defaultValue)));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`BRAINVAULT_METAL_BENCHMARK_${name.toUpperCase().replaceAll('-', '_')}_INVALID:${String(value)}`);
  }
  return value;
}

const mode = flag('mode', 'hybrid') as Mode;
if (!['cpu', 'metal', 'hybrid', 'parity'].includes(mode)) throw new Error(`BRAINVAULT_METAL_MODE_INVALID:${mode}`);
const explicitShards = args.some(value => value.startsWith('--shards='));
const shardCount = integerFlag('shards', mode === 'parity' && !explicitShards ? 2 : 1_000, 1, 1_000_000);
const cpuWorkers = integerFlag('cpu-workers', 32, 1, 64);
const metalWorkers = integerFlag('metal-workers', 40, 1, 256);
const metalProcesses = integerFlag('metal-processes', 8, 1, 16);
const simdgroups = integerFlag('simdgroups', 4, 1, 8);
if (![1, 2, 4, 8].includes(simdgroups)) throw new Error(`BRAINVAULT_METAL_SIMDGROUPS_INVALID:${simdgroups}`);
const kernel = flag('kernel', 'v1special');
if (!['shuffle', 'native64', 'segmented64', 'modern64', 'v1special', 'barrier'].includes(kernel)) {
  throw new Error(`BRAINVAULT_METAL_KERNEL_INVALID:${kernel}`);
}
if ((kernel === 'modern64' || kernel === 'v1special' || kernel === 'segmented64') && simdgroups > 4) {
  throw new Error('BRAINVAULT_METAL_SEGMENTED_SIMDGROUPS_INVALID');
}
const memory = flag('memory', 'private');
if (!['shared', 'private'].includes(memory)) throw new Error(`BRAINVAULT_METAL_MEMORY_INVALID:${memory}`);
const defaultGpuFraction = shardCount === 10_000 ? 0.80 : 0.64;
const defaultGpuShards = Math.min(shardCount - 1, Math.round(shardCount * defaultGpuFraction));
const gpuShards = integerFlag('gpu-shards', Math.max(0, defaultGpuShards), 0, shardCount);

const cpuExecutable = [
  ...(cpus().some(cpu => cpu.model.toLowerCase().includes('apple m3'))
    ? [`${import.meta.dir}/../../prebuilds/darwin-arm64/brainvault-argon2-m3`]
    : []),
  `${import.meta.dir}/../../prebuilds/darwin-arm64/brainvault-argon2`,
  `${import.meta.dir}/../argon2-c/brainvault-argon2-oversubscribed`,
].find(candidate => existsSync(candidate)) ?? `${import.meta.dir}/../argon2-c/brainvault-argon2-oversubscribed`;
const metalExecutable = [
  `${import.meta.dir}/../../prebuilds/darwin-arm64/brainvault-argon2-metal`,
  `${import.meta.dir}/brainvault-argon2-metal`,
].find(candidate => existsSync(candidate)) ?? `${import.meta.dir}/brainvault-argon2-metal`;
if ((mode === 'cpu' || mode === 'hybrid' || mode === 'parity') && !existsSync(cpuExecutable)) {
  throw new Error('BRAINVAULT_METAL_CPU_EXECUTABLE_MISSING:run make -C ../argon2-c oversubscribed');
}
if ((mode === 'metal' || mode === 'hybrid' || mode === 'parity') && !existsSync(metalExecutable)) {
  throw new Error('BRAINVAULT_METAL_EXECUTABLE_MISSING:run make first');
}

const password = new TextEncoder().encode('benchmark-password');
const salts = await Promise.all(
  Array.from({ length: shardCount }, (_, index) =>
    createShardSalt('benchmark-user', index, shardCount, BRAINVAULT_V1.ALG_ID),
  ),
);

function makeInput(first: number, count: number, workers: number): Buffer {
  const input = Buffer.alloc(24 + password.length + count * 32);
  input.writeUInt32LE(0x32435642, 0);
  input.writeUInt32LE(count, 4);
  input.writeUInt32LE(Math.min(workers, count), 8);
  input.writeUInt32LE(password.length, 12);
  input.writeUInt32LE(0, 16);
  input.writeUInt32LE(BRAINVAULT_V1.SHARD_MEMORY_KB, 20);
  input.set(password, 24);
  for (let offset = 0; offset < count; offset += 1) {
    input.set(salts[first + offset]!, 24 + password.length + offset * 32);
  }
  return input;
}

type Run = Readonly<{ output: Buffer; timeMs: number; profile?: string }>;

const metalEnvironment = {
  BRAINVAULT_METAL_SIMDGROUPS: String(simdgroups),
  BRAINVAULT_METAL_KERNEL: kernel,
  BRAINVAULT_METAL_PRIVATE: memory === 'private' ? '1' : '0',
};

async function runExecutable(
  executable: string,
  input: Buffer,
  environment: Record<string, string> = {},
): Promise<Run> {
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
  const output = Buffer.from(stdout);
  if (exitCode !== 0) {
    output.fill(0);
    throw new Error(`BRAINVAULT_METAL_CHILD_FAILED:${exitCode}:${stderr.trim()}`);
  }
  const expected = input.readUInt32LE(4) * BRAINVAULT_V1.SHARD_OUTPUT_BYTES;
  if (output.length !== expected) {
    const actual = output.length;
    output.fill(0);
    throw new Error(`BRAINVAULT_METAL_OUTPUT_INVALID:${actual}:${expected}`);
  }
  return { output, timeMs, profile: stderr.trim() || undefined };
}

async function settleRuns(promises: Promise<Run>[]): Promise<Run[]> {
  const settled = await Promise.allSettled(promises);
  const failed = settled.find(result => result.status === 'rejected');
  if (failed !== undefined) {
    for (const result of settled) if (result.status === 'fulfilled') result.value.output.fill(0);
    throw failed.reason;
  }
  return settled.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

async function rootFor(output: Buffer): Promise<string> {
  const shards = Array.from(
    { length: shardCount },
    (_, index) => new Uint8Array(output.subarray(index * 32, (index + 1) * 32)),
  );
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
let metalProfile: string | undefined;
let cpuMs: number | undefined;
let metalMs: number | undefined;

async function benchmark(): Promise<void> {
  if (mode === 'parity') {
    const cpuInput = makeInput(0, shardCount, cpuWorkers);
    const metalInput = makeInput(0, shardCount, metalWorkers);
    try {
      const [cpu, metal] = await settleRuns([
        runExecutable(cpuExecutable, cpuInput),
        runExecutable(metalExecutable, metalInput, metalEnvironment),
      ]);
      rawParity = Buffer.compare(cpu.output, metal.output) === 0;
      if (!rawParity) {
        cpu.output.fill(0);
        metal.output.fill(0);
        throw new Error('BRAINVAULT_METAL_RAW_PARITY_FAILED');
      }
      output = metal.output;
      timeMs = metal.timeMs;
      cpuMs = cpu.timeMs;
      metalMs = metal.timeMs;
      metalProfile = metal.profile;
      cpu.output.fill(0);
    } finally {
      cpuInput.fill(0);
      metalInput.fill(0);
    }
  } else if (mode === 'hybrid') {
    if (gpuShards === 0 || gpuShards === shardCount) throw new Error('BRAINVAULT_METAL_HYBRID_SPLIT_INVALID');
    const cpuCount = shardCount - gpuShards;
    const cpuInput = makeInput(0, cpuCount, cpuWorkers);
    const activeMetalProcesses = Math.min(metalProcesses, gpuShards);
    const metalCounts = Array.from(
      { length: activeMetalProcesses },
      (_, index) => Math.floor(gpuShards / activeMetalProcesses) + (index < gpuShards % activeMetalProcesses ? 1 : 0),
    );
    let metalFirst = cpuCount;
    const metalInputs = metalCounts.map(count => {
      const input = makeInput(metalFirst, count, metalWorkers);
      metalFirst += count;
      return input;
    });
    const started = performance.now();
    try {
      const [cpu, ...metals] = await settleRuns([
        runExecutable(cpuExecutable, cpuInput),
        ...metalInputs.map(input => runExecutable(metalExecutable, input, metalEnvironment)),
      ]);
      try {
        output = Buffer.concat([cpu.output, ...metals.map(metal => metal.output)]);
        timeMs = performance.now() - started;
        cpuMs = cpu.timeMs;
        metalMs = Math.max(...metals.map(metal => metal.timeMs));
        metalProfile =
          metals
            .map(metal => metal.profile)
            .filter(Boolean)
            .join(' | ') || undefined;
      } finally {
        cpu.output.fill(0);
        for (const metal of metals) metal.output.fill(0);
      }
    } finally {
      cpuInput.fill(0);
      for (const metalInput of metalInputs) metalInput.fill(0);
    }
  } else {
    const input = makeInput(0, shardCount, mode === 'cpu' ? cpuWorkers : metalWorkers);
    try {
      const run = await runExecutable(
        mode === 'cpu' ? cpuExecutable : metalExecutable,
        input,
        mode === 'metal' ? metalEnvironment : {},
      );
      output = run.output;
      timeMs = run.timeMs;
      if (mode === 'cpu') cpuMs = run.timeMs;
      else metalMs = run.timeMs;
      metalProfile = mode === 'metal' ? run.profile : undefined;
    } finally {
      input.fill(0);
    }
  }

  try {
    const root = await rootFor(output!);
    console.log(
      JSON.stringify(
        {
          mode,
          specId: BRAINVAULT_V1_SPEC_ID,
          shardCount,
          cpuWorkers,
          metalWorkers,
          metalProcesses: mode === 'hybrid' ? Math.min(metalProcesses, gpuShards) : undefined,
          simdgroups: mode === 'metal' || mode === 'hybrid' || mode === 'parity' ? simdgroups : undefined,
          kernel: mode === 'metal' || mode === 'hybrid' || mode === 'parity' ? kernel : undefined,
          memory: mode === 'metal' || mode === 'hybrid' || mode === 'parity' ? memory : undefined,
          gpuShards: mode === 'hybrid' ? gpuShards : undefined,
          timeMs: Number(timeMs!.toFixed(3)),
          cpuMs: cpuMs === undefined ? undefined : Number(cpuMs.toFixed(3)),
          metalMs: metalMs === undefined ? undefined : Number(metalMs.toFixed(3)),
          tailDeltaMs: cpuMs === undefined || metalMs === undefined ? undefined : Number((cpuMs - metalMs).toFixed(3)),
          shardsPerSecond: Number((shardCount / (timeMs! / 1_000)).toFixed(3)),
          rawParity,
          metalProfile,
          root,
        },
        null,
        2,
      ),
    );
  } finally {
    output!.fill(0);
  }
}

try {
  await benchmark();
} finally {
  password.fill(0);
  for (const salt of salts) salt.fill(0);
}
