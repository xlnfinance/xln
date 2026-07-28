import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Level } from 'level';

import { pruneFrameDbRetention } from '../storage/frame-db';
import {
  keyFrameDbAccountFrame,
  keyFrameDbAccountFrameByRuntime,
  keyFrameDbEntityFrame,
  keyFrameDbEntityFrameByRuntime,
  keyFrameDbRuntimeActivity,
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
  frameDbMaxBytes: 1,
  frameDbRetainFrames: 1,
  materializePeriodFrames: 10,
  canonicalHashPeriodFrames: 0,
  accountMerkleRadix: 16,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('independent frame history retention', () => {
  test('Runtime compaction removes activity indexes but preserves Entity and Account frame bodies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-frame-history-retention-'));
    roots.push(root);
    const db = new Level<Buffer, Buffer>(root, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
    const accountFrameKey = keyFrameDbAccountFrame(entityId, counterpartyId, 1);
    const entityFrameKey = keyFrameDbEntityFrame(entityId, 1);
    const accountRuntimeIndex = keyFrameDbAccountFrameByRuntime(1, entityId, counterpartyId, 1);
    const entityRuntimeIndex = keyFrameDbEntityFrameByRuntime(1, entityId, 1);
    await db.batch()
      .put(keyFrameDbRuntimeActivity(1), Buffer.from('runtime-activity'))
      .put(accountFrameKey, Buffer.from('account-frame'))
      .put(entityFrameKey, Buffer.from('entity-frame'))
      .put(accountRuntimeIndex, Buffer.alloc(0))
      .put(entityRuntimeIndex, Buffer.alloc(0))
      .write();

    await pruneFrameDbRetention({
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

    expect(await readRawOrNull(db, keyFrameDbRuntimeActivity(1))).toBeNull();
    expect(await readRawOrNull(db, accountRuntimeIndex)).toBeNull();
    expect(await readRawOrNull(db, entityRuntimeIndex)).toBeNull();
    expect(await readRawOrNull(db, accountFrameKey)).toEqual(Buffer.from('account-frame'));
    expect(await readRawOrNull(db, entityFrameKey)).toEqual(Buffer.from('entity-frame'));
    await db.close();
  });
});
