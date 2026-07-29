import { describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';

import { deriveSignerAddressSync } from '../account/crypto';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  loadEnvFromDB,
} from '../runtime';
import { createFrameExecutionState } from '../runtime/frame/execution-state';
import { handleRuntimeFrameStorageFailure } from '../runtime/frame/storage-failure';
import { createRuntimeFrameTransaction } from '../runtime/frame/transaction';
import { dbRootPath } from '../runtime/platform';
import { ensureRuntimeState } from '../runtime/runtime-state';
import { computeCanonicalStateHashFromEnv } from '../storage/canonical-hash';
import { classifyRuntimeFrameCommitProof } from '../storage/commit';
import { buildDurableRuntimeMachineSnapshot } from '../storage/wal/snapshot';

const fixture = join(import.meta.dir, 'fixtures/runtime-storage-timeout-child.ts');

const removeRuntimeStorage = (runtimeId: string): void => {
  const base = join(dbRootPath, runtimeId);
  for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-events', '-infra']) {
    rmSync(`${base}${suffix}`, { recursive: true, force: true });
  }
};

const prepareFrame = (seed: string) => {
  const live = createEmptyEnv(seed);
  live.height = 7;
  live.timestamp = 700;
  const stopped = { count: 0 };
  ensureRuntimeState(live).stopLoop = () => {
    stopped.count += 1;
  };

  const transaction = createRuntimeFrameTransaction(live);
  transaction.workingEnv.height = 8;
  transaction.workingEnv.timestamp = 800;
  const frame = createFrameExecutionState();
  frame.transaction = transaction;
  return { live, transaction, frame, stopped };
};

describe('Runtime WAL storage failure boundary', () => {
  test('requires complete Runtime proof before classifying a timed-out write as committed', () => {
    const env = createEmptyEnv('wal-commit-proof');
    const runtimeInput = { runtimeTxs: [], entityInputs: [] };
    const runtimeMachine = buildDurableRuntimeMachineSnapshot(env);
    const runtimeStateHash = computeCanonicalStateHashFromEnv(env);

    expect(classifyRuntimeFrameCommitProof(
      { runtimeInput },
      runtimeInput,
      runtimeMachine,
      runtimeStateHash,
    )).toBe('unknown');
    expect(classifyRuntimeFrameCommitProof(
      { runtimeInput, runtimeMachine },
      runtimeInput,
      runtimeMachine,
      runtimeStateHash,
    )).toBe('unknown');
    expect(classifyRuntimeFrameCommitProof(
      { runtimeInput, runtimeMachine, runtimeStateHash },
      runtimeInput,
      runtimeMachine,
      runtimeStateHash,
    )).toBe('committed');
    expect(classifyRuntimeFrameCommitProof(
      { runtimeInput, runtimeMachine, runtimeStateHash: `0x${'00'.repeat(32)}` },
      runtimeInput,
      runtimeMachine,
      runtimeStateHash,
    )).toBe('conflict');
  });

  test('leaves a not-committed candidate for the normal rollback path', async () => {
    const { live, transaction, frame, stopped } = prepareFrame('wal-not-committed');

    await handleRuntimeFrameStorageFailure(
      'not-committed',
      new Error('append rejected'),
      live,
      transaction.workingEnv,
      frame,
    );

    expect(live.height).toBe(7);
    expect(transaction.published).toBe(false);
    expect(frame.commitDisposition).toBe('undurable');
    expect(frame.reliableReceiptStateDurable).toBe(false);
    expect(stopped.count).toBe(0);
  });

  test('installs a proven durable frame before halting', async () => {
    const { live, transaction, frame, stopped } = prepareFrame('wal-committed');

    await handleRuntimeFrameStorageFailure(
      'committed',
      new Error('post-commit confirmation failed'),
      live,
      transaction.workingEnv,
      frame,
    );

    expect(live.height).toBe(8);
    expect(live.timestamp).toBe(800);
    expect(transaction.published).toBe(true);
    expect(frame.commitDisposition).toBe('committed');
    expect(frame.reliableReceiptStateDurable).toBe(true);
    expect(ensureRuntimeState(live).lifecyclePhase).toBe('halted');
    expect(ensureRuntimeState(live).fatalDebugPayload?.height).toBe(8);
    expect(stopped.count).toBe(1);
  });

  test('halts at the last proven frame when WAL durability is unknown', async () => {
    const { live, transaction, frame, stopped } = prepareFrame('wal-unknown');
    let candidateHandleClosed = 0;
    const candidateState = ensureRuntimeState(transaction.workingEnv);
    candidateState.storageDb = {
      close: async () => {
        candidateHandleClosed += 1;
      },
    } as typeof candidateState.storageDb;

    await handleRuntimeFrameStorageFailure(
      'unknown',
      new Error('append confirmation timed out'),
      live,
      transaction.workingEnv,
      frame,
    );

    expect(live.height).toBe(7);
    expect(live.timestamp).toBe(700);
    expect(transaction.published).toBe(false);
    expect(frame.commitDisposition).toBe('unknown');
    expect(frame.reliableReceiptStateDurable).toBe(false);
    expect(ensureRuntimeState(live).lifecyclePhase).toBe('halted');
    expect(ensureRuntimeState(live).fatalDebugPayload?.height).toBe(7);
    expect(candidateHandleClosed).toBe(1);
    expect(stopped.count).toBe(1);
  });

  test('rejects a conflicting durable frame without installing the candidate', async () => {
    const { live, transaction, frame, stopped } = prepareFrame('wal-conflict');

    await handleRuntimeFrameStorageFailure(
      'conflict',
      new Error('another frame already owns this height'),
      live,
      transaction.workingEnv,
      frame,
    );

    expect(live.height).toBe(7);
    expect(transaction.published).toBe(false);
    expect(frame.commitDisposition).toBe('conflict');
    expect(frame.reliableReceiptStateDurable).toBe(false);
    expect(ensureRuntimeState(live).lifecyclePhase).toBe('halted');
    expect(stopped.count).toBe(1);
  });
});

test('real write timeout keeps RAM stale until restart loads WAL truth', async () => {
  const seed = `runtime storage timeout ${process.pid} ${Date.now()} deterministic seed`;
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  removeRuntimeStorage(runtimeId);

  const child = Bun.spawn({
    cmd: [process.execPath, fixture, seed],
    cwd: join(import.meta.dir, '..', '..'),
    env: { ...process.env, XLN_DB_PATH: dbRootPath },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

  const resultLine = stdout.split('\n').find(line => line.startsWith('STORAGE_TIMEOUT_RESULT:'));
  if (!resultLine) throw new Error(`timeout fixture result missing:\n${stdout}\n${stderr}`);
  const result = JSON.parse(resultLine.slice('STORAGE_TIMEOUT_RESULT:'.length)) as {
    failure: string;
    height: number;
    lifecycle: string;
    fatalHeight: number;
  };
  expect(result.failure).toContain('RUNTIME_FRAME_STORAGE_UNKNOWN');
  expect(result.height).toBe(1);
  expect(result.lifecycle).toBe('halted');
  expect(result.fatalHeight).toBe(1);

  const restored = await loadEnvFromDB(runtimeId, seed);
  if (!restored) throw new Error('timeout fixture did not leave durable Runtime state');
  try {
    expect(restored.height).toBe(2);
  } finally {
    await closeRuntimeDb(restored);
    await closeInfraDb(restored);
    removeRuntimeStorage(runtimeId);
  }
}, 30_000);
