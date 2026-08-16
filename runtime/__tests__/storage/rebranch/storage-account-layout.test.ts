import { describe, expect, test } from 'bun:test';

import {
  MAX_INLINE_STORAGE_VALUE_BYTES,
  prepareAccountStorageLayout,
  readAccountStorageLayout,
} from '../../../storage/schema/account-layout';
import {
  KEY_LIVE_ACCOUNT_BRANCH,
  KEY_LIVE_ACCOUNT_LEAF,
  KEY_REBRANCH_NODE,
  keyLiveAccount,
} from '../../../storage/keys';
import { withRebranchedValues } from '../../../storage/database/rebranched-db';
import type { RuntimeDbLike } from '../../../storage/types';
import { MemoryRuntimeDb } from '../../fixtures/storage/memory-runtime-db';
import { makeAccount } from '../../helpers/cross-j';
import { requirePersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { createDefaultDelta } from '../../../account/state/delta';
import type { AccountTx } from '../../../types/account';
import { createFrameHash } from '../../../account/consensus/frame/hash';

const entityId = `0x${'11'.repeat(32)}`;
const counterpartyId = `0x${'22'.repeat(32)}`;

const applyLayout = async (
  db: RuntimeDbLike,
  layout: Awaited<ReturnType<typeof prepareAccountStorageLayout>>,
): Promise<void> => {
  const batch = db.batch();
  for (const key of layout.dels) batch.del?.(key);
  for (const put of layout.puts) batch.put(put.key, put.value);
  await batch.write();
};

describe('typed Account Patricia persistence', () => {
  test('stores one bounded header plus exact branch/leaf rows and relinks them', async () => {
    const raw = new MemoryRuntimeDb();
    const db = withRebranchedValues(raw);
    const account = makeAccount(entityId, counterpartyId);
    const rootKey = keyLiveAccount(entityId, counterpartyId);

    const layout = await prepareAccountStorageLayout(db, entityId, counterpartyId, rootKey, account);
    expect(layout.representation).toBe('graph');
    expect(layout.rootValue.byteLength).toBeLessThan(MAX_INLINE_STORAGE_VALUE_BYTES);
    expect(layout.puts.every(put => put.value.byteLength < MAX_INLINE_STORAGE_VALUE_BYTES)).toBeTrue();
    await applyLayout(db, layout);

    const restored = await readAccountStorageLayout(db, entityId, counterpartyId, rootKey);
    expect(restored?.doc).toEqual(account);
    const tags = new Set([...raw.rows.keys()].map(key => Number.parseInt(key.slice(0, 2), 16)));
    expect(tags.has(KEY_LIVE_ACCOUNT_BRANCH)).toBeTrue();
    expect(tags.has(KEY_LIVE_ACCOUNT_LEAF)).toBeTrue();
    expect(tags.has(KEY_REBRANCH_NODE)).toBeFalse();
  });

  test('writes only one dirty leaf and its Patricia ancestors', async () => {
    const raw = new MemoryRuntimeDb();
    const db = withRebranchedValues(raw);
    const rootKey = keyLiveAccount(entityId, counterpartyId);
    const base = makeAccount(entityId, counterpartyId);
    const first = await prepareAccountStorageLayout(db, entityId, counterpartyId, rootKey, base);
    await applyLayout(db, first);

    const deltas = requirePersistentAccountStateMap(base.state.deltas, 'deltas')
      .updated(2, createDefaultDelta(2));
    const next = { ...base, state: { ...base.state, deltas } };
    const changed = await prepareAccountStorageLayout(
      db, entityId, counterpartyId, rootKey, next, base,
    );

    const graphPuts = changed.puts.filter(put =>
      put.key[0] === KEY_LIVE_ACCOUNT_BRANCH || put.key[0] === KEY_LIVE_ACCOUNT_LEAF);
    expect(graphPuts.length).toBeGreaterThan(0);
    expect(graphPuts.length).toBeLessThan(70);
    expect(changed.puts.every(put => put.value.byteLength < MAX_INLINE_STORAGE_VALUE_BYTES)).toBeTrue();
    await applyLayout(db, changed);
    expect((await readAccountStorageLayout(db, entityId, counterpartyId, rootKey))?.doc)
      .toEqual(next);
  });

  test('stores large Account envelope arrays as bounded name-stable graph rows', async () => {
    const raw = new MemoryRuntimeDb();
    const db = withRebranchedValues(raw);
    const rootKey = keyLiveAccount(entityId, counterpartyId);
    const offer = (index: number): AccountTx => ({
      type: 'swap_offer',
      data: {
        offerId: `storage-envelope-offer-${index.toString().padStart(4, '0')}`,
        giveTokenId: 1,
        giveTokenDecimals: 6,
        giveAmount: 10_000_000n + BigInt(index),
        wantTokenId: 2,
        wantTokenDecimals: 18,
        wantAmount: 1_000_000_000_000_000n + BigInt(index),
        maxFee: 1_000n,
        minNetReceive: 999_999_999_999_000n,
      },
    });
    const txs = Array.from({ length: 200 }, (_, index) => offer(index));
    const base = makeAccount(entityId, counterpartyId);
    base.mempool = txs;
    base.currentFrame = {
      ...base.currentFrame,
      height: 1,
      timestamp: 1,
      prevFrameHash: 'genesis',
      accountTxs: txs,
    };
    base.currentFrame.stateHash = await createFrameHash(base.currentFrame);
    base.currentHeight = 1;

    const first = await prepareAccountStorageLayout(db, entityId, counterpartyId, rootKey, base);
    expect(first.puts.every(put => put.value.byteLength < MAX_INLINE_STORAGE_VALUE_BYTES)).toBeTrue();
    await applyLayout(db, first);
    expect((await readAccountStorageLayout(db, entityId, counterpartyId, rootKey))?.doc).toEqual(base);

    const next = { ...base, mempool: [...base.mempool, offer(200)] };
    const changed = await prepareAccountStorageLayout(
      db,
      entityId,
      counterpartyId,
      rootKey,
      next,
      base,
    );
    const envelopePuts = changed.puts.filter(put =>
      (put.key[0] === KEY_LIVE_ACCOUNT_BRANCH || put.key[0] === KEY_LIVE_ACCOUNT_LEAF)
      && put.key[65] === 0xff);
    expect(envelopePuts.length).toBeGreaterThan(0);
    expect(envelopePuts.length).toBeLessThan(100);

    const equivalentShell = {
      ...next,
      state: { ...next.state },
      shadow: { ...next.shadow, rebalance: { ...next.shadow.rebalance } },
    };
    const unchanged = await prepareAccountStorageLayout(
      db,
      entityId,
      counterpartyId,
      rootKey,
      equivalentShell,
      next,
    );
    expect(unchanged.puts.filter(put =>
      (put.key[0] === KEY_LIVE_ACCOUNT_BRANCH || put.key[0] === KEY_LIVE_ACCOUNT_LEAF)
      && put.key[65] === 0xff)).toHaveLength(0);
  });
});
