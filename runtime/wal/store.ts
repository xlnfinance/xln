import { deserializeTaggedJson, serializeTaggedJson } from '../serialization-utils';
import type { FrameLogEntry, RuntimeInput } from '../types';

export type RuntimeWalDb = {
  get: (key: Buffer) => Promise<Buffer>;
};

export type RuntimeWalBatch = {
  put: (key: Buffer, value: Buffer) => RuntimeWalBatch;
  write: () => Promise<void>;
};

export type RuntimeWalWritableDb = RuntimeWalDb & {
  put: (key: Buffer, value: Buffer) => Promise<void>;
  batch: () => RuntimeWalBatch;
};

export type RuntimeWalPutOp = {
  key: Buffer;
  value: Buffer;
};

export type PersistedFrameJournal = {
  height: number;
  timestamp: number;
  runtimeInput: RuntimeInput;
  runtimeStateHash?: string;
  logs: FrameLogEntry[];
};

const makeDbKey = (namespace: string, key: string): Buffer => Buffer.from(`${namespace}:${key}`);

export const encodePersistedFrameJournal = (frame: PersistedFrameJournal): string => {
  return serializeTaggedJson(frame);
};

export const decodePersistedFrameJournal = (
  payload: string,
  fallbackHeight: number,
): PersistedFrameJournal | null => {
  const decoded = deserializeTaggedJson<PersistedFrameJournal>(payload);
  if (!decoded || typeof decoded !== 'object') return null;
  const runtimeInput =
    decoded.runtimeInput && typeof decoded.runtimeInput === 'object'
      ? decoded.runtimeInput
      : { runtimeTxs: [], entityInputs: [] };
  const logs = Array.isArray(decoded.logs) ? decoded.logs : [];
  return {
    height:
      Number.isFinite(Number(decoded.height)) && Number(decoded.height) > 0
        ? Math.floor(Number(decoded.height))
        : fallbackHeight,
    timestamp: Number.isFinite(Number(decoded.timestamp)) ? Number(decoded.timestamp) : 0,
    runtimeInput,
    runtimeStateHash: typeof decoded.runtimeStateHash === 'string' ? decoded.runtimeStateHash : undefined,
    logs,
  };
};

export const readPersistedSchemaVersion = async (
  db: RuntimeWalDb,
  namespace: string,
): Promise<number> => {
  const buffer = await db.get(makeDbKey(namespace, 'persistence_schema_version'));
  return Number.parseInt(buffer.toString(), 10);
};

export const readPersistedLatestHeight = async (
  db: RuntimeWalDb,
  namespace: string,
): Promise<number> => {
  const buffer = await db.get(makeDbKey(namespace, 'latest_height'));
  return Number.parseInt(buffer.toString(), 10);
};

export const readPersistedCheckpointHeight = async (
  db: RuntimeWalDb,
  namespace: string,
): Promise<number> => {
  const buffer = await db.get(makeDbKey(namespace, 'latest_checkpoint_height'));
  return Number.parseInt(buffer.toString(), 10);
};

export const readPersistedSnapshotBuffer = async (
  db: RuntimeWalDb,
  namespace: string,
  height: number,
): Promise<Buffer> => {
  return db.get(makeDbKey(namespace, `snapshot:${height}`));
};

export const readPersistedFrameJournalBuffer = async (
  db: RuntimeWalDb,
  namespace: string,
  height: number,
): Promise<Buffer> => {
  return db.get(makeDbKey(namespace, `frame_input:${height}`));
};

export const buildPersistedFrameWriteOps = (options: {
  namespace: string;
  schemaVersion: number;
  height: number;
  frameJournal: string;
  checkpointSnapshot?: string;
}): RuntimeWalPutOp[] => {
  const ops: RuntimeWalPutOp[] = [
    {
      key: makeDbKey(options.namespace, 'persistence_schema_version'),
      value: Buffer.from(String(options.schemaVersion)),
    },
    {
      key: makeDbKey(options.namespace, `frame_input:${options.height}`),
      value: Buffer.from(options.frameJournal),
    },
  ];
  if (options.checkpointSnapshot !== undefined) {
    ops.push(
      {
        key: makeDbKey(options.namespace, `snapshot:${options.height}`),
        value: Buffer.from(options.checkpointSnapshot),
      },
      {
        key: makeDbKey(options.namespace, 'latest_checkpoint_height'),
        value: Buffer.from(String(options.height)),
      },
    );
  }
  // Pointer last: only advance latest_height after all frame data is durable.
  ops.push({
    key: makeDbKey(options.namespace, 'latest_height'),
    value: Buffer.from(String(options.height)),
  });
  return ops;
};

export const writePersistedWalOps = async (
  db: RuntimeWalWritableDb,
  ops: RuntimeWalPutOp[],
): Promise<void> => {
  const batch = db.batch();
  for (const op of ops) {
    batch.put(op.key, op.value);
  }
  await batch.write();
};

export const writePersistedWalOpsSequential = async (
  db: RuntimeWalWritableDb,
  ops: RuntimeWalPutOp[],
): Promise<void> => {
  for (const op of ops) {
    await db.put(op.key, op.value);
  }
};

export const verifyPersistedFrameWrite = async (
  db: RuntimeWalDb,
  namespace: string,
  height: number,
): Promise<number> => {
  await readPersistedFrameJournalBuffer(db, namespace, height);
  return readPersistedLatestHeight(db, namespace);
};
