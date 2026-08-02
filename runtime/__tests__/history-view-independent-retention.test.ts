import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Level } from 'level';

import { pruneHistoryViewRetention } from '../storage/history-view';
import {
  keyHistoryViewAccountFrame,
  keyHistoryViewEntityFrame,
  keyHistoryViewRuntimeActivity,
  STORAGE_SCHEMA_VERSION,
} from '../storage/keys';
import { readRawOrNull } from '../storage/level';
import type { StorageRuntimeConfig } from '../storage/types';

const roots: string[] = [];
const entityId = `0x${'11'.repeat(32)}`;
const counterpartyId = `0x${'22'.repeat(32)}`;

const config: Required<StorageRuntimeConfig> = {
  enabled: true,
  snapshotPeriodFrames: 100,
  retainSnapshots: 2,
  epochMaxBytes: 1_000_000,
  historyViewMaxBytes: 1,
  historyViewRetainFrames: 1,
  materializePeriodFrames: 10,
  canonicalHashPeriodFrames: 0,
  accountMerkleRadix: 16,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('independent frame history retention', () => {
  test('treats the frame count as an exact latest-frame retention bound', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-frame-count-retention-'));
    roots.push(root);
    const db = new Level<Buffer, Buffer>(root, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
    await db.batch()
      .put(keyHistoryViewRuntimeActivity(1), Buffer.from('one'))
      .put(keyHistoryViewRuntimeActivity(2), Buffer.from('two'))
      .put(keyHistoryViewRuntimeActivity(3), Buffer.from('three'))
      .write();

    const result = await pruneHistoryViewRetention({
      db,
      height: 3,
      head: {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        latestHeight: 3,
        latestPrunedRuntimeHeight: 0,
        retainedBytes: 11,
        maxBytes: Number.MAX_SAFE_INTEGER,
        retainFrames: 2,
      },
      config: {
        ...config,
        historyViewMaxBytes: Number.MAX_SAFE_INTEGER,
        historyViewRetainFrames: 2,
      },
    });

    expect(result.latestPrunedRuntimeHeight).toBe(1);
    expect(await readRawOrNull(db, keyHistoryViewRuntimeActivity(1))).toBeNull();
    expect(await readRawOrNull(db, keyHistoryViewRuntimeActivity(2))).toEqual(Buffer.from('two'));
    expect(await readRawOrNull(db, keyHistoryViewRuntimeActivity(3))).toEqual(Buffer.from('three'));
    await db.close();
  });

  test('retains history forever when both local limits are blank', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-frame-unlimited-retention-'));
    roots.push(root);
    const db = new Level<Buffer, Buffer>(root, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
    await db.put(keyHistoryViewRuntimeActivity(1), Buffer.from('one'));

    const result = await pruneHistoryViewRetention({
      db,
      height: 10,
      head: {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        latestHeight: 10,
        latestPrunedRuntimeHeight: 0,
        retainedBytes: Number.MAX_SAFE_INTEGER,
        maxBytes: Number.MAX_SAFE_INTEGER,
        retainFrames: Number.MAX_SAFE_INTEGER,
      },
      config: {
        ...config,
        historyViewMaxBytes: Number.MAX_SAFE_INTEGER,
        historyViewRetainFrames: Number.MAX_SAFE_INTEGER,
      },
    });

    expect(result.prunedKeys).toBe(0);
    expect(await readRawOrNull(db, keyHistoryViewRuntimeActivity(1))).toEqual(Buffer.from('one'));
    await db.close();
  });

  test('Runtime compaction removes activity indexes but preserves Entity and Account frame bodies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-frame-history-retention-'));
    roots.push(root);
    const db = new Level<Buffer, Buffer>(root, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
    const accountFrameKey = keyHistoryViewAccountFrame(entityId, counterpartyId, 1);
    const entityFrameKey = keyHistoryViewEntityFrame(entityId, 1);
    await db.batch()
      .put(keyHistoryViewRuntimeActivity(1), Buffer.from('runtime-activity'))
      .put(accountFrameKey, Buffer.from('account-frame'))
      .put(entityFrameKey, Buffer.from('entity-frame'))
      .write();

    await pruneHistoryViewRetention({
      db,
      height: 3,
      head: {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        latestHeight: 3,
        latestPrunedRuntimeHeight: 0,
        retainedBytes: 10_000,
        maxBytes: 1,
        retainFrames: 1,
      },
      config,
    });

    expect(await readRawOrNull(db, keyHistoryViewRuntimeActivity(1))).toBeNull();
    expect(await readRawOrNull(db, accountFrameKey)).toEqual(Buffer.from('account-frame'));
    expect(await readRawOrNull(db, entityFrameKey)).toEqual(Buffer.from('entity-frame'));
    await db.close();
  });
});
