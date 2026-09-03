import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { bytesToHex, combineShards } from './core.ts';
import { BRAINVAULT_V1, createShardSalt } from './primitives/spec.ts';
import { acceleratorPlan, deriveHybridNativeShards, type AcceleratorEngine } from './native-hybrid.ts';

function protocolInput(memoryKiB: number, mutation: 'flags' | 'workers' | 'trailing'): Buffer {
  const input = Buffer.alloc(24 + 1 + 32 + (mutation === 'trailing' ? 1 : 0));
  input.writeUInt32LE(0x32435642, 0);
  input.writeUInt32LE(1, 4);
  input.writeUInt32LE(mutation === 'workers' ? 2 : 1, 8);
  input.writeUInt32LE(1, 12);
  input.writeUInt32LE(mutation === 'flags' ? 0x8000_0000 : 0, 16);
  input.writeUInt32LE(memoryKiB, 20);
  input[24] = 0x78;
  return input;
}

function longPasswordInput(): Buffer {
  const passwordBytes = (1 << 20) + 1;
  const input = Buffer.alloc(24 + passwordBytes + 32);
  input.writeUInt32LE(0x32435642, 0);
  input.writeUInt32LE(1, 4);
  input.writeUInt32LE(1, 8);
  input.writeUInt32LE(passwordBytes, 12);
  input.writeUInt32LE(0, 16);
  input.writeUInt32LE(8, 20);
  input.fill(0x78, 24, 24 + passwordBytes);
  return input;
}

function singleShardInput(password: Uint8Array, salt: Uint8Array, memoryKiB: number): Buffer {
  const input = Buffer.alloc(24 + password.length + 32);
  input.writeUInt32LE(0x32435642, 0);
  input.writeUInt32LE(1, 4);
  input.writeUInt32LE(1, 8);
  input.writeUInt32LE(password.length, 12);
  input.writeUInt32LE(0, 16);
  input.writeUInt32LE(memoryKiB, 20);
  input.set(password, 24);
  input.set(salt, 24 + password.length);
  return input;
}

test('Rust native input uses fixed validated allocations so secret bytes are not reallocated', async () => {
  const source = await Bun.file(`${import.meta.dir}/experimental/argon2-rust/src/main.rs`).text();
  expect(source).not.toContain('read_to_end');
  expect(source).toContain('read_exact(&mut header)');
  expect(source).toContain('SecretVec(vec![0u8; password_len])');
  expect(source).toContain('SecretVec(vec![0u8; salt_len])');
});

test('every bundled native executable rejects malformed wire input', () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const prebuildRoot = `${import.meta.dir}/prebuilds/darwin-arm64`;
  const engines = [
    ['c-portable', `${prebuildRoot}/brainvault-argon2`, 8],
    ['c-native', `${prebuildRoot}/brainvault-argon2-m3`, 8],
    ['rust-secure', `${prebuildRoot}/brainvault-argon2-rust`, 8],
    ['rust-secure-m3', `${prebuildRoot}/brainvault-argon2-rust-m3`, 8],
    ['rust-no-wipe', `${prebuildRoot}/brainvault-argon2-rust-no-wipe`, 8],
    ['rust-no-wipe-m3', `${prebuildRoot}/brainvault-argon2-rust-no-wipe-m3`, 8],
    ['metal', `${prebuildRoot}/brainvault-argon2-metal`, 8],
    ['opencl', `${prebuildRoot}/brainvault-argon2-opencl`, BRAINVAULT_V1.SHARD_MEMORY_KB],
  ] as const;
  const accepted: string[] = [];
  for (const [label, executable, memoryKiB] of engines) {
    if (!existsSync(executable)) continue;
    for (const mutation of ['flags', 'workers', 'trailing'] as const) {
      const input = protocolInput(memoryKiB, mutation);
      try {
        const result = Bun.spawnSync({
          cmd: [executable],
          env: label === 'opencl' ? {
            ...process.env,
            BRAINVAULT_OPENCL_KERNEL_DIR: `${import.meta.dir}/experimental/argon2-opencl/data/kernels`,
          } : process.env,
          stdin: input,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (result.exitCode === 0) accepted.push(`${label}:${mutation}`);
        result.stdout.fill(0);
      } finally {
        input.fill(0);
      }
    }
  }
  expect(accepted).toEqual([]);
}, 20_000);

test('native engines do not impose a non-V1 password length cap', () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const prebuildRoot = `${import.meta.dir}/prebuilds/darwin-arm64`;
  const outputs: Buffer[] = [];
  for (const executable of [
    `${prebuildRoot}/brainvault-argon2`,
    `${prebuildRoot}/brainvault-argon2-m3`,
    `${prebuildRoot}/brainvault-argon2-rust`,
    `${prebuildRoot}/brainvault-argon2-rust-m3`,
    `${prebuildRoot}/brainvault-argon2-rust-no-wipe`,
    `${prebuildRoot}/brainvault-argon2-rust-no-wipe-m3`,
    `${prebuildRoot}/brainvault-argon2-metal`,
  ]) {
    const input = longPasswordInput();
    try {
      const result = Bun.spawnSync({ cmd: [executable], stdin: input, stdout: 'pipe', stderr: 'pipe' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(BRAINVAULT_V1.SHARD_OUTPUT_BYTES);
      outputs.push(Buffer.from(result.stdout));
      result.stdout.fill(0);
    } finally {
      input.fill(0);
    }
  }
  try {
    for (const output of outputs.slice(1)) expect(output).toEqual(outputs[0]);
  } finally {
    for (const output of outputs) output.fill(0);
  }
}, 20_000);

test('Apple M1 and M3 CPU prebuilds reproduce the frozen V1 shard', async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const prebuildRoot = `${import.meta.dir}/prebuilds/darwin-arm64`;
  const password = new TextEncoder().encode('secret123456');
  const salt = await createShardSalt('alice', 0, 1);
  try {
    for (const executable of [
      `${prebuildRoot}/brainvault-argon2`,
      `${prebuildRoot}/brainvault-argon2-m3`,
      `${prebuildRoot}/brainvault-argon2-rust`,
      `${prebuildRoot}/brainvault-argon2-rust-m3`,
      `${prebuildRoot}/brainvault-argon2-rust-no-wipe`,
      `${prebuildRoot}/brainvault-argon2-rust-no-wipe-m3`,
    ]) {
      const input = singleShardInput(password, salt, BRAINVAULT_V1.SHARD_MEMORY_KB);
      try {
        const result = Bun.spawnSync({ cmd: [executable], stdin: input, stdout: 'pipe', stderr: 'pipe' });
        expect(result.exitCode).toBe(0);
        expect(bytesToHex(result.stdout)).toBe('d7057a04c5441e8246db71a98c94148b6306d810c5a5382ee5d3fd15655927b4');
        result.stdout.fill(0);
      } finally {
        input.fill(0);
      }
    }
  } finally {
    password.fill(0);
    salt.fill(0);
  }
}, 20_000);

test('M3 Ultra Metal V1 profile freezes the measured balanced split', () => {
  expect(acceleratorPlan('metal', 1_000, 32, 32, 512 * 1024 ** 3)).toEqual({
    cpuShards: 360,
    cpuWorkers: 32,
    acceleratorShards: 640,
    acceleratorWorkers: 40,
    acceleratorProcesses: 8,
  });
});

test('M3 Ultra standard default uses the measured balanced 10,000-shard profile', () => {
  const plan = acceleratorPlan('metal', 10_000, 32, 32, 512 * 1024 ** 3);
  expect(plan).toEqual({
    cpuShards: 2_000,
    cpuWorkers: 32,
    acceleratorShards: 8_000,
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

test('accelerator child failures never disclose stderr or local paths', async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const password = new TextEncoder().encode('benchmark-password');
  const salt = await createShardSalt('benchmark-user', 0, 1);
  let message = '';
  try {
    await deriveHybridNativeShards({
      engine: 'metal',
      password,
      salts: [salt],
      memoryKiB: 262144,
      requestedCpuWorkers: 1,
      paths: {
        packageRoot: import.meta.dir,
        cpuExecutable: `${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2`,
        acceleratorExecutable: `${import.meta.dir}/test-fixtures/native-failure.ts`,
        metalLibrary: `${import.meta.dir}/prebuilds/darwin-arm64/argon2.metallib`,
      },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    password.fill(0);
    salt.fill(0);
  }
  expect(message).toBe('BRAINVAULT_ACCELERATOR_CHILD_FAILED:7');
});

test('invalid accelerator progress terminates the native child', async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const fixture = `${import.meta.dir}/test-fixtures/native-invalid-progress.ts`;
  const password = new TextEncoder().encode('benchmark-password');
  const salt = await createShardSalt('benchmark-user', 0, 1);
  let message = '';
  try {
    await deriveHybridNativeShards({
      engine: 'metal',
      password,
      salts: [salt],
      memoryKiB: 262144,
      requestedCpuWorkers: 1,
      onProgress: () => {},
      paths: {
        packageRoot: import.meta.dir,
        cpuExecutable: `${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2`,
        acceleratorExecutable: fixture,
        metalLibrary: `${import.meta.dir}/prebuilds/darwin-arm64/argon2.metallib`,
      },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    password.fill(0);
    salt.fill(0);
  }
  await Bun.sleep(50);
  const found = Bun.spawnSync({ cmd: ['pgrep', '-f', fixture], stderr: 'pipe', stdout: 'pipe' });
  const pids = found.exitCode === 0
    ? found.stdout.toString().trim().split('\n').filter(Boolean).map(Number)
    : [];
  for (const pid of pids) if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGKILL');
  expect(message).toBe('BRAINVAULT_NATIVE_PROGRESS_INVALID');
  expect(pids).toEqual([]);
}, 5_000);

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
