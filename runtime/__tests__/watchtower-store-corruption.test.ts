import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeWatchtowerStore,
  createWatchtowerStoreContext,
  ensureWatchtowerStoreOpen,
  lookupKeyFor,
  META_STATS_KEY,
} from '../watchtower/store-db';
import { createWatchtowerStore } from '../watchtower/store';
import { decodeStoredActionReceipt } from '../watchtower/store-decode';
import { serializeTaggedJson } from '../protocol/serialization';

const temporaryStores: string[] = [];
const lookupKey = `0x${'11'.repeat(32)}`;

const persistCorruptRecord = async (key: string, value: string): Promise<string> => {
  const dbPath = mkdtempSync(join(tmpdir(), 'xln-watchtower-corruption-'));
  temporaryStores.push(dbPath);
  const context = createWatchtowerStoreContext({ dbPath });
  await ensureWatchtowerStoreOpen(context);
  await context.db.put(key, value);
  await closeWatchtowerStore(context);
  return dbPath;
};

afterEach(() => {
  for (const dbPath of temporaryStores.splice(0)) {
    rmSync(dbPath, { recursive: true, force: true });
  }
});

test('lookup corruption fails after LevelDB reopen with schema and physical key', async () => {
  const key = lookupKeyFor(lookupKey);
  const dbPath = await persistCorruptRecord(key, '{}');
  const store = createWatchtowerStore({ dbPath });

  await expect(store.getLatest(lookupKey)).rejects.toThrow(
    `TOWER_STORED_RECORD_INVALID:schema=lookup:key=${key}:TOWER_STORED_LOOKUP_FIELDS_INVALID`,
  );
  await store.close();
});

test('action receipt corruption fails after LevelDB reopen with schema and physical key', async () => {
  const key = `action:${lookupKey}:123:corrupt`;
  const dbPath = await persistCorruptRecord(key, '{}');
  const store = createWatchtowerStore({ dbPath });

  await expect(store.listActionReceipts(lookupKey)).rejects.toThrow(
    `TOWER_STORED_RECORD_INVALID:schema=action-receipt:key=${key}:TOWER_STORED_ACTION_FIELDS_INVALID`,
  );
  await store.close();
});

test('metadata corruption fails after LevelDB reopen with schema and physical key', async () => {
  const dbPath = await persistCorruptRecord(META_STATS_KEY, '{}');
  const store = createWatchtowerStore({ dbPath });

  await expect(store.getStats()).rejects.toThrow(
    `TOWER_STORED_RECORD_INVALID:schema=meta-stats:key=${META_STATS_KEY}:TOWER_STORED_META_FIELDS_INVALID`,
  );
  await store.close();
});

test('action receipt decoder rejects schema drift instead of preserving unknown fields', () => {
  const encoded = serializeTaggedJson({
    id: 'action-1',
    lookupKey,
    runtimeId: `0x${'22'.repeat(20)}`,
    towerMode: 'blind_backup',
    actionKind: 'counter_dispute_only',
    triggerHint: 'proof',
    appointmentSequence: 1,
    status: 'submitted',
    createdAt: 1,
    unexpected: true,
  });
  expect(() => decodeStoredActionReceipt(encoded)).toThrow(
    'TOWER_STORED_ACTION_FIELDS_INVALID:missing=none:extra=unexpected',
  );
});
