import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveBrainVaultNative } from '../../brainvault/native';
import { BRAINVAULT_V1_SPEC_ID } from '../../brainvault/spec';
import { validateRuntimeAdapterWireMessage } from '../../runtime/api/runtime-adapter/wire-schema';
import { createBrainVaultOwnerController } from '../../runtime/api/server/brainvault-owner';
import type { EntityReplica, RuntimeInput, RuntimeReplica } from '../../runtime/runtime/types';

test('native node backend reproduces the frozen V1 browser wallet', async () => {
  const progress: number[] = [];
  const result = await deriveBrainVaultNative({
    name: 'alice',
    passphrase: 'secret123456',
    shardInput: 1,
    workers: 1,
  }, {
    onProgress: sample => progress.push(sample.completed),
  });

  expect(result.specId).toBe(BRAINVAULT_V1_SPEC_ID);
  expect(result.mnemonic24).toBe(
    'milk click novel require across cousin good chair street mouse crash movie same daughter air quote total pride crop mention focus sick slice hole',
  );
  expect(result.ethereumAddress).toBe('0x93bAb14eD871462D414a7c0357BF1a76DE741397');
  expect(progress).toEqual([1]);
});

test('isolated native workers reproduce the frozen multi-shard wallet', async () => {
  const result = await deriveBrainVaultNative({
    name: 'alice',
    passphrase: 'secret123456',
    shardInput: 2,
    workers: 8,
  });

  expect(result.shardCount).toBe(10);
  expect(result.workers).toBe(8);
  expect(result.ethereumAddress).toBe('0xD42C021b40B4ab21Bffdb58837D76734dd9CC66D');
});

test('native derivation rejects a worker built for another BrainVault spec', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-brainvault-stale-worker-'));
  const workerPath = join(directory, 'stale-worker.mjs');
  writeFileSync(workerPath, [
    "import { parentPort } from 'node:worker_threads';",
    "parentPort.on('message', ({ shardIndex }) => parentPort.postMessage({",
    "  specId: 'brainvault/stale-v0',",
    '  shardIndex,',
    "  result: '00'.repeat(32),",
    '}));',
  ].join('\n'), 'utf8');

  try {
    await expect(deriveBrainVaultNative({
      name: 'alice',
      passphrase: 'secret123456',
      shardInput: 1,
      workers: 1,
    }, { workerPath })).rejects.toThrow('BRAINVAULT_WORKER_SPEC_MISMATCH:brainvault/stale-v0');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native node backend honors cancellation before allocating Argon memory', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(deriveBrainVaultNative({
    name: 'alice',
    passphrase: 'secret123456',
    shardInput: 1,
    workers: 1,
  }, { signal: abort.signal })).rejects.toThrow('BRAINVAULT_DERIVATION_ABORTED');
});

test('radapter accepts exact BrainVault messages and rejects secret-bearing drift', () => {
  expect(validateRuntimeAdapterWireMessage({
    v: 1,
    id: 'derive-1',
    op: 'brainvault-derive',
    jobId: 'brainvault-1',
    input: {
      specId: BRAINVAULT_V1_SPEC_ID,
      name: 'alice',
      passphrase: 'secret123456',
      shardInput: 3,
      workers: 8,
    },
  })).toMatchObject({ op: 'brainvault-derive' });

  expect(validateRuntimeAdapterWireMessage({
    v: 1,
    op: 'brainvault-progress',
    jobId: 'brainvault-1',
    progress: { completed: 1, total: 100, elapsedMs: 150, lastShardMs: 150, workers: 8 },
  })).toMatchObject({ op: 'brainvault-progress' });

  expect(validateRuntimeAdapterWireMessage({
    v: 1,
    id: 'reveal-1',
    op: 'brainvault-reveal',
  })).toMatchObject({ op: 'brainvault-reveal' });

  expect(() => validateRuntimeAdapterWireMessage({
    v: 1,
    id: 'derive-leak',
    op: 'brainvault-derive',
    jobId: 'brainvault-2',
    input: {
      specId: BRAINVAULT_V1_SPEC_ID,
      name: 'alice',
      passphrase: 'secret123456',
      shardInput: 3,
      workers: 8,
      privateKey: 'forbidden',
    },
  })).toThrow('RADAPTER_REQUEST_BRAINVAULT_INPUT_FIELDS_INVALID');
});

const makeOwnerEnv = (): RuntimeReplica => ({
  runtimeSeed: 'brainvault-owner-test-scope',
  runtimeId: '0x0000000000000000000000000000000000000001',
  activeJurisdiction: 'local',
  state: {
    height: 1,
    timestamp: 1,
    jReplicas: new Map([['local', {
      name: 'local',
      chainId: 31337,
      blockTimeMs: 1_000,
      rpcs: ['http://localhost:8545'],
      depositoryAddress: '0x0000000000000000000000000000000000000002',
      entityProviderAddress: '0x0000000000000000000000000000000000000003',
    }]]),
    eReplicas: new Map(),
  },
}) as RuntimeReplica;

test('node owner persists recovery secret but ordinary result stays public', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-brainvault-owner-'));
  const path = join(directory, 'owner.json');
  const env = makeOwnerEnv();
  let commitCallback: ((height: number) => void) | null = null;
  const durabilityBoundaries: string[] = [];
  writeFileSync(`${path}.${process.pid}.tmp`, 'stale interrupted predecessor', 'utf8');
  const controller = createBrainVaultOwnerController({
    path,
    profileName: 'test owner',
    timeoutMs: 2_000,
    durability: {
      onBoundary: boundary => { durabilityBoundaries.push(boundary); },
    },
    onFrameCommit: (_env, callback) => {
      commitCallback = callback;
      return () => { commitCallback = null; };
    },
    enqueue: (targetEnv, input: RuntimeInput) => {
      const tx = input.runtimeTxs[0];
      if (!tx || tx.type !== 'importReplica') throw new Error('TEST_IMPORT_REPLICA_REQUIRED');
      targetEnv.state.eReplicas.set(`${tx.entityId}:${tx.signerId}`, {
        entityId: tx.entityId,
        signerId: tx.signerId,
        state: { entityId: tx.entityId },
      } as EntityReplica);
      targetEnv.state.height += 1;
      queueMicrotask(() => commitCallback?.(targetEnv.state.height));
    },
  });

  try {
    const result = await controller.deriveAndInstall(env, {
      specId: BRAINVAULT_V1_SPEC_ID,
      name: 'alice',
      passphrase: 'secret123456',
      shardInput: 1,
      workers: 1,
    }, { signal: new AbortController().signal, onProgress: () => undefined });
    expect(result.ethereumAddress).toBe('0x93bAb14eD871462D414a7c0357BF1a76DE741397');
    expect('mnemonic24' in result).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(durabilityBoundaries).toEqual([
      'after-file-write',
      'after-file-sync',
      'after-file-rename',
      'before-parent-dir-sync',
      'after-parent-dir-sync',
    ]);
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([
      `owner.json.${process.pid}.tmp`,
    ]);
    expect((await controller.revealMnemonic()).mnemonic24).toStartWith('milk click novel');
    const restartedEnv = makeOwnerEnv();
    expect(await controller.prewarm(String(restartedEnv.runtimeSeed))).toBe(true);
    expect((await controller.restore(restartedEnv))?.created).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('node owner retries both file and directory durability failures before install', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-brainvault-owner-retry-'));
  const path = join(directory, 'owner.json');
  const env = makeOwnerEnv();
  let failNextFileSync = true;
  let failNextDirectorySync = true;
  let directorySyncAttempts = 0;
  let enqueueCount = 0;
  let commitCallback: ((height: number) => void) | null = null;
  const controller = createBrainVaultOwnerController({
    path,
    profileName: 'retry owner',
    timeoutMs: 2_000,
    durability: {
      syncFile: async handle => {
        if (failNextFileSync) {
          failNextFileSync = false;
          throw Object.assign(new Error('injected owner sync failure'), { code: 'EIO' });
        }
        await handle.sync();
      },
      syncDirectory: async handle => {
        directorySyncAttempts += 1;
        if (failNextDirectorySync) {
          failNextDirectorySync = false;
          throw Object.assign(new Error('injected owner directory sync failure'), { code: 'EIO' });
        }
        await handle.sync();
      },
    },
    onFrameCommit: (_env, callback) => {
      commitCallback = callback;
      return () => { commitCallback = null; };
    },
    enqueue: (targetEnv, input) => {
      enqueueCount += 1;
      const tx = input.runtimeTxs[0];
      if (!tx || tx.type !== 'importReplica') throw new Error('TEST_IMPORT_REPLICA_REQUIRED');
      targetEnv.state.eReplicas.set(`${tx.entityId}:${tx.signerId}`, {
        entityId: tx.entityId,
        signerId: tx.signerId,
        state: { entityId: tx.entityId },
      } as EntityReplica);
      targetEnv.state.height += 1;
      queueMicrotask(() => commitCallback?.(targetEnv.state.height));
    },
  });
  const input = {
    specId: BRAINVAULT_V1_SPEC_ID,
    name: 'alice',
    passphrase: 'secret123456',
    shardInput: 1,
    workers: 1,
  } as const;
  const options = { signal: new AbortController().signal, onProgress: () => undefined };

  try {
    await expect(controller.deriveAndInstall(env, input, options)).rejects.toThrow('injected owner sync failure');
    expect(enqueueCount).toBe(0);
    expect(existsSync(path)).toBeFalse();
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);

    await expect(controller.deriveAndInstall(env, input, options))
      .rejects.toThrow('STORAGE_PARENT_DIR_FSYNC_FAILED:code=EIO');
    expect(enqueueCount).toBe(0);
    expect(existsSync(path)).toBeTrue();
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);

    expect((await controller.deriveAndInstall(env, input, options)).created).toBe(true);
    expect(enqueueCount).toBe(1);
    expect(directorySyncAttempts).toBe(2);
    expect(existsSync(path)).toBeTrue();
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('startup restore excludes a concurrent owner derivation before KDF work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-brainvault-owner-race-'));
  const path = join(directory, 'owner.json');
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    specId: BRAINVAULT_V1_SPEC_ID,
    mnemonic24: 'milk click novel require across cousin good chair street mouse crash movie same daughter air quote total pride crop mention focus sick slice hole',
    ethereumAddress: '0x93bab14ed871462d414a7c0357bf1a76de741397',
  })}\n`, { mode: 0o600 });
  const env = makeOwnerEnv();
  let commitCallback: ((height: number) => void) | null = null;
  let releaseCommit: (() => void) | null = null;
  let notifyEnqueued!: () => void;
  const enqueued = new Promise<void>(resolve => { notifyEnqueued = resolve; });
  const controller = createBrainVaultOwnerController({
    path,
    profileName: 'race owner',
    timeoutMs: 2_000,
    onFrameCommit: (_env, callback) => {
      commitCallback = callback;
      return () => { commitCallback = null; };
    },
    enqueue: (targetEnv, input) => {
      const tx = input.runtimeTxs[0];
      if (!tx || tx.type !== 'importReplica') throw new Error('TEST_IMPORT_REPLICA_REQUIRED');
      targetEnv.state.eReplicas.set(`${tx.entityId}:${tx.signerId}`, {
        entityId: tx.entityId,
        signerId: tx.signerId,
        state: { entityId: tx.entityId },
      } as EntityReplica);
      targetEnv.state.height += 1;
      releaseCommit = () => commitCallback?.(targetEnv.state.height);
      notifyEnqueued();
    },
  });

  try {
    const restore = controller.restore(env);
    await enqueued;
    await expect(controller.deriveAndInstall(env, {
      specId: BRAINVAULT_V1_SPEC_ID,
      name: 'another owner',
      passphrase: 'another-secret-123',
      shardInput: 1,
      workers: 1,
    }, { signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toThrow('BRAINVAULT_OWNER_OPERATION_PENDING');
    releaseCommit?.();
    expect((await restore)?.created).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('persisted custody fails closed when directory fsync is unsupported', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-brainvault-owner-unsupported-'));
  const path = join(directory, 'owner.json');
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    specId: BRAINVAULT_V1_SPEC_ID,
    mnemonic24: 'milk click novel require across cousin good chair street mouse crash movie same daughter air quote total pride crop mention focus sick slice hole',
    ethereumAddress: '0x93bab14ed871462d414a7c0357bf1a76de741397',
  })}\n`, { mode: 0o600 });
  const controller = createBrainVaultOwnerController({
    path,
    profileName: 'unsupported fsync owner',
    timeoutMs: 2_000,
    enqueue: () => { throw new Error('TEST_ENQUEUE_FORBIDDEN'); },
    onFrameCommit: () => () => undefined,
    durability: {
      syncDirectory: async () => {
        throw Object.assign(new Error('directory fsync unsupported'), { code: 'EINVAL' });
      },
    },
  });

  try {
    await expect(controller.prewarm('unsupported-fsync-runtime'))
      .rejects.toThrow('BRAINVAULT_OWNER_DIRECTORY_FSYNC_UNSUPPORTED:EINVAL');
    await expect(controller.restore(makeOwnerEnv()))
      .rejects.toThrow('BRAINVAULT_OWNER_DIRECTORY_FSYNC_UNSUPPORTED:EINVAL');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
