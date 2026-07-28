import { describe, expect, test } from 'bun:test';
import {
  assertRuntimeFrameStorageState,
  reconcileRuntimeFrameSharedState,
  type RuntimeFrameSharedStateGroup,
  type RuntimeFrameSharedStateSnapshot,
} from '../runtime/runtime-frame-shared-state';
import { createEmptyEnv } from '../runtime';
import {
  abortRuntimeFrameTransaction,
  createRuntimeFrameTransaction,
} from '../runtime/frame/transaction';

const CURRENT_GROUP: readonly RuntimeFrameSharedStateGroup[] = [{
  name: 'storage-current',
  keys: ['storageDb', 'storageDbOpenPromise'],
}];

const snapshot = (
  state: Record<string, unknown>,
  keys: readonly string[],
): Map<string, RuntimeFrameSharedStateSnapshot> =>
  new Map(keys.map((key) => [
    key,
    {
      present: Object.prototype.hasOwnProperty.call(state, key),
      value: state[key],
    },
  ]));

describe('runtime frame shared storage ownership', () => {
  test('abort closes candidate-only DB handles and preserves live handles', async () => {
    const env = createEmptyEnv('runtime-frame-candidate-db-abort');
    const closed: string[] = [];
    const liveHandle = { close: () => closed.push('live') };
    env.runtimeState!.storageDb = liveHandle as never;
    env.runtimeState!.storageDbOpenPromise = Promise.resolve(true);
    const transaction = createRuntimeFrameTransaction(env);
    const candidateStorage = { close: () => closed.push('candidate-storage') };
    const candidateFrames = { close: () => closed.push('candidate-wal') };
    transaction.workingEnv.runtimeState!.storageDb = candidateStorage as never;
    transaction.workingEnv.runtimeState!.storageDbOpenPromise = Promise.resolve(true);
    transaction.workingEnv.runtimeState!.runtimeWalDb = candidateFrames as never;
    transaction.workingEnv.runtimeState!.runtimeWalDbOpenPromise = Promise.resolve(true);

    expect(await abortRuntimeFrameTransaction(transaction)).toEqual([]);
    expect(closed).toEqual(['candidate-storage', 'candidate-wal']);
    expect(env.runtimeState?.storageDb).toBe(liveHandle);
  });

  test('publishes a working handle and its matching open promise atomically', () => {
    const handleA = { status: 'open', id: 'A' };
    const handleB = { status: 'open', id: 'B' };
    const promiseA = Promise.resolve(true);
    const promiseB = Promise.resolve(true);
    const keys = new Set(CURRENT_GROUP[0]!.keys);
    const baseline = snapshot({ storageDb: handleA, storageDbOpenPromise: promiseA }, [...keys]);

    const selected = reconcileRuntimeFrameSharedState(
      baseline,
      { storageDb: handleA, storageDbOpenPromise: promiseA },
      { storageDb: handleB, storageDbOpenPromise: promiseB },
      keys,
      CURRENT_GROUP,
    );

    expect(selected.get('storageDb')).toEqual({ present: true, value: handleB });
    expect(selected.get('storageDbOpenPromise')).toEqual({ present: true, value: promiseB });
  });

  test('rejects divergent live and working replacements as one handle-group conflict', () => {
    const handleA = { status: 'open', id: 'A' };
    const handleB = { status: 'open', id: 'B' };
    const handleC = { status: 'open', id: 'C' };
    const promiseA = Promise.resolve(true);
    const promiseB = Promise.resolve(true);
    const promiseC = Promise.resolve(true);
    const keys = new Set(CURRENT_GROUP[0]!.keys);
    const baseline = snapshot({ storageDb: handleA, storageDbOpenPromise: promiseA }, [...keys]);

    expect(() => reconcileRuntimeFrameSharedState(
      baseline,
      { storageDb: handleC, storageDbOpenPromise: promiseC },
      { storageDb: handleB, storageDbOpenPromise: promiseB },
      keys,
      CURRENT_GROUP,
    )).toThrow('RUNTIME_FRAME_SHARED_STATE_CONFLICT:storage-current');
  });

  test('preserves a concurrent live deletion when the working pair is unchanged', () => {
    const handleA = { status: 'open', id: 'A' };
    const promiseA = Promise.resolve(true);
    const keys = new Set(CURRENT_GROUP[0]!.keys);
    const baseline = snapshot({ storageDb: handleA, storageDbOpenPromise: promiseA }, [...keys]);

    const selected = reconcileRuntimeFrameSharedState(
      baseline,
      { storageDb: null, storageDbOpenPromise: null },
      { storageDb: handleA, storageDbOpenPromise: promiseA },
      keys,
      CURRENT_GROUP,
    );

    expect(selected.get('storageDb')).toEqual({ present: true, value: null });
    expect(selected.get('storageDbOpenPromise')).toEqual({ present: true, value: null });
  });

  test('rejects promise-without-handle, closed handles and current/previous aliasing', () => {
    expect(() => assertRuntimeFrameStorageState({
      storageDb: null,
      storageDbOpenPromise: Promise.resolve(true),
    })).toThrow('RUNTIME_FRAME_STORAGE_HANDLE_PAIR_INVALID:storage-current');

    expect(() => assertRuntimeFrameStorageState({
      storageDb: { status: 'closed' },
      storageDbOpenPromise: null,
    })).toThrow('RUNTIME_FRAME_STORAGE_HANDLE_STATUS_INVALID:storage-current:closed');

    const aliased = { status: 'open' };
    expect(() => assertRuntimeFrameStorageState({
      storageDb: aliased,
      storageDbOpenPromise: Promise.resolve(true),
      storagePreviousDb: aliased,
      storagePreviousDbOpenPromise: Promise.resolve(true),
    })).toThrow('RUNTIME_FRAME_STORAGE_HANDLE_ALIAS:storage-current:storage-previous');
  });
});
