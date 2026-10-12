import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { deriveSignerAddressSync } from '../../../account/crypto';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  getRuntimeStorageDb,
  getRuntimeWalDb,
  loadEnvFromDB,
  loadEnvFromStorageByReplay,
  persistRestoredEnvToDB,
  saveEnvToDB,
} from '../../../runtime';
import type { RuntimeReplica } from '../../../runtime/types';
import { dbRootPath } from '../../../runtime/replica/platform';
import {
  computeStorageFrameHash,
  readStorageFramePayloads,
  readStorageFrameRecord,
  recoverStorageDbFromWal,
  resolveStorageRuntimeConfig,
  verifyStorageTailIntegrity,
} from '../../../storage';
import { encodeBuffer } from '../../../storage/codec/codec';
import {
  KEY_HEAD,
  keyFrame,
  keyRscoreAccount,
  keyRscoreAccountRadixLeafNode,
  keyRscoreCheckpoint,
} from '../../../storage/keys';
import { buildRecoveryJournalFromStorageFrame } from '../../../storage/queries/history';
import { assertTypeScriptStorageNamespaces } from '../../../storage/read/native-authority-rejection';
import type { RuntimeFrame, StorageRscoreCheckpointRef } from '../../../storage/types';

const opened: RuntimeReplica[] = [];
const ownerEntityId = `0x${'aa'.repeat(32)}`;
const counterpartyId = `0x${'dd'.repeat(32)}`;
const nativeRef: StorageRscoreCheckpointRef = {
  ownerEntityId,
  protocolFingerprint: `0x${'cc'.repeat(32)}`,
  baseRevision: '0',
  revision: '0',
  accountsRoot: `0x${'00'.repeat(32)}`,
  signerDigest: `0x${'bb'.repeat(32)}`,
  accountCount: 0,
};
const nativeRows = [
  [keyRscoreCheckpoint(ownerEntityId), encodeBuffer({ version: 1, ...nativeRef })],
  [keyRscoreAccount(ownerEntityId, counterpartyId), encodeBuffer([])],
  [keyRscoreAccountRadixLeafNode(ownerEntityId, counterpartyId, 1, Buffer.from([1])), encodeBuffer([])],
] as const;

const savedRuntime = async (): Promise<RuntimeReplica> => {
  const seed = `native-storage-retirement ${process.pid} ${Date.now()} ${opened.length}`;
  const env = createEmptyEnv(seed);
  env.runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  env.dbNamespace = env.runtimeId;
  env.quietRuntimeLogs = true;
  env.state.height = 1;
  env.state.timestamp = 1_000;
  opened.push(env);
  await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [], new Map());
  return env;
};

const close = async (env: RuntimeReplica): Promise<void> => {
  await closeRuntimeDb(env);
  await closeInfraDb(env);
};

const restore = async (env: RuntimeReplica): Promise<RuntimeReplica | null> => {
  const restored = await loadEnvFromDB(env.runtimeId, env.runtimeSeed);
  if (restored) opened.push(restored);
  return restored;
};

const storedFrame = async (env: RuntimeReplica): Promise<RuntimeFrame> => {
  const frame = await readStorageFrameRecord(getRuntimeWalDb(env), 1);
  if (!frame) throw new Error('TEST_FRAME_MISSING');
  return frame;
};

afterEach(async () => {
  const closing = opened.splice(0);
  for (const env of closing) await close(env);
  for (const env of closing) {
    for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-history-views', '-events', '-infra']) {
      rmSync(join(dbRootPath, `${env.runtimeId}${suffix}`), { recursive: true, force: true });
    }
  }
});

for (const [key, value] of nativeRows) {
  test(`TS restore rejects native namespace ${key[0]?.toString(16)} without changing WAL or current`, async () => {
    const env = await savedRuntime();
    const wal = getRuntimeWalDb(env);
    const current = getRuntimeStorageDb(env);
    const walHead = await wal.get(KEY_HEAD);
    const currentHead = await current.get(KEY_HEAD);
    const frameBytes = await wal.get(keyFrame(1));
    await wal.put(key, value);
    await close(env);
    await expect(restore(env)).rejects.toThrow('STORAGE_NATIVE_AUTHORITY_RETIRED');
    await wal.open();
    await current.open();
    try {
      expect(await wal.get(KEY_HEAD)).toEqual(walHead);
      expect(await current.get(KEY_HEAD)).toEqual(currentHead);
      expect(await wal.get(keyFrame(1))).toEqual(frameBytes);
      expect(await wal.get(key)).toEqual(value);
    } finally {
      await wal.close();
      await current.close();
    }
  });
}

test('native frame metadata rejects before journal projection, without dropping its original hash domain', async () => {
  const env = await savedRuntime();
  const wal = getRuntimeWalDb(env);
  const original = await storedFrame(env);
  const payloads = await readStorageFramePayloads(wal, original);
  const nativeFrame = { ...original, accountAuthorityCheckpoints: [nativeRef] };
  const frame = { ...nativeFrame, frameHash: computeStorageFrameHash(nativeFrame) };
  expect(frame.frameHash).not.toBe(original.frameHash);
  expect(() => buildRecoveryJournalFromStorageFrame(frame, payloads)).toThrow('STORAGE_NATIVE_AUTHORITY_RETIRED');
  await wal.put(keyFrame(1), encodeBuffer(frame));
  await expect(readStorageFrameRecord(wal, 1)).rejects.toThrow('STORAGE_NATIVE_AUTHORITY_RETIRED');
  await close(env);
  await expect(restore(env)).rejects.toThrow('STORAGE_NATIVE_AUTHORITY_RETIRED');
});

test('a corrupt native frame fails its original hash before retirement policy', async () => {
  const env = await savedRuntime();
  const wal = getRuntimeWalDb(env);
  const original = await storedFrame(env);
  await wal.put(keyFrame(1), encodeBuffer({ ...original, accountAuthorityCheckpoints: [nativeRef] }));
  await expect(readStorageFrameRecord(wal, 1)).rejects.toThrow('STORAGE_VERIFY_FRAME_HASH_MISMATCH');
});

test('read-only replay rejects native rows instead of suppressing authority', async () => {
  const env = await savedRuntime();
  await getRuntimeWalDb(env).put(...nativeRows[0]);
  await close(env);
  await expect(
    loadEnvFromStorageByReplay(env.runtimeId, env.runtimeSeed, undefined, { readOnly: true }),
  ).rejects.toThrow('STORAGE_NATIVE_AUTHORITY_RETIRED');
});

test('direct recovery validates native frame hashes before clearing a missing current head', async () => {
  const env = await savedRuntime();
  const wal = getRuntimeWalDb(env);
  const current = getRuntimeStorageDb(env);
  const original = await storedFrame(env);
  const nativeFrame = { ...original, accountAuthorityCheckpoints: [nativeRef] };
  await current.del(KEY_HEAD);
  const before = await Array.fromAsync(current.iterator());
  const recover = () => recoverStorageDbFromWal({ db: current, walDb: wal, config: resolveStorageRuntimeConfig(env) });
  await wal.put(keyFrame(1), encodeBuffer(nativeFrame));
  await expect(recover()).rejects.toThrow('STORAGE_VERIFY_FRAME_HASH_MISMATCH');
  expect(await Array.fromAsync(current.iterator())).toEqual(before);
  await wal.put(keyFrame(1), encodeBuffer({ ...nativeFrame, frameHash: computeStorageFrameHash(nativeFrame) }));
  await expect(recover()).rejects.toThrow('STORAGE_NATIVE_AUTHORITY_RETIRED');
  expect(await Array.fromAsync(current.iterator())).toEqual(before);
});

test('unavailable key iteration cannot certify the absence of native rows', async () => {
  const env = await savedRuntime();
  const wal = getRuntimeWalDb(env);
  const descriptor = Object.getOwnPropertyDescriptor(wal, 'keys');
  Object.defineProperty(wal, 'keys', { value: undefined, configurable: true });
  try {
    await expect(assertTypeScriptStorageNamespaces(wal)).rejects.toThrow(
      'STORAGE_NATIVE_AUTHORITY_INSPECTION_UNAVAILABLE',
    );
  } finally {
    if (descriptor) Object.defineProperty(wal, 'keys', descriptor);
    else Reflect.deleteProperty(wal, 'keys');
  }
});

test('native rows prevent a fresh append and portable replacement before any persistence boundary', async () => {
  const env = await savedRuntime();
  const wal = getRuntimeWalDb(env);
  const head = await wal.get(KEY_HEAD);
  const [key, value] = nativeRows[0];
  await wal.put(key, value);
  await close(env);
  const next = createEmptyEnv(env.runtimeSeed);
  next.runtimeId = env.runtimeId;
  next.dbNamespace = env.dbNamespace;
  next.quietRuntimeLogs = true;
  next.state.height = 2;
  next.state.timestamp = 2_000;
  opened.push(next);
  await expect(saveEnvToDB(next, { runtimeTxs: [], entityInputs: [] }, [], new Map())).rejects.toThrow(
    'STORAGE_NATIVE_AUTHORITY_RETIRED',
  );
  const boundaries: string[] = [];
  await expect(
    persistRestoredEnvToDB(next, {
      onPersistenceBoundary: boundary => {
        boundaries.push(boundary);
      },
    }),
  ).rejects.toThrow('STORAGE_NATIVE_AUTHORITY_RETIRED');
  expect(boundaries).toEqual([]);
  expect(await getRuntimeWalDb(next).get(KEY_HEAD)).toEqual(head);
});

test('headless native rows cannot be accepted as a fresh empty WAL', async () => {
  const env = await savedRuntime();
  const wal = getRuntimeWalDb(env);
  await wal.del(KEY_HEAD);
  await wal.put(...nativeRows[0]);
  await expect(verifyStorageTailIntegrity(wal)).rejects.toThrow('STORAGE_NATIVE_AUTHORITY_RETIRED');
});

test('ordinary TS restore retains exact persisted frame bytes and roots', async () => {
  const env = await savedRuntime();
  const before = await getRuntimeWalDb(env).get(keyFrame(1));
  const frame = await storedFrame(env);
  expect(frame.accountAuthorityCheckpoints).toBeUndefined();
  await close(env);
  const restored = await restore(env);
  if (!restored) throw new Error('TEST_TS_RESTORE_MISSING');
  expect(restored.state.height).toBe(1);
  expect(await getRuntimeWalDb(restored).get(keyFrame(1))).toEqual(before);
  expect(await storedFrame(restored)).toEqual(frame);
});
