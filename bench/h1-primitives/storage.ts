import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Level } from 'level';
import type { StorageMeasurement, StorageMode } from './types';

const VALUE_BYTES_PER_PAYMENT = 5_120;

const writeU32 = (target: Uint8Array, offset: number, value: number): void => {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value, false);
};

const paymentValue = (paymentId: number): Uint8Array => {
  const value = new Uint8Array(VALUE_BYTES_PER_PAYMENT);
  for (let offset = 0; offset < value.length; offset += 32) {
    writeU32(value, offset, paymentId);
    writeU32(value, offset + 4, offset);
    value[offset + 8] = (paymentId + offset) & 0xff;
  }
  return value;
};

const directoryBytes = async (path: string): Promise<number> => {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await directoryBytes(child) : (await stat(child)).size;
  }
  return total;
};

export const measureLevelDb = async (
  payments: number,
  batchSize: number,
  mode: StorageMode,
): Promise<StorageMeasurement> => {
  const path = await mkdtemp(join(tmpdir(), 'xln-h1-primitives-'));
  const db = new Level<string, Uint8Array>(path, {
    keyEncoding: 'utf8',
    valueEncoding: 'view',
    compression: false,
  });
  const sync = mode === 'leveldb-fsync';
  let batches = 0;
  const startedAt = performance.now();
  try {
    for (let start = 0; start < payments; start += batchSize) {
      const end = Math.min(payments, start + batchSize);
      const operations: Array<
        | { type: 'put'; key: string; value: Uint8Array }
      > = [];
      for (let paymentId = start; paymentId < end; paymentId += 1) {
        operations.push({
          type: 'put',
          key: `payment:${String(paymentId).padStart(10, '0')}`,
          value: paymentValue(paymentId),
        });
      }
      const head = new Uint8Array(16);
      writeU32(head, 0, batches + 1);
      writeU32(head, 4, end);
      operations.push({ type: 'put', key: 'head', value: head });
      await db.batch(operations, { sync });
      batches += 1;
    }
    const wallMs = performance.now() - startedAt;
    await db.close();
    const diskBytes = await directoryBytes(path);
    return {
      mode,
      payments,
      batchSize,
      batches,
      valueBytesPerPayment: VALUE_BYTES_PER_PAYMENT,
      logicalBytes: payments * VALUE_BYTES_PER_PAYMENT,
      diskBytes,
      wallMs,
      tps: payments * 1_000 / wallMs,
    };
  } finally {
    if (db.status === 'open' || db.status === 'opening') await db.close();
    await rm(path, { recursive: true, force: true });
  }
};
