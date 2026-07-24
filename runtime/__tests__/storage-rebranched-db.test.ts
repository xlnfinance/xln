import { describe, expect, test } from 'bun:test';

import {
  STORAGE_MAX_PHYSICAL_VALUE_BYTES,
  withRebranchedValues,
} from '../storage/rebranched-db';
import { MemoryRuntimeDb } from './fixtures/memory-runtime-db';

describe('path-addressed rebranched LevelDB values', () => {
  test('round-trips a real fat-account-sized value while every physical value stays under 10 KiB', async () => {
    const raw = new MemoryRuntimeDb();
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
    const raw = new MemoryRuntimeDb();
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
    const sourceRaw = new MemoryRuntimeDb();
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

    const rotatedRaw = new MemoryRuntimeDb();
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
    const raw = new MemoryRuntimeDb();
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

  test('keeps prefix-related logical trees disjoint during branched-to-branched shrink', async () => {
    const raw = new MemoryRuntimeDb();
    const db = withRebranchedValues(raw);
    const shortKey = Buffer.from([0x24, 0x01]);
    const prefixedKey = Buffer.from([0x24, 0x01, 0x02]);
    const physicalPrefix = (key: Buffer): string => Buffer.concat([
      Buffer.from([0x7e]),
      Buffer.from([(key.byteLength >>> 8) & 0xff, key.byteLength & 0xff]),
      key,
    ]).toString('hex');
    const physicalKeys = (key: Buffer): Set<string> => new Set(
      Array.from(raw.rows.keys()).filter((candidate) => candidate.startsWith(physicalPrefix(key))),
    );

    const first = Buffer.alloc(40_000, 0x51);
    const sibling = Buffer.alloc(32_000, 0x62);
    await db.put!(shortKey, first);
    await db.put!(prefixedKey, sibling);
    const beforeShort = physicalKeys(shortKey);
    const beforeSibling = physicalKeys(prefixedKey);
    expect(beforeShort.size).toBeGreaterThan(1);
    expect(beforeSibling.size).toBeGreaterThan(1);
    expect(Array.from(beforeShort).some((key) => beforeSibling.has(key))).toBeFalse();

    const smallerStillBranched = Buffer.alloc(20_000, 0x73);
    await db.put!(shortKey, smallerStillBranched);
    const afterShort = physicalKeys(shortKey);
    const afterSibling = physicalKeys(prefixedKey);
    expect(await db.get(shortKey)).toEqual(smallerStillBranched);
    expect(await db.get(prefixedKey)).toEqual(sibling);
    expect(afterShort.size).toBeLessThan(beforeShort.size);
    expect(afterSibling).toEqual(beforeSibling);

    const puts = new Set(raw.lastBatchOperations.filter((operation) => operation.kind === 'put').map((operation) => operation.key));
    const dels = new Set(raw.lastBatchOperations.filter((operation) => operation.kind === 'del').map((operation) => operation.key));
    expect(Array.from(puts).some((key) => dels.has(key))).toBeFalse();
    expect(Array.from(beforeShort).filter((key) => !afterShort.has(key)).every((key) => dels.has(key))).toBeTrue();
  });
});
