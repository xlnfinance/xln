import { describe, expect, test } from 'bun:test';

import {
  MAX_PHYSICAL_STORAGE_VALUE_BYTES,
  deleteBoundedStorageValue,
  prepareBoundedStorageValueRows,
  readBoundedEncodedValue,
  readBoundedValidatedValue,
} from '../../../storage/codec/bounded-value';
import { decodeBuffer, encodeBuffer } from '../../../storage/codec/codec';
import { keyBoundedValueChunk } from '../../../storage/keys';
import type { RuntimeDbLike } from '../../../storage/types';

const makeMemoryDb = (rows: ReadonlyArray<Readonly<{ key: Buffer; value: Buffer }>>) => {
  const store = new Map(rows.map(row => [row.key.toString('hex'), Buffer.from(row.value)]));
  const db: RuntimeDbLike = {
    get: async (key: Buffer) => {
      const value = store.get(key.toString('hex'));
      if (value) return Buffer.from(value);
      const error = new Error('NotFound') as Error & { code?: string; notFound?: boolean };
      error.code = 'LEVEL_NOT_FOUND';
      error.notFound = true;
      throw error;
    },
    batch: () => {
      const ops: Array<Readonly<{ type: 'put'; key: Buffer; value: Buffer } | Readonly<{
        type: 'del'; key: Buffer;
      }>>> = [];
      return {
        put: (key: Buffer, value: Buffer) => {
          ops.push({ type: 'put', key: Buffer.from(key), value: Buffer.from(value) });
        },
        del: (key: Buffer) => {
          ops.push({ type: 'del', key: Buffer.from(key) });
        },
        write: async () => {
          for (const op of ops) {
            if (op.type === 'put') store.set(op.key.toString('hex'), op.value);
            else store.delete(op.key.toString('hex'));
          }
        },
      };
    },
  };
  return { db, store };
};

describe('bounded physical storage values', () => {
  test('keeps small MessagePack values raw and reconstructs large values from static owner pages', async () => {
    const ownerKey = Buffer.from([0x10, 0, 0, 0, 1]);
    const small = encodeBuffer({ value: 'small' });
    expect(prepareBoundedStorageValueRows(ownerKey, small)).toEqual([{ key: ownerKey, value: small }]);

    const expected = { bytes: Buffer.alloc(27_000, 0x5a), label: 'large' };
    const encoded = encodeBuffer(expected);
    const rows = prepareBoundedStorageValueRows(ownerKey, encoded);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every(row => row.value.byteLength < MAX_PHYSICAL_STORAGE_VALUE_BYTES)).toBe(true);
    expect(rows[1]?.key).toEqual(keyBoundedValueChunk(ownerKey, 0));
    const { db } = makeMemoryDb(rows);

    expect(await readBoundedEncodedValue(db, ownerKey)).toEqual(encoded);
    const decoded = await readBoundedValidatedValue(db, ownerKey, value => value as typeof expected);
    expect(decoded).toEqual(expected);
  });

  test('fails loudly on a missing or tampered continuation page', async () => {
    const ownerKey = Buffer.from([0x03, 0, 0, 0, 2]);
    const rows = prepareBoundedStorageValueRows(ownerKey, encodeBuffer({ bytes: Buffer.alloc(20_000, 0x11) }));
    const missing = makeMemoryDb(rows.filter((_, index) => index !== 1));
    await expect(readBoundedEncodedValue(missing.db, ownerKey)).rejects.toThrow('STORAGE_BOUNDED_CHUNK_MISSING');

    const tamperedRows = rows.map(row => ({ key: row.key, value: Buffer.from(row.value) }));
    const chunk = decodeBuffer<Record<string, unknown>>(tamperedRows[1]!.value);
    const bytes = Buffer.from(chunk['bytes'] as Uint8Array);
    bytes[0] = bytes[0] === 0 ? 1 : 0;
    chunk['bytes'] = bytes;
    tamperedRows[1] = { key: tamperedRows[1]!.key, value: encodeBuffer(chunk) };
    const tampered = makeMemoryDb(tamperedRows);
    await expect(readBoundedEncodedValue(tampered.db, ownerKey)).rejects.toThrow('STORAGE_BOUNDED_DIGEST_MISMATCH');
  });

  test('deletes the owner and every continuation in one committed batch', async () => {
    const ownerKey = Buffer.from([0x02, 0, 0, 0, 3]);
    const rows = prepareBoundedStorageValueRows(ownerKey, encodeBuffer({ bytes: Buffer.alloc(23_000, 0x22) }));
    const { db, store } = makeMemoryDb(rows);
    let committed = 0;
    const result = await deleteBoundedStorageValue(db, ownerKey, () => {
      committed += 1;
      expect(store.size).toBe(0);
    });

    expect(result.removedKeys).toBe(rows.length);
    expect(result.removedBytes).toBeGreaterThan(23_000);
    expect(committed).toBe(1);
  });
});
