import { describe, expect, test } from 'bun:test';

import {
  STORAGE_MAX_PHYSICAL_VALUE_BYTES,
  withChunkedValues,
} from '../storage/chunked-db';
import type { RuntimeDbLike } from '../storage/types';

class MemoryDb implements RuntimeDbLike {
  readonly rows = new Map<string, Buffer>();

  async get(key: Buffer): Promise<Buffer> {
    const value = this.rows.get(key.toString('hex'));
    if (!value) {
      const error = new Error('NotFound') as Error & { code?: string };
      error.code = 'LEVEL_NOT_FOUND';
      throw error;
    }
    return Buffer.from(value);
  }

  batch() {
    const operations: Array<{ kind: 'put'; key: Buffer; value: Buffer } | { kind: 'del'; key: Buffer }> = [];
    return {
      put: (key: Buffer, value: Buffer) => operations.push({ kind: 'put', key, value }),
      del: (key: Buffer) => operations.push({ kind: 'del', key }),
      write: async () => {
        for (const operation of operations) {
          if (operation.kind === 'put') this.rows.set(operation.key.toString('hex'), Buffer.from(operation.value));
          else this.rows.delete(operation.key.toString('hex'));
        }
      },
    };
  }

  async *keys(): AsyncIterable<Buffer> {
    for (const key of Array.from(this.rows.keys()).sort()) yield Buffer.from(key, 'hex');
  }
}

describe('chunked LevelDB values', () => {
  test('round-trips a real fat-account-sized value while every physical value stays under 10 KiB', async () => {
    const raw = new MemoryDb();
    const db = withChunkedValues(raw);
    const key = Buffer.from([0x22, 0x01]);
    const value = Buffer.alloc(637_057);
    for (let index = 0; index < value.length; index += 1) value[index] = index % 251;

    const batch = db.batch();
    batch.put(key, value);
    await batch.write({ sync: true });

    expect(await db.get(key)).toEqual(value);
    expect(Math.max(...Array.from(raw.rows.values(), row => row.byteLength))).toBeLessThanOrEqual(
      STORAGE_MAX_PHYSICAL_VALUE_BYTES,
    );
    expect(raw.rows.size).toBeGreaterThan(100);

    const logicalKeys: string[] = [];
    for await (const logicalKey of db.keys!()) logicalKeys.push(Buffer.from(logicalKey).toString('hex'));
    expect(logicalKeys).toEqual([key.toString('hex')]);
  });

  test('fails loudly when one chunk is corrupted', async () => {
    const raw = new MemoryDb();
    const db = withChunkedValues(raw);
    const key = Buffer.from([0x22, 0x02]);
    const value = Buffer.alloc(24_000, 0x5a);
    const batch = db.batch();
    batch.put(key, value);
    await batch.write();

    const chunkKey = Array.from(raw.rows.keys()).find((candidate) => candidate.startsWith('7e'))!;
    raw.rows.get(chunkKey)![0] ^= 0xff;
    await expect(db.get(key)).rejects.toThrow('STORAGE_CHUNK_CHECKSUM_MISMATCH');
  });
});
