import { expect, test } from 'bun:test';
import { bytesToHex, combineShards } from './core.ts';
import { createShardSalt } from './primitives/spec.ts';
import { acceleratorPlan, deriveHybridNativeShards, type AcceleratorEngine } from './native-hybrid.ts';

test('M3 Ultra Metal V1 profile freezes the measured balanced split', () => {
  expect(acceleratorPlan('metal', 1_000, 32, 32, 512 * 1024 ** 3)).toEqual({
    cpuShards: 360,
    cpuWorkers: 32,
    acceleratorShards: 640,
    acceleratorWorkers: 40,
    acceleratorProcesses: 8,
  });
});

test('M3 Ultra standard default scales the frozen measured profile to 10,000 shards', () => {
  const plan = acceleratorPlan('metal', 10_000, 32, 32, 512 * 1024 ** 3);
  expect(plan).toEqual({
    cpuShards: 3_600,
    cpuWorkers: 32,
    acceleratorShards: 6_400,
    acceleratorWorkers: 40,
    acceleratorProcesses: 8,
  });
  expect((plan.cpuWorkers + plan.acceleratorProcesses * plan.acceleratorWorkers) * 256 * 1024 ** 2)
    .toBe(88 * 1024 ** 3);
});

test('unmeasured entry M5 candidate stays within its shared-memory budget', () => {
  const plan = acceleratorPlan('metal', 1_000, 10, 10, 16 * 1024 ** 3);
  expect(plan).toEqual({
    cpuShards: 380,
    cpuWorkers: 10,
    acceleratorShards: 620,
    acceleratorWorkers: 27,
    acceleratorProcesses: 1,
  });
  expect((plan.cpuWorkers + plan.acceleratorWorkers) * 256 * 1024 ** 2)
    .toBeLessThanOrEqual(16 * 1024 ** 3 * 0.58);
});

test('two-shard accelerator smoke uses one CPU and one GPU shard', () => {
  expect(acceleratorPlan('metal', 2, 32, 32, 256 * 1024 ** 3)).toEqual({
    cpuShards: 1,
    cpuWorkers: 1,
    acceleratorShards: 1,
    acceleratorWorkers: 1,
    acceleratorProcesses: 1,
  });
});

test('one-shard compatibility level remains selectable on an accelerator', () => {
  expect(acceleratorPlan('metal', 1, 32, 32, 256 * 1024 ** 3)).toEqual({
    cpuShards: 0,
    cpuWorkers: 0,
    acceleratorShards: 1,
    acceleratorWorkers: 1,
    acceleratorProcesses: 1,
  });
});

test('accelerator orchestration fails closed on truncated native output', async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const password = new TextEncoder().encode('benchmark-password');
  const salt = await createShardSalt('benchmark-user', 0, 1);
  try {
    await expect(deriveHybridNativeShards({
      engine: 'metal',
      password,
      salts: [salt],
      memoryKiB: 262144,
      requestedCpuWorkers: 1,
      paths: {
        packageRoot: import.meta.dir,
        cpuExecutable: `${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2`,
        acceleratorExecutable: `${import.meta.dir}/test-fixtures/worker-truncated.ts`,
        metalLibrary: `${import.meta.dir}/prebuilds/darwin-arm64/argon2.metallib`,
      },
    })).rejects.toThrow('BRAINVAULT_ACCELERATOR_OUTPUT_INVALID');
  } finally {
    password.fill(0);
    salt.fill(0);
  }
});

test('every accelerator reproduces frozen ASCII, Unicode/NUL, and ordered smoke vectors', async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const vectorFile = await Bun.file(`${import.meta.dir}/vectors-v1.json`).json() as {
    vectors: Array<{
      id: string;
      input: { name: string; passphrase: string; shardCount: number; factor: number };
      expected: { root: string };
    }>;
  };
  const vectors = vectorFile.vectors.filter(vector => [
    'ascii-alice-1',
    'unicode-nfkd-composed-1',
    'unicode-emoji-nul-1',
    'benchmark-smoke-2',
  ].includes(vector.id));
  const cpuExecutable = `${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2`;
  for (const engine of ['metal', 'metal-generic', 'opencl'] satisfies AcceleratorEngine[]) {
    for (const vector of vectors) {
      const password = new TextEncoder().encode(vector.input.passphrase.normalize('NFKD'));
      const salts = await Promise.all(Array.from(
        { length: vector.input.shardCount },
        (_, index) => createShardSalt(vector.input.name, index, vector.input.shardCount),
      ));
      let shards: Uint8Array[] = [];
      const progress: number[] = [];
      try {
        const result = await deriveHybridNativeShards({
          engine,
          password,
          salts,
          memoryKiB: 262144,
          requestedCpuWorkers: 2,
          onProgress: completed => progress.push(completed),
          paths: {
            packageRoot: import.meta.dir,
            cpuExecutable,
            acceleratorExecutable: engine === 'opencl'
              ? `${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2-opencl`
              : `${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2-metal`,
            metalLibrary: engine === 'opencl'
              ? undefined : `${import.meta.dir}/prebuilds/darwin-arm64/argon2.metallib`,
            openclKernel: engine === 'opencl'
              ? `${import.meta.dir}/experimental/argon2-opencl/data/kernels/argon2_kernel.cl` : undefined,
          },
        });
        shards = result.shards as Uint8Array[];
        expect(progress.at(-1)).toBe(vector.input.shardCount);
        expect(progress.every((completed, index) => index === 0 || completed > progress[index - 1]!)).toBe(true);
        expect(bytesToHex(await combineShards(shards, vector.input.factor))).toBe(vector.expected.root);
      } finally {
        password.fill(0);
        for (const salt of salts) salt.fill(0);
        for (const shard of shards) shard.fill(0);
      }
    }
  }
}, 20_000);
