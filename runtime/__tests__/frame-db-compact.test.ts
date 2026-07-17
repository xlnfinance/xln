import { describe, expect, test } from 'bun:test';

import type { AccountFrame } from '../types';
import { buildFrameDbPuts, readFrameDbAccountFrames, readFrameDbRuntimeActivity } from '../storage/frame-db';
import { decodeBuffer, encodeBuffer } from '../storage/codec';
import { FRAME_DB_ACCOUNT_FRAME, FRAME_DB_RUNTIME_ACTIVITY } from '../storage/keys';
import type { RuntimeDbLike } from '../storage/types';

const zeroHash = `0x${'00'.repeat(32)}`;

const makeMemoryDb = (entries: Array<[Buffer, Buffer]>): RuntimeDbLike => {
  const store = new Map<string, { key: Buffer; value: Buffer }>();
  for (const [key, value] of entries) {
    store.set(key.toString('hex'), { key: Buffer.from(key), value: Buffer.from(value) });
  }
  return {
    get: async (key: Buffer) => {
      const item = store.get(key.toString('hex'));
      if (!item) {
        const error = new Error('NotFound') as Error & { code?: string; notFound?: boolean };
        error.code = 'LEVEL_NOT_FOUND';
        error.notFound = true;
        throw error;
      }
      return Buffer.from(item.value);
    },
    batch: () => ({
      put: (key: Buffer, value: Buffer) => {
        store.set(key.toString('hex'), { key: Buffer.from(key), value: Buffer.from(value) });
      },
      write: async () => {},
    }),
    keys: async function* (options?: { gte?: Buffer; lt?: Buffer; reverse?: boolean }) {
      const ordered = Array.from(store.values()).map((item) => item.key).sort(Buffer.compare);
      if (options?.reverse) ordered.reverse();
      for (const key of ordered) {
        if (options?.gte && Buffer.compare(key, options.gte) < 0) continue;
        if (options?.lt && Buffer.compare(key, options.lt) >= 0) continue;
        yield Buffer.from(key);
      }
    },
  };
};

describe('frame DB compact values', () => {
  test('account frame reader fetches only the newest bounded history window', async () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterpartyId = `0x${'22'.repeat(32)}`;
    const entries = Array.from({ length: 12 }, (_, index) => {
      const accountHeight = index + 1;
      const frame: AccountFrame = {
        height: accountHeight,
        timestamp: 100 + accountHeight,
        jHeight: 7,
        accountTxs: [],
        prevFrameHash: zeroHash,
        accountStateRoot: zeroHash,
        stateHash: zeroHash,
        byLeft: true,
        deltas: [],
      };
      const accountPut = buildFrameDbPuts({
        height: accountHeight,
        timestamp: frame.timestamp,
        runtimeInput: { runtimeTxs: [], entityInputs: [] },
        logs: [],
        touchedEntities: [entityId],
        touchedAccounts: [{ entityId, counterpartyId }],
        touchedBookEntities: [],
        frameDbRecords: [{
          kind: 'accountFrame',
          entityId,
          counterpartyId,
          accountHeight,
          source: 'ackCommit',
          frame,
        }],
      }).find((put) => put.key[0] === FRAME_DB_ACCOUNT_FRAME);
      if (!accountPut) throw new Error(`ACCOUNT_FRAME_PUT_MISSING:${accountHeight}`);
      return [accountPut.key, accountPut.value] as [Buffer, Buffer];
    });
    const db = makeMemoryDb(entries);
    const get = db.get;
    let valueReads = 0;
    db.get = async (key) => {
      valueReads += 1;
      return get(key);
    };

    const records = await readFrameDbAccountFrames(db, entityId, counterpartyId, {
      limit: 3,
      maxAccountHeight: 10,
      maxRuntimeHeight: 10,
    });

    expect(records.map((record) => record.accountHeight)).toEqual([8, 9, 10]);
    expect(valueReads).toBe(3);
  });

  test('account frame values omit fields already encoded in the primary key', async () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterpartyId = `0x${'22'.repeat(32)}`;
    const frame: AccountFrame = {
      height: 2,
      timestamp: 123,
      jHeight: 7,
      accountTxs: [],
      prevFrameHash: zeroHash,
      accountStateRoot: zeroHash,
      stateHash: zeroHash,
      byLeft: true,
      deltas: [],
    };

    const puts = buildFrameDbPuts({
      height: 8,
      timestamp: 456,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      logs: [],
      touchedEntities: [entityId],
      touchedAccounts: [{ entityId, counterpartyId }],
      touchedBookEntities: [],
      frameDbRecords: [{
        kind: 'accountFrame',
        entityId,
        counterpartyId,
        accountHeight: frame.height,
        source: 'ackCommit',
        frame,
      }],
    });

    const accountPut = puts.find((put) => put.key[0] === FRAME_DB_ACCOUNT_FRAME);
    expect(accountPut).toBeTruthy();
    const stored = decodeBuffer<Record<string, unknown>>(accountPut!.value);
    expect(stored['kind']).toBeUndefined();
    expect(stored['entityId']).toBeUndefined();
    expect(stored['counterpartyId']).toBeUndefined();
    expect(stored['accountHeight']).toBeUndefined();
    expect(stored['source']).toBe('ackCommit');
    expect(stored['runtimeHeight']).toBe(8);
    expect(stored['timestamp']).toBe(456);

    const records = await readFrameDbAccountFrames(makeMemoryDb([[accountPut!.key, accountPut!.value]]), entityId, counterpartyId);
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe('accountFrame');
    expect(records[0]?.entityId).toBe(entityId);
    expect(records[0]?.counterpartyId).toBe(counterpartyId);
    expect(records[0]?.accountHeight).toBe(frame.height);
    expect(records[0]?.frame.height).toBe(frame.height);
  });

  test('account frame reader rejects a value whose frame height disagrees with the key', async () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterpartyId = `0x${'22'.repeat(32)}`;
    const frame: AccountFrame = {
      height: 2,
      timestamp: 123,
      jHeight: 7,
      accountTxs: [],
      prevFrameHash: zeroHash,
      accountStateRoot: zeroHash,
      stateHash: zeroHash,
      byLeft: true,
      deltas: [],
    };
    const puts = buildFrameDbPuts({
      height: 8,
      timestamp: 456,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      logs: [],
      touchedEntities: [entityId],
      touchedAccounts: [{ entityId, counterpartyId }],
      touchedBookEntities: [],
      frameDbRecords: [{
        kind: 'accountFrame',
        entityId,
        counterpartyId,
        accountHeight: frame.height,
        source: 'ackCommit',
        frame,
      }],
    });
    const accountPut = puts.find((put) => put.key[0] === FRAME_DB_ACCOUNT_FRAME);
    expect(accountPut).toBeTruthy();
    const stored = decodeBuffer<Record<string, unknown>>(accountPut!.value);
    stored['frame'] = { ...(stored['frame'] as Record<string, unknown>), height: 3 };

    await expect(readFrameDbAccountFrames(
      makeMemoryDb([[accountPut!.key, encodeBuffer(stored)]]),
      entityId,
      counterpartyId,
    )).rejects.toThrow('FRAME_DB_ACCOUNT_FRAME_HEIGHT_MISMATCH');
  });

  test('runtime activity values omit fields already encoded in the key', async () => {
    const entityId = `0x${'33'.repeat(32)}`;
    const counterpartyId = `0x${'44'.repeat(32)}`;
    const puts = buildFrameDbPuts({
      height: 12,
      timestamp: 789,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      logs: [{ id: 1, category: 'consensus', level: 'info', message: 'ok', timestamp: 789, entityId }],
      touchedEntities: [entityId],
      touchedAccounts: [{ entityId, counterpartyId }],
      touchedBookEntities: [entityId],
      frameDbRecords: [],
    });

    const activityPut = puts.find((put) => put.key[0] === FRAME_DB_RUNTIME_ACTIVITY);
    expect(activityPut).toBeTruthy();
    const stored = decodeBuffer<Record<string, unknown>>(activityPut!.value);
    expect(stored['kind']).toBeUndefined();
    expect(stored['height']).toBeUndefined();
    expect(stored['timestamp']).toBe(789);
    expect(stored['touchedEntities']).toEqual([entityId]);
    expect(stored['touchedAccounts']).toEqual([{ entityId, counterpartyId }]);

    const activity = await readFrameDbRuntimeActivity(makeMemoryDb([[activityPut!.key, activityPut!.value]]), 12);
    expect(activity?.kind).toBe('runtimeActivity');
    expect(activity?.height).toBe(12);
    expect(activity?.timestamp).toBe(789);
    expect(activity?.touchedBookEntities).toEqual([entityId]);

    const corrupted = decodeBuffer<Record<string, unknown>>(activityPut!.value);
    delete corrupted['runtimeInput'];
    await expect(readFrameDbRuntimeActivity(
      makeMemoryDb([[activityPut!.key, encodeBuffer(corrupted)]]),
      12,
    )).rejects.toThrow('FRAME_DB_RUNTIME_ACTIVITY_FIELDS_INVALID:height=12');
  });
});
