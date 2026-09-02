import { cpus, totalmem } from 'node:os';
import { verifyBundledExecutable, verifyBundledFile } from './binary-integrity.ts';

const INPUT_MAGIC = 0x32435642;
const HEADER_BYTES = 24;
const SALT_BYTES = 32;
const OUTPUT_BYTES = 32;
const MEMORY_BYTES_PER_SHARD = 256 * 1024 * 1024;

export type AcceleratorEngine = 'metal' | 'metal-generic' | 'opencl';

export type AcceleratorPlan = Readonly<{
  cpuShards: number;
  cpuWorkers: number;
  acceleratorShards: number;
  acceleratorWorkers: number;
  acceleratorProcesses: number;
}>;

export type NativeHybridPaths = Readonly<{
  packageRoot: string;
  cpuExecutable: string;
  acceleratorExecutable: string;
  metalLibrary?: string;
  openclKernel?: string;
}>;

function boundedWorkers(value: number, shards: number): number {
  return Math.max(1, Math.min(value, shards));
}

/** Hardware-aware defaults; explicit benchmark flags remain available for tuning. */
export function acceleratorPlan(
  engine: AcceleratorEngine,
  shardCount: number,
  requestedCpuWorkers: number,
  cpuCount = cpus().length,
  totalMemory = totalmem(),
): AcceleratorPlan {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error(`BRAINVAULT_ACCELERATOR_SHARDS_INVALID:${shardCount}`);
  }
  if (shardCount === 1) {
    return {
      cpuShards: 0,
      cpuWorkers: 0,
      acceleratorShards: 1,
      acceleratorWorkers: 1,
      acceleratorProcesses: 1,
    };
  }
  const totalGiB = totalMemory / (1024 ** 3);
  const ultra = totalGiB >= 128 && cpuCount >= 24;
  const acceleratorProcesses = engine !== 'opencl' && ultra && shardCount >= 8 ? 2 : 1;

  if (ultra && shardCount >= 100) {
    const acceleratorShards = engine === 'opencl'
      ? Math.min(shardCount - 1, Math.round(shardCount * 0.496))
      : Math.min(shardCount - 1, Math.round(shardCount * 0.588));
    return {
      cpuShards: shardCount - acceleratorShards,
      cpuWorkers: boundedWorkers(engine === 'opencl' ? Math.min(30, requestedCpuWorkers) : requestedCpuWorkers, shardCount - acceleratorShards),
      acceleratorShards,
      acceleratorWorkers: engine === 'opencl'
        ? Math.min(248, acceleratorShards)
        : Math.min(147, Math.ceil(acceleratorShards / acceleratorProcesses)),
      acceleratorProcesses,
    };
  }

  // Keep a laptop below roughly 60% of physical RAM: the CPU and GPU share it.
  const memorySlots = Math.max(2, Math.floor((totalMemory * 0.58) / MEMORY_BYTES_PER_SHARD));
  const cpuWorkers = boundedWorkers(Math.min(requestedCpuWorkers, cpuCount, Math.max(1, Math.floor(memorySlots * 0.28))), shardCount - 1);
  const acceleratorWorkers = boundedWorkers(
    Math.max(1, memorySlots - cpuWorkers),
    shardCount - 1,
  );
  const acceleratorFraction = engine === 'opencl' ? 0.50 : 0.62;
  const acceleratorShards = Math.min(shardCount - 1, Math.max(1, Math.round(shardCount * acceleratorFraction)));
  return {
    cpuShards: shardCount - acceleratorShards,
    cpuWorkers: boundedWorkers(cpuWorkers, shardCount - acceleratorShards),
    acceleratorShards,
    acceleratorWorkers: Math.min(acceleratorWorkers, acceleratorShards),
    acceleratorProcesses: 1,
  };
}

function makeInput(
  password: Uint8Array,
  salts: readonly Uint8Array[],
  first: number,
  count: number,
  workers: number,
  memoryKiB: number,
): Buffer {
  const input = Buffer.alloc(HEADER_BYTES + password.length + (count * SALT_BYTES));
  input.writeUInt32LE(INPUT_MAGIC, 0);
  input.writeUInt32LE(count, 4);
  input.writeUInt32LE(Math.min(workers, count), 8);
  input.writeUInt32LE(password.length, 12);
  input.writeUInt32LE(0, 16);
  input.writeUInt32LE(memoryKiB, 20);
  input.set(password, HEADER_BYTES);
  for (let offset = 0; offset < count; offset += 1) {
    const salt = salts[first + offset];
    if (salt === undefined || salt.length !== SALT_BYTES) throw new Error('BRAINVAULT_ACCELERATOR_SALT_INVALID');
    input.set(salt, HEADER_BYTES + password.length + (offset * SALT_BYTES));
  }
  return input;
}

type NativeJob = Readonly<{
  first: number;
  count: number;
  workers: number;
  executable: string;
  environment?: Readonly<Record<string, string>>;
}>;

async function runJob(job: NativeJob, input: Buffer): Promise<Readonly<{ first: number; output: Buffer }>> {
  const child = Bun.spawn([job.executable], {
    env: { ...process.env, ...job.environment },
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
    throw new Error(`BRAINVAULT_ACCELERATOR_CHILD_FAILED:${exitCode}:${stderr.trim()}`);
  }
  const expected = job.count * OUTPUT_BYTES;
  if (output.length !== expected) {
    const actual = output.length;
    output.fill(0);
    throw new Error(`BRAINVAULT_ACCELERATOR_OUTPUT_INVALID:${actual}:${expected}`);
  }
  return { first: job.first, output };
}

export async function deriveHybridNativeShards(options: Readonly<{
  engine: AcceleratorEngine;
  password: Uint8Array;
  salts: readonly Uint8Array[];
  memoryKiB: number;
  requestedCpuWorkers: number;
  paths: NativeHybridPaths;
}>): Promise<Readonly<{ shards: Uint8Array[]; plan: AcceleratorPlan }>> {
  const { engine, password, salts, memoryKiB, requestedCpuWorkers, paths } = options;
  if (memoryKiB !== 262144) throw new Error(`BRAINVAULT_ACCELERATOR_MEMORY_UNSUPPORTED:${memoryKiB}`);
  const shardCount = salts.length;
  const plan = acceleratorPlan(engine, shardCount, requestedCpuWorkers);
  const cpuExecutable = verifyBundledExecutable(paths.cpuExecutable, paths.packageRoot);
  const acceleratorExecutable = verifyBundledExecutable(paths.acceleratorExecutable, paths.packageRoot);
  if (engine === 'opencl') {
    if (paths.openclKernel === undefined) throw new Error('BRAINVAULT_OPENCL_KERNEL_MISSING');
    verifyBundledFile(paths.openclKernel, paths.packageRoot);
  } else {
    if (paths.metalLibrary === undefined) throw new Error('BRAINVAULT_METAL_LIBRARY_MISSING');
    verifyBundledFile(paths.metalLibrary, paths.packageRoot);
  }

  const jobs: NativeJob[] = [];
  if (plan.cpuShards > 0) {
    jobs.push({
      first: 0,
      count: plan.cpuShards,
      workers: plan.cpuWorkers,
      executable: cpuExecutable,
    });
  }
  let first = plan.cpuShards;
  for (let processIndex = 0; processIndex < plan.acceleratorProcesses; processIndex += 1) {
    const count = Math.floor(plan.acceleratorShards / plan.acceleratorProcesses)
      + (processIndex < plan.acceleratorShards % plan.acceleratorProcesses ? 1 : 0);
    const simdgroups = count >= 4 ? 4 : count >= 2 ? 2 : 1;
    jobs.push({
      first,
      count,
      workers: Math.min(plan.acceleratorWorkers, count),
      executable: acceleratorExecutable,
      environment: engine === 'opencl' ? {
        BRAINVAULT_OPENCL_BATCH: String(Math.min(plan.acceleratorWorkers, count)),
        BRAINVAULT_OPENCL_JOBS_PER_BLOCK: '1',
        BRAINVAULT_OPENCL_KERNEL_DIR: paths.openclKernel!.slice(0, paths.openclKernel!.lastIndexOf('/')),
      } : {
        BRAINVAULT_METAL_KERNEL: engine === 'metal' ? 'v1special' : 'modern64',
        BRAINVAULT_METAL_PRIVATE: '1',
        BRAINVAULT_METAL_SIMDGROUPS: String(simdgroups),
      },
    });
    first += count;
  }

  const inputs: Buffer[] = [];
  try {
    for (const job of jobs) inputs.push(makeInput(password, salts, job.first, job.count, job.workers, memoryKiB));
  } catch (error) {
    for (const input of inputs) input.fill(0);
    throw error;
  }
  const settled = await Promise.allSettled(jobs.map((job, index) => runJob(job, inputs[index]!)));
  for (const input of inputs) input.fill(0);
  const failure = settled.find(result => result.status === 'rejected');
  if (failure !== undefined) {
    for (const result of settled) if (result.status === 'fulfilled') result.value.output.fill(0);
    throw failure.reason;
  }
  const runs = settled.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  }).sort((left, right) => left.first - right.first);
  const shards: Uint8Array[] = [];
  try {
    for (const run of runs) {
      for (let offset = 0; offset < run.output.length; offset += OUTPUT_BYTES) {
        shards.push(new Uint8Array(run.output.subarray(offset, offset + OUTPUT_BYTES)));
      }
    }
  } finally {
    for (const run of runs) run.output.fill(0);
  }
  if (shards.length !== shardCount) {
    for (const shard of shards) shard.fill(0);
    throw new Error(`BRAINVAULT_ACCELERATOR_SHARD_COUNT_INVALID:${shards.length}:${shardCount}`);
  }
  return { shards, plan };
}
