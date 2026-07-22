import { describe, expect, test } from 'bun:test';

import {
  STORAGE_MAX_PHYSICAL_VALUE_BYTES,
  withRebranchedValues,
} from '../storage/rebranched-db';
import type { RuntimeDbLike } from '../storage/types';

class MemoryDb implements RuntimeDbLike {
  readonly rows = new Map<string, Buffer>();
  putCount = 0;
  delCount = 0;

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
          if (operation.kind === 'put') {
            this.putCount += 1;
            this.rows.set(operation.key.toString('hex'), Buffer.from(operation.value));
          } else {
            this.delCount += 1;
            this.rows.delete(operation.key.toString('hex'));
          }
        }
      },
    };
  }

  async *keys(options?: { gte?: Buffer; lt?: Buffer; reverse?: boolean }): AsyncIterable<Buffer> {
    const keys = Array.from(this.rows.keys(), (key) => Buffer.from(key, 'hex'))
      .filter((key) => !options?.gte || Buffer.compare(key, options.gte) >= 0)
      .filter((key) => !options?.lt || Buffer.compare(key, options.lt) < 0)
      .sort(Buffer.compare);
    if (options?.reverse) keys.reverse();
    yield* keys;
  }
}

describe('path-addressed rebranched LevelDB values', () => {
  test('round-trips a real fat-account-sized value while every physical value stays under 10 KiB', async () => {
    const raw = new MemoryDb();
    const db = withRebranchedValues(raw);
    const key = Buffer.from([0x22, 0x01]);
    const value = Buffer.alloc(637_057);
    for (let index = 0; index < value.length; index += 1) value[index] = index % 251;

    const batch = db.batch();
    batch.put(key, value);
    await batch.write({ sync: true });

    expect(await db.get(key)).toEqual(value);
    expect(Math.max(...Array.from(raw.rows.values(), row => row.byteLength))).toBeLessThan(
      STORAGE_MAX_PHYSICAL_VALUE_BYTES,
    );
    expect(raw.rows.size).toBeGreaterThan(100);

    const logicalKeys: string[] = [];
    for await (const logicalKey of db.keys!()) logicalKeys.push(Buffer.from(logicalKey).toString('hex'));
    expect(logicalKeys).toEqual([key.toString('hex')]);
  });

  test('fails loudly when one Patricia leaf is corrupted', async () => {
    const raw = new MemoryDb();
    const db = withRebranchedValues(raw);
    const key = Buffer.from([0x22, 0x02]);
    const value = Buffer.alloc(24_000, 0x5a);
    const batch = db.batch();
    batch.put(key, value);
    await batch.write();

    const leafKey = Array.from(raw.rows.keys()).find((candidate) => candidate.startsWith('7e'))!;
    raw.rows.get(leafKey)![0] ^= 0xff;
    await expect(db.get(key)).rejects.toThrow('STORAGE_REBRANCH_');
  });

  test('overwrites in place and atomically reclaims every physical node on delete', async () => {
    const sourceRaw = new MemoryDb();
    const source = withRebranchedValues(sourceRaw);
    const key = Buffer.from([0x22, 0x03]);
    await source.put!(key, Buffer.alloc(24_000, 0x11));
    const firstPhysicalRows = sourceRaw.rows.size;
    const changed = Buffer.alloc(24_000, 0x11);
    changed[0] = 0x22;
    sourceRaw.putCount = 0;
    await source.put!(key, changed);
    expect(sourceRaw.rows.size).toBe(firstPhysicalRows);
    expect(sourceRaw.putCount).toBeLessThan(firstPhysicalRows);

    const rotatedRaw = new MemoryDb();
    const rotated = withRebranchedValues(rotatedRaw);
    for await (const logicalKey of source.keys!()) {
      const normalizedKey = Buffer.from(logicalKey);
      await rotated.put!(normalizedKey, await source.get(normalizedKey));
    }
    expect(await rotated.get(key)).toEqual(changed);
    expect(rotatedRaw.rows.size).toBe(firstPhysicalRows);

    const deletion = source.batch();
    deletion.del!(key);
    await deletion.write();
    expect(sourceRaw.rows.size).toBe(0);
  });

  test('collapses and grows strictly at the 10,000-byte boundary', async () => {
    const raw = new MemoryDb();
    const db = withRebranchedValues(raw);
    const key = Buffer.from([0x23, 0x04]);
    const large = Buffer.alloc(STORAGE_MAX_PHYSICAL_VALUE_BYTES, 0x44);
    await db.put!(key, large);
    expect(raw.rows.size).toBeGreaterThan(1);

    const inline = Buffer.alloc(STORAGE_MAX_PHYSICAL_VALUE_BYTES - 1, 0x33);
    await db.put!(key, inline);
    expect(raw.rows.size).toBe(1);
    expect(await db.get(key)).toEqual(inline);

    await db.put!(key, large);
    expect(raw.rows.size).toBeGreaterThan(1);
    expect(await db.get(key)).toEqual(large);
  });
});
