import { expect, test } from 'bun:test';

import { createDefaultDelta } from '../../../account/state/delta';
import { requirePersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { encodeBuffer } from '../../../storage/codec/codec';
import { createSnapshot, readSnapshotDocs } from '../../../storage/database/lifecycle';
import {
  KEY_HEAD,
  KEY_SNAPSHOT_GRAPH,
  STORAGE_SCHEMA_VERSION,
  keyLiveAccount,
  keySnapshotAccount,
  keySnapshotGraph,
} from '../../../storage/keys';
import { inspectSnapshotGraphRows } from '../../../storage/read/snapshot-graph-integrity';
import {
  prepareAccountStorageLayout,
} from '../../../storage/schema/account-layout';
import type { StorageHead } from '../../../storage/types';
import { MemoryRuntimeDb } from '../../fixtures/storage/memory-runtime-db';
import { makeAccount } from '../../helpers/cross-j';

const entityId = `0x${'11'.repeat(32)}`;
const counterpartyId = `0x${'22'.repeat(32)}`;

const head = (): StorageHead => ({
  schemaVersion: STORAGE_SCHEMA_VERSION,
  latestHeight: 1,
  latestMaterializedHeight: 1,
  latestSnapshotHeight: 0,
  snapshotPeriodFrames: 100,
  retainSnapshots: 10,
  epochMaxBytes: Number.MAX_SAFE_INTEGER,
  accountMerkleRadix: 16,
  epochReplayBytes: 0,
  retainedHistoryBytes: 0,
});

test('Account snapshot copies and relinks the exact Patricia graph without live rows', async () => {
  const source = new MemoryRuntimeDb();
  const snapshot = new MemoryRuntimeDb();
  const account = makeAccount(entityId, counterpartyId);
  account.state.deltas = requirePersistentAccountStateMap(account.state.deltas, 'deltas')
    .updated(7, createDefaultDelta(7));
  const rootKey = keyLiveAccount(entityId, counterpartyId);
  const layout = await prepareAccountStorageLayout(
    source,
    entityId,
    counterpartyId,
    rootKey,
    account,
  );
  const liveBatch = source.batch();
  for (const row of layout.puts) liveBatch.put(row.key, row.value);
  await liveBatch.write();
  const headBatch = snapshot.batch();
  headBatch.put(KEY_HEAD, encodeBuffer(head()));
  await headBatch.write();

  const created = await createSnapshot(source, snapshot, 1, 1_000);
  const restored = await readSnapshotDocs(snapshot, 1);
  const accountDoc = restored.find(
    (doc): doc is Extract<(typeof restored)[number], { family: 'account' }> =>
      doc.family === 'account',
  );
  expect(accountDoc?.value).toEqual(account);
  expect(snapshot.rows.has(rootKey.toString('hex'))).toBeFalse();
  const graphKeys = [...snapshot.rows.keys()].filter(key =>
    Number.parseInt(key.slice(0, 2), 16) === KEY_SNAPSHOT_GRAPH);
  expect(graphKeys.length).toBeGreaterThan(0);
  expect(await inspectSnapshotGraphRows(snapshot, 1)).toBe(graphKeys.length);
  expect(created.docCount).toBe(graphKeys.length + 1);

  const corruptKey = graphKeys.at(-1);
  if (!corruptKey) throw new Error('TEST_SNAPSHOT_ACCOUNT_GRAPH_MISSING');
  snapshot.rows.get(corruptKey)![0] ^= 0xff;
  await expect(readSnapshotDocs(snapshot, 1)).rejects.toThrow();
});

test('snapshot graph verification rejects an orphan row', async () => {
  const source = new MemoryRuntimeDb();
  const snapshot = new MemoryRuntimeDb();
  const account = makeAccount(entityId, counterpartyId);
  const rootKey = keyLiveAccount(entityId, counterpartyId);
  const layout = await prepareAccountStorageLayout(
    source,
    entityId,
    counterpartyId,
    rootKey,
    account,
  );
  const liveBatch = source.batch();
  for (const row of layout.puts) liveBatch.put(row.key, row.value);
  await liveBatch.write();
  const headBatch = snapshot.batch();
  headBatch.put(KEY_HEAD, encodeBuffer(head()));
  await headBatch.write();
  await createSnapshot(source, snapshot, 1, 1_000);

  const graphHex = [...snapshot.rows.keys()].find(key =>
    Number.parseInt(key.slice(0, 2), 16) === KEY_SNAPSHOT_GRAPH);
  if (!graphHex) throw new Error('TEST_SNAPSHOT_ACCOUNT_GRAPH_MISSING');
  const graphKey = Buffer.from(graphHex, 'hex');
  const orphanLiveKey = Buffer.from(graphKey.subarray(9));
  orphanLiveKey[1] ^= 0xff;
  const orphanKey = keySnapshotGraph(1, orphanLiveKey);
  const batch = snapshot.batch();
  batch.put(orphanKey, Buffer.from(snapshot.rows.get(graphHex)!));
  await batch.write();

  await expect(inspectSnapshotGraphRows(snapshot, 1)).rejects.toThrow(
    'STORAGE_SNAPSHOT_GRAPH_OWNER_MISSING',
  );
});

test('snapshot graph verification rejects an Account namespace absent from its header', async () => {
  const source = new MemoryRuntimeDb();
  const snapshot = new MemoryRuntimeDb();
  const account = makeAccount(entityId, counterpartyId);
  const rootKey = keyLiveAccount(entityId, counterpartyId);
  const layout = await prepareAccountStorageLayout(
    source,
    entityId,
    counterpartyId,
    rootKey,
    account,
  );
  const liveBatch = source.batch();
  for (const row of layout.puts) liveBatch.put(row.key, row.value);
  await liveBatch.write();
  const headBatch = snapshot.batch();
  headBatch.put(KEY_HEAD, encodeBuffer(head()));
  await headBatch.write();
  await createSnapshot(source, snapshot, 1, 1_000);

  const graphHex = [...snapshot.rows.keys()].find(key =>
    Number.parseInt(key.slice(0, 2), 16) === KEY_SNAPSHOT_GRAPH);
  if (!graphHex) throw new Error('TEST_SNAPSHOT_ACCOUNT_GRAPH_MISSING');
  const graphKey = Buffer.from(graphHex, 'hex');
  const unknownNamespaceLiveKey = Buffer.from(graphKey.subarray(9));
  unknownNamespaceLiveKey[65] = 0xfe;
  const batch = snapshot.batch();
  batch.put(
    keySnapshotGraph(1, unknownNamespaceLiveKey),
    Buffer.from(snapshot.rows.get(graphHex)!),
  );
  await batch.write();

  await expect(inspectSnapshotGraphRows(snapshot, 1)).rejects.toThrow(
    'STORAGE_SNAPSHOT_GRAPH_ACCOUNT_NAMESPACE_UNDECLARED',
  );
});

test('snapshot graph verification typeguards the owning Account header', async () => {
  const source = new MemoryRuntimeDb();
  const snapshot = new MemoryRuntimeDb();
  const account = makeAccount(entityId, counterpartyId);
  const rootKey = keyLiveAccount(entityId, counterpartyId);
  const layout = await prepareAccountStorageLayout(
    source,
    entityId,
    counterpartyId,
    rootKey,
    account,
  );
  const liveBatch = source.batch();
  for (const row of layout.puts) liveBatch.put(row.key, row.value);
  await liveBatch.write();
  const headBatch = snapshot.batch();
  headBatch.put(KEY_HEAD, encodeBuffer(head()));
  await headBatch.write();
  await createSnapshot(source, snapshot, 1, 1_000);

  const corruptHeader = snapshot.batch();
  corruptHeader.put(
    keySnapshotAccount(1, entityId, counterpartyId),
    encodeBuffer({ version: 1, envelope: {}, trees: [], unexpected: true }),
  );
  await corruptHeader.write();

  await expect(inspectSnapshotGraphRows(snapshot, 1)).rejects.toThrow(
    'STORAGE_ACCOUNT_MANIFEST_FIELDS',
  );
});
