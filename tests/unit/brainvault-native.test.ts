import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  const controller = createBrainVaultOwnerController({
    path,
    profileName: 'test owner',
    timeoutMs: 2_000,
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
    expect((await controller.revealMnemonic()).mnemonic24).toStartWith('milk click novel');
    const restartedEnv = makeOwnerEnv();
    expect(await controller.prewarm(String(restartedEnv.runtimeSeed))).toBe(true);
    expect((await controller.restore(restartedEnv))?.created).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
