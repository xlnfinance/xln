import { describe, expect, test } from 'bun:test';

import {
  MAX_INLINE_STORAGE_VALUE_BYTES,
  prepareAccountStorageLayout,
  readAccountStorageLayout,
  STORAGE_ACCOUNT_FIELD_TAG,
} from '../storage/account-layout';
import { encodeBuffer } from '../storage/codec';
import { KEY_REBRANCH_NODE, keyLiveAccount, keyLiveAccountField } from '../storage/keys';
import { withRebranchedValues } from '../storage/rebranched-db';
import type { RuntimeDbLike, StorageAccountDoc } from '../storage/types';
import { MemoryRuntimeDb } from './fixtures/memory-runtime-db';

const entityId = `0x${'11'.repeat(32)}`;
const counterpartyId = `0x${'22'.repeat(32)}`;

const accountDoc = (large: boolean, status = 'active'): StorageAccountDoc => ({
  leftEntity: entityId,
  rightEntity: counterpartyId,
  status,
  currentHeight: 7,
  deltas: new Map(Array.from({ length: large ? 80 : 1 }, (_, index) => [
    index,
    { tokenId: index, marker: `delta-${index}-${'x'.repeat(80)}` },
  ])),
  locks: new Map(Array.from({ length: large ? 32 : 0 }, (_, index) => [
    `lock-${index}`,
    { lockId: `lock-${index}`, marker: 'x'.repeat(100) },
  ])),
} as unknown as StorageAccountDoc);

const accountDocWithEncodedSize = (targetBytes: number): StorageAccountDoc => {
  let low = 0;
  let high = targetBytes * 2;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const doc = {
      ...accountDoc(false),
      hankoSignature: 'x'.repeat(length),
    } as StorageAccountDoc;
    const encodedBytes = encodeBuffer(doc).byteLength;
    if (encodedBytes === targetBytes) return doc;
    if (encodedBytes < targetBytes) low = length + 1;
    else high = length - 1;
  }
  throw new Error(`TEST_ACCOUNT_ENCODED_SIZE_UNREACHABLE:${targetBytes}`);
};

const applyLayout = async (
  db: RuntimeDbLike,
  layout: Awaited<ReturnType<typeof prepareAccountStorageLayout>>,
): Promise<void> => {
  const batch = db.batch();
  for (const key of layout.dels) batch.del?.(key);
  for (const put of layout.puts) batch.put(put.key, put.value);
  await batch.write();
};

describe('typed Account persistence rebranching', () => {
  test('switches the complete Account layout exactly at 10,000 encoded bytes', async () => {
    const raw = new MemoryRuntimeDb();
    const db = withRebranchedValues(raw);
    const rootKey = keyLiveAccount(entityId, counterpartyId);
    const inlineDoc = accountDocWithEncodedSize(MAX_INLINE_STORAGE_VALUE_BYTES - 1);
    const splitDoc = accountDocWithEncodedSize(MAX_INLINE_STORAGE_VALUE_BYTES);

    const inline = await prepareAccountStorageLayout(
      db,
      entityId,
      counterpartyId,
      rootKey,
      inlineDoc,
    );
    expect(inline.logicalValue.byteLength).toBe(9_999);
    expect(inline.representation).toBe('inline');
    await applyLayout(db, inline);

    const split = await prepareAccountStorageLayout(
      db,
      entityId,
      counterpartyId,
      rootKey,
      splitDoc,
    );
    expect(split.logicalValue.byteLength).toBe(10_000);
    expect(split.representation).toBe('fields');
    await applyLayout(db, split);
    expect((await readAccountStorageLayout(
      db,
      entityId,
      counterpartyId,
      rootKey,
    ))?.logicalValue).toEqual(split.logicalValue);
  });

  test('keeps small Accounts inline and rebranches oversized Accounts by typed field', async () => {
    const raw = new MemoryRuntimeDb();
    const db = withRebranchedValues(raw);
    const rootKey = keyLiveAccount(entityId, counterpartyId);

    const inline = await prepareAccountStorageLayout(db, entityId, counterpartyId, rootKey, accountDoc(false));
    expect(inline.representation).toBe('inline');
    expect(inline.logicalValue.byteLength).toBeLessThan(MAX_INLINE_STORAGE_VALUE_BYTES);
    await applyLayout(db, inline);

    const large = await prepareAccountStorageLayout(db, entityId, counterpartyId, rootKey, accountDoc(true));
    expect(large.representation).toBe('fields');
    expect(large.logicalValue.byteLength).toBeGreaterThanOrEqual(MAX_INLINE_STORAGE_VALUE_BYTES);
    expect(large.puts.some((put) => put.key.equals(keyLiveAccountField(
      entityId,
      counterpartyId,
      STORAGE_ACCOUNT_FIELD_TAG.deltas,
    )))).toBeTrue();
    await applyLayout(db, large);

    const restored = await readAccountStorageLayout(db, entityId, counterpartyId, rootKey);
    expect(restored?.representation).toBe('fields');
    expect(restored?.logicalValue).toEqual(large.logicalValue);
    expect(restored?.doc).toEqual(accountDoc(true));
    expect(Math.max(...Array.from(raw.rows.values(), (value) => value.byteLength)))
      .toBeLessThan(MAX_INLINE_STORAGE_VALUE_BYTES);
    expect(Array.from(raw.rows.keys()).some((key) => Number.parseInt(key.slice(0, 2), 16) === KEY_REBRANCH_NODE))
      .toBeFalse();
  });

  test('rewrites only the changed typed field and collapses deterministically when small again', async () => {
    const raw = new MemoryRuntimeDb();
    const db = withRebranchedValues(raw);
    const rootKey = keyLiveAccount(entityId, counterpartyId);
    const first = await prepareAccountStorageLayout(db, entityId, counterpartyId, rootKey, accountDoc(true));
    await applyLayout(db, first);

    const changed = await prepareAccountStorageLayout(db, entityId, counterpartyId, rootKey, accountDoc(true, 'disputed'));
    expect(changed.representation).toBe('fields');
    expect(changed.puts).toHaveLength(2);
    expect(changed.puts[1]?.key).toEqual(keyLiveAccountField(
      entityId,
      counterpartyId,
      STORAGE_ACCOUNT_FIELD_TAG.status,
    ));
    await applyLayout(db, changed);

    const collapsed = await prepareAccountStorageLayout(db, entityId, counterpartyId, rootKey, accountDoc(false));
    expect(collapsed.representation).toBe('inline');
    expect(collapsed.dels.length).toBeGreaterThan(0);
    await applyLayout(db, collapsed);
    expect((await readAccountStorageLayout(db, entityId, counterpartyId, rootKey))?.representation).toBe('inline');
    expect(raw.rows.has(keyLiveAccountField(
      entityId,
      counterpartyId,
      STORAGE_ACCOUNT_FIELD_TAG.deltas,
    ).toString('hex'))).toBeFalse();
  });

  test('rebranches every oversized financial collection and restores it exactly', async () => {
    const variants = [
      {
        field: 'deltas',
        tag: STORAGE_ACCOUNT_FIELD_TAG.deltas,
        value: new Map(Array.from({ length: 400 }, (_, index) => [
          index,
          { tokenId: index, marker: `delta-${index}-${'x'.repeat(80)}` },
        ])),
      },
      {
        field: 'locks',
        tag: STORAGE_ACCOUNT_FIELD_TAG.locks,
        value: new Map(Array.from({ length: 400 }, (_, index) => [
          `lock-${index}`,
          { lockId: `lock-${index}`, marker: `lock-${index}-${'y'.repeat(80)}` },
        ])),
      },
      {
        field: 'swapOffers',
        tag: STORAGE_ACCOUNT_FIELD_TAG.swapOffers,
        value: new Map(Array.from({ length: 400 }, (_, index) => [
          `offer-${index}`,
          { offerId: `offer-${index}`, marker: `offer-${index}-${'z'.repeat(80)}` },
        ])),
      },
    ] as const;

    for (const variant of variants) {
      const raw = new MemoryRuntimeDb();
      const db = withRebranchedValues(raw);
      const doc = accountDoc(false) as unknown as Record<string, unknown>;
      doc[variant.field] = variant.value;
      const layout = await prepareAccountStorageLayout(
        db,
        entityId,
        counterpartyId,
        keyLiveAccount(entityId, counterpartyId),
        doc as unknown as StorageAccountDoc,
      );
      expect(layout.representation).toBe('fields');
      expect(layout.puts.some((put) => put.key.equals(
        keyLiveAccountField(entityId, counterpartyId, variant.tag),
      ))).toBeTrue();
      await applyLayout(db, layout);
      expect((await readAccountStorageLayout(
        db,
        entityId,
        counterpartyId,
        keyLiveAccount(entityId, counterpartyId),
      ))?.doc).toEqual(doc);
      expect(Math.max(...Array.from(raw.rows.values(), (value) => value.byteLength)))
        .toBeLessThan(MAX_INLINE_STORAGE_VALUE_BYTES);
      expect(Array.from(raw.rows.keys()).some((key) => Number.parseInt(key.slice(0, 2), 16) === KEY_REBRANCH_NODE))
        .toBeTrue();
    }
  });
});
