#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { bytesToHex, combineShardsWithParams, factorForShardCount } from '../../core.ts';
import { BRAINVAULT_V1, createShardSalt } from '../../primitives/spec.ts';

const shardCount = Number(process.argv[2] ?? '2');
const openclOnly = process.argv[3] === 'opencl';
if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 1_000) {
  throw new Error('PROBE_SHARD_COUNT_INVALID');
}

const cpuExecutable = '../argon2-c/brainvault-argon2-oversubscribed';
const openclExecutable = './brainvault-argon2-opencl';
if (!existsSync(cpuExecutable) || !existsSync(openclExecutable)) throw new Error('PROBE_EXECUTABLE_MISSING');

const password = new TextEncoder().encode('benchmark-password');
const salts = await Promise.all(Array.from(
  { length: shardCount },
  (_, index) => createShardSalt('benchmark-user', index, shardCount, BRAINVAULT_V1.ALG_ID),
));

const input = Buffer.alloc(24 + password.length + (shardCount * 32));
input.writeUInt32LE(0x32435642, 0);
input.writeUInt32LE(shardCount, 4);
input.writeUInt32LE(Math.min(32, shardCount), 8);
input.writeUInt32LE(password.length, 12);
input.writeUInt32LE(0, 16);
input.writeUInt32LE(BRAINVAULT_V1.SHARD_MEMORY_KB, 20);
input.set(password, 24);
for (let index = 0; index < shardCount; index += 1) {
  input.set(salts[index]!, 24 + password.length + (index * 32));
}

async function run(executable: string): Promise<{ output: Buffer; timeMs: number; stderr: string }> {
  const started = performance.now();
  const child = Bun.spawn([executable], {
    env: { ...process.env, BRAINVAULT_OPENCL_PROFILE: '1' },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  child.stdin.write(input);
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${executable}:${exitCode}:${stderr}`);
  return { output: Buffer.from(stdout), timeMs: performance.now() - started, stderr: stderr.trim() };
}

async function rootFor(output: Buffer): Promise<string> {
  const shards = Array.from({ length: shardCount }, (_, index) =>
    new Uint8Array(output.subarray(index * 32, (index + 1) * 32)));
  const root = await combineShardsWithParams(shards, factorForShardCount(shardCount), {
    algId: BRAINVAULT_V1.ALG_ID,
    shardMemoryKb: BRAINVAULT_V1.SHARD_MEMORY_KB,
  });
  try {
    return bytesToHex(root);
  } finally {
    root.fill(0);
    for (const shard of shards) shard.fill(0);
  }
}

try {
  const cpu = openclOnly ? undefined : await run(cpuExecutable);
  const opencl = await run(openclExecutable);
  const rawParity = cpu ? Buffer.compare(cpu.output, opencl.output) === 0 : undefined;
  const cpuRoot = cpu ? await rootFor(cpu.output) : undefined;
  const openclRoot = await rootFor(opencl.output);
  console.log(JSON.stringify({
    shardCount,
    rawParity,
    rootParity: cpuRoot ? cpuRoot === openclRoot : undefined,
    cpuMs: cpu ? Number(cpu.timeMs.toFixed(3)) : undefined,
    openclMs: Number(opencl.timeMs.toFixed(3)),
    openclProfile: opencl.stderr,
    root: openclRoot,
  }, null, 2));
  if (cpu && (!rawParity || cpuRoot !== openclRoot)) process.exitCode = 1;
  cpu?.output.fill(0);
  opencl.output.fill(0);
} finally {
  input.fill(0);
  password.fill(0);
  for (const salt of salts) salt.fill(0);
}
