import { describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';

import { deriveSignerAddressSync } from '../../../account/crypto';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  loadEnvFromDB,
} from '../../../runtime';
import { createFrameExecutionState } from '../../../runtime/frame/intake/execution-state';
import { handleRuntimeFrameStorageFailure } from '../../../runtime/frame/lifecycle/storage-failure';
import { createRuntimeFrameTransaction } from '../../../runtime/frame/transaction';
import { dbRootPath } from '../../../runtime/replica/platform';
import { ensureRuntimeInfrastructure } from '../../../runtime/envelope/replica-envelope';
import { classifyRuntimeFrameCommitProof } from '../../../storage/commit/commit';

const fixture = join(import.meta.dir, '..', '..', 'fixtures/storage/runtime-storage-timeout-child.ts');

const removeRuntimeStorage = (runtimeId: string): void => {
  const base = join(dbRootPath, runtimeId);
  for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-events', '-infra']) {
    rmSync(`${base}${suffix}`, { recursive: true, force: true });
  }
};

const prepareFrame = (seed: string) => {
  const live = createEmptyEnv(seed);
  live.state.height = 7;
  live.state.timestamp = 700;
  const stopped = { count: 0 };
  ensureRuntimeInfrastructure(live).stopLoop = () => {
    stopped.count += 1;
  };

  const transaction = createRuntimeFrameTransaction(live);
  live.state.height = 8;
  live.state.timestamp = 800;
  const frame = createFrameExecutionState();
  frame.transaction = transaction;
  return { live, transaction, frame, stopped };
};

describe('Runtime WAL storage failure boundary', () => {
  test('requires the exact post Runtime root before classifying a timed-out write', () => {
    const runtimeInput = { runtimeTxs: [], entityInputs: [] };
    const postStateHash = `0x${'11'.repeat(32)}`;

    expect(classifyRuntimeFrameCommitProof(
      { runtimeInput },
      runtimeInput,
      postStateHash,
    )).toBe('unknown');
    expect(classifyRuntimeFrameCommitProof(
      { runtimeInput, postStateHash },
      runtimeInput,
      postStateHash,
    )).toBe('committed');
    expect(classifyRuntimeFrameCommitProof(
      { runtimeInput, postStateHash: `0x${'00'.repeat(32)}` },
      runtimeInput,
      postStateHash,
    )).toBe('conflict');
    expect(classifyRuntimeFrameCommitProof(
      {
        runtimeInput: { runtimeTxs: [], entityInputs: [], timestamp: 1 },
        postStateHash,
      },
      runtimeInput,
      postStateHash,
    )).toBe('conflict');
  });

  test('does not require a full Runtime-machine blob to prove the frame', () => {
    const runtimeInput = { runtimeTxs: [], entityInputs: [] };
    const postStateHash = `0x${'22'.repeat(32)}`;
    expect(classifyRuntimeFrameCommitProof(
      { runtimeInput, postStateHash },
      runtimeInput,
      postStateHash,
    )).toBe('committed');
  });

  test('leaves a known-undurable in-place frame for the failure path to halt and reload', async () => {
    const { live, transaction, frame, stopped } = prepareFrame('wal-not-committed');

    await handleRuntimeFrameStorageFailure(
      'not-committed',
      new Error('append rejected'),
      live,
      live,
      frame,
    );

    // The owned Runtime has already mutated. This helper only classifies WAL
    // durability; the enclosing frame failure path halts and restores input.
    // Rolling State back here would reintroduce the deleted shadow Runtime.
    expect(live.state.height).toBe(8);
    expect(transaction.published).toBe(false);
    expect(frame.commitDisposition).toBe('undurable');
    expect(stopped.count).toBe(0);
  });

  test('installs a proven durable frame before halting', async () => {
    const { live, transaction, frame, stopped } = prepareFrame('wal-committed');

    await handleRuntimeFrameStorageFailure(
      'committed',
      new Error('post-commit confirmation failed'),
      live,
      live,
      frame,
    );

    expect(live.state.height).toBe(8);
    expect(live.state.timestamp).toBe(800);
    expect(transaction.published).toBe(true);
    expect(frame.commitDisposition).toBe('committed');
    expect(ensureRuntimeInfrastructure(live).lifecyclePhase).toBe('halted');
    expect(ensureRuntimeInfrastructure(live).fatalDebugPayload?.height).toBe(8);
    expect(stopped.count).toBe(1);
  });

  test('halts the mutated Runtime when WAL durability is unknown', async () => {
    const { live, transaction, frame, stopped } = prepareFrame('wal-unknown');

    await handleRuntimeFrameStorageFailure(
      'unknown',
      new Error('append confirmation timed out'),
      live,
      live,
      frame,
    );

    expect(live.state.height).toBe(8);
    expect(live.state.timestamp).toBe(800);
    expect(transaction.published).toBe(false);
    expect(frame.commitDisposition).toBe('unknown');
    expect(ensureRuntimeInfrastructure(live).lifecyclePhase).toBe('halted');
    expect(ensureRuntimeInfrastructure(live).fatalDebugPayload?.height).toBe(8);
    expect(stopped.count).toBe(1);
  });

  test('rejects a conflicting durable frame without installing the candidate', async () => {
    const { live, transaction, frame, stopped } = prepareFrame('wal-conflict');

    await handleRuntimeFrameStorageFailure(
      'conflict',
      new Error('another frame already owns this height'),
      live,
      live,
      frame,
    );

    expect(live.state.height).toBe(8);
    expect(transaction.published).toBe(false);
    expect(frame.commitDisposition).toBe('conflict');
    expect(ensureRuntimeInfrastructure(live).lifecyclePhase).toBe('halted');
    expect(stopped.count).toBe(1);
  });
});

test('real write timeout makes mutated RAM unreadable until restart loads WAL truth', async () => {
  const seed = `runtime storage timeout ${process.pid} ${Date.now()} deterministic seed`;
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  removeRuntimeStorage(runtimeId);

  const child = Bun.spawn({
    cmd: [process.execPath, fixture, seed],
    cwd: join(import.meta.dir, '..', '..', '..', '..'),
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
  expect(result.height).toBe(2);
  expect(result.lifecycle).toBe('halted');
  expect(result.fatalHeight).toBe(2);

  const restored = await loadEnvFromDB(runtimeId, seed);
  if (!restored) throw new Error('timeout fixture did not leave durable Runtime state');
  try {
    expect(restored.state.height).toBe(2);
  } finally {
    await closeRuntimeDb(restored);
    await closeInfraDb(restored);
    removeRuntimeStorage(runtimeId);
  }
}, 30_000);
