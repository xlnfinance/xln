import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Level } from 'level';
import { encodeBuffer } from '../../../storage/codec/codec';
import { readBoundedDecodedValue } from '../../../storage/codec/bounded-value';
import { readRawOrNull, readRequiredRaw, readValidatedOrNull } from '../../../storage/database/level';

test('current Level API distinguishes absent, valid, malformed and unavailable storage', async () => {
  const path = await mkdtemp(join(tmpdir(), 'xln-level-api-'));
  const db = new Level<Buffer, Buffer>(path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  const key = Buffer.from('current-row');
  const validate = (value: unknown): bigint => {
    if (typeof value !== 'bigint') throw new Error('EXPECTED_MONEY_BIGINT');
    return value;
  };
  try {
    await db.open();
    expect(await db.get(key)).toBeUndefined();
    expect(await readRawOrNull(db, key)).toBeNull();
    expect(await readValidatedOrNull(db, key, validate)).toBeNull();
    expect(await readBoundedDecodedValue(db, key)).toBeNull();
    await expect(readRequiredRaw(db, key)).rejects.toThrow('STORAGE_REFERENCED_ROW_MISSING');
    await db.put(key, encodeBuffer(123456789012345678901234567890n));
    expect(await readValidatedOrNull(db, key, validate)).toBe(123456789012345678901234567890n);
    expect(await readBoundedDecodedValue(db, key)).toEqual({
      encoded: encodeBuffer(123456789012345678901234567890n),
      decoded: 123456789012345678901234567890n,
    });
    await db.put(key, encodeBuffer('malformed money'));
    await expect(readValidatedOrNull(db, key, validate)).rejects.toThrow('EXPECTED_MONEY_BIGINT');
    await db.put(key, Buffer.from([0]));
    await expect(readValidatedOrNull(db, key, validate)).rejects.toThrow('STORAGE_CODEC_MSGPACK_REQUIRED');
    await expect(readBoundedDecodedValue(db, key)).rejects.toThrow();
    await db.close();
    await expect(readRawOrNull(db, key)).rejects.toThrow();
  } finally {
    await db.close();
    await rm(path, { recursive: true, force: true });
  }
});
