import { deserializeTaggedJson, serializeTaggedJson } from '../serialization-utils';
import type { FrameLogEntry, RuntimeInput } from '../types';

export type RuntimeWalDb = {
  get: (key: Buffer) => Promise<Buffer>;
  keys?: (options?: {
    gte?: Buffer;
    gt?: Buffer;
    lte?: Buffer;
    lt?: Buffer;
  }) => AsyncIterable<Buffer | Uint8Array | string>;
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

export const listPersistedSnapshotHeightsFromDb = async (
  db: RuntimeWalDb,
  namespace: string,
  latestHeight: number,
  isDbNotFound: (error: unknown) => boolean,
): Promise<number[]> => {
  if (typeof db.keys === 'function') {
    const prefix = `${namespace}:snapshot:`;
    const start = Buffer.from(prefix);
    const end = Buffer.from(`${prefix}\xff`);
    const heights: number[] = [];
    for await (const rawKey of db.keys({ gte: start, lt: end })) {
      const key = Buffer.isBuffer(rawKey)
        ? rawKey.toString()
        : rawKey instanceof Uint8Array
          ? Buffer.from(rawKey).toString()
          : String(rawKey);
      const heightRaw = key.slice(prefix.length);
      const height = Number.parseInt(heightRaw, 10);
      if (Number.isFinite(height) && height > 0 && height <= latestHeight) {
        heights.push(height);
      }
    }
    heights.sort((left, right) => left - right);
    return heights;
  }

  const heights: number[] = [];
  for (let height = 1; height <= latestHeight; height += 1) {
    try {
      await readPersistedSnapshotBuffer(db, namespace, height);
      heights.push(height);
    } catch (error) {
      if (isDbNotFound(error)) continue;
      throw error;
    }
  }
  return heights;
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

export const verifyPersistedFrameWrite = async (
  db: RuntimeWalDb,
  namespace: string,
  height: number,
): Promise<number> => {
  await readPersistedFrameJournalBuffer(db, namespace, height);
  return readPersistedLatestHeight(db, namespace);
};

export const getPersistedLatestHeightFromDb = async (
  db: RuntimeWalDb,
  namespace: string,
  isDbUnavailableError: (error: unknown) => boolean,
): Promise<number> => {
  try {
    const latestHeight = await readPersistedLatestHeight(db, namespace);
    return Number.isFinite(latestHeight) && latestHeight > 0 ? latestHeight : 0;
  } catch (error) {
    if (isDbUnavailableError(error)) return 0;
    throw error;
  }
};

export const readPersistedFrameJournalFromDb = async (
  db: RuntimeWalDb,
  namespace: string,
  height: number,
  isDbUnavailableError: (error: unknown) => boolean,
): Promise<PersistedFrameJournal | null> => {
  const targetHeight = Number.isFinite(height) ? Math.floor(height) : 0;
  if (targetHeight <= 0) return null;
  try {
    const frameBuffer = await readPersistedFrameJournalBuffer(db, namespace, targetHeight);
    return decodePersistedFrameJournal(frameBuffer.toString(), targetHeight);
  } catch (error) {
    if (isDbUnavailableError(error)) return null;
    const code = String((error as { code?: unknown })?.code ?? '');
    const name = String((error as { name?: unknown })?.name ?? '');
    if (code === 'LEVEL_NOT_FOUND' || name === 'NotFoundError') return null;
    throw error;
  }
};
