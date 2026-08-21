import { expect, test } from 'bun:test';

import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { PersistentEntityCollectionMap } from '../../../entity/state/persistent-collection-map';
import type { EntityState } from '../../../entity/types';
import type { HtlcRoute } from '../../../types/account';
import { encodeBuffer } from '../../../storage/codec/codec';
import { createSnapshot, readSnapshotDocs } from '../../../storage/database/lifecycle';
import {
  KEY_HEAD,
  KEY_LIVE_ENTITY_BRANCH,
  KEY_LIVE_ENTITY_FIELD,
  KEY_LIVE_ENTITY_LEAF,
  KEY_SNAPSHOT_GRAPH,
  STORAGE_SCHEMA_VERSION,
  keyLiveEntity,
  keyLiveEntityField,
} from '../../../storage/keys';
import { inspectSnapshotGraphRows } from '../../../storage/read/integrity/snapshot-graph';
import { verifyLiveStorageIntegrity } from '../../../storage/read/integrity/live';
import {
  MAX_ENTITY_STORAGE_VALUE_BYTES,
  prepareEntityStorageLayout,
  readEntityStorageLayout,
} from '../../../storage/schema/entity/layout';
import type { StorageHead } from '../../../storage/types';
import { MemoryRuntimeDb } from '../../fixtures/storage/memory-runtime-db';

const entityId = `0x${'31'.repeat(32)}`;
const validatorId = `0x${'51'.repeat(20)}`;

const route = (index: number): HtlcRoute => ({
  hashlock: `0x${index.toString(16).padStart(64, '0')}`,
  createdHeight: index + 1,
  priceTicks: BigInt(index + 1),
});

const state = (routes = 1, bioBytes = 0): EntityState => ({
  entityId,
  height: 1,
  timestamp: 1_000,
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [validatorId],
    shares: { [validatorId]: 1n },
  },
  reserves: new Map(),
  accounts: PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash),
  lastFinalizedJHeight: 0,
  entityEncryptionPublicKey: `0x${'41'.repeat(32)}`,
  profile: { name: 'entity-graph', isHub: true, avatar: '', bio: 'x'.repeat(bioBytes), website: '' },
  htlcRoutes: PersistentEntityCollectionMap.from(new Map(
    Array.from({ length: routes }, (_, index) => [`route-${index}`, route(index)]),
  )),
  htlcFeesEarned: 0n,
  lockBook: PersistentEntityCollectionMap.empty(),
});

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

const install = async (
  db: MemoryRuntimeDb,
  next: EntityState,
  previous?: EntityState,
) => {
  const layout = prepareEntityStorageLayout(entityId, keyLiveEntity(entityId), next, previous);
  const batch = db.batch();
  for (const key of layout.dels) batch.del(key);
  for (const row of layout.puts) batch.put(row.key, row.value);
  await batch.write();
  return layout;
};

test('Entity checkpoint rows stay bounded and exact Patricia paths are dirty-only', async () => {
  const db = new MemoryRuntimeDb();
  const previous = state(256, 25_000);
  const initial = await install(db, previous);
  expect(Math.max(...initial.puts.map(row => row.value.byteLength)))
    .toBeLessThan(MAX_ENTITY_STORAGE_VALUE_BYTES);
  expect(initial.puts.some(row => row.key[0] === KEY_LIVE_ENTITY_FIELD && row.key.byteLength === 38))
    .toBeTrue();

  const nextRoutes = (previous.htlcRoutes as PersistentEntityCollectionMap<HtlcRoute>)
    .updated('route-128', { ...route(128), amount: 999n });
  const next = { ...previous, height: 2, htlcRoutes: nextRoutes };
  const changed = await install(db, next, previous);
  const initialTreeRows = initial.puts.filter(row =>
    row.key[0] === KEY_LIVE_ENTITY_BRANCH || row.key[0] === KEY_LIVE_ENTITY_LEAF);
  const changedTreeRows = changed.puts.filter(row =>
    row.key[0] === KEY_LIVE_ENTITY_BRANCH || row.key[0] === KEY_LIVE_ENTITY_LEAF);
  expect(changedTreeRows.length).toBeGreaterThan(0);
  expect(changedTreeRows.length).toBeLessThan(initialTreeRows.length / 4);

  const restored = await readEntityStorageLayout(db, entityId, keyLiveEntity(entityId));
  expect(restored?.doc.height).toBe(2);
  expect(restored?.doc.profile.bio.length).toBe(25_000);
  expect(restored?.doc.htlcRoutes.get('route-128')?.amount).toBe(999n);
});

test('Entity snapshot copies and relinks its graph without live rows', async () => {
  const source = new MemoryRuntimeDb();
  const snapshot = new MemoryRuntimeDb();
  const expected = state(32);
  await install(source, expected);
  const headBatch = snapshot.batch();
  headBatch.put(KEY_HEAD, encodeBuffer(head()));
  await headBatch.write();

  const created = await createSnapshot(source, snapshot, 1, 1_000);
  const restored = await readSnapshotDocs(snapshot, 1);
  const entity = restored.find(
    (doc): doc is Extract<(typeof restored)[number], { family: 'entity' }> => doc.family === 'entity',
  );
  expect(entity?.value.htlcRoutes.size).toBe(32);
  expect(snapshot.rows.has(keyLiveEntity(entityId).toString('hex'))).toBeFalse();
  const graphKeys = [...snapshot.rows.keys()].filter(key =>
    Number.parseInt(key.slice(0, 2), 16) === KEY_SNAPSHOT_GRAPH);
  expect(await inspectSnapshotGraphRows(snapshot, 1)).toBe(graphKeys.length);
  expect(created.docCount).toBe(graphKeys.length + 1);
});

test('live integrity rejects an Entity field row absent from its manifest', async () => {
  const db = new MemoryRuntimeDb();
  await install(db, state());
  const batch = db.batch();
  batch.put(keyLiveEntityField(entityId, 0xfe), encodeBuffer('orphan'));
  await batch.write();
  await expect(verifyLiveStorageIntegrity(db)).rejects.toThrow(
    'STORAGE_ENTITY_FIELD_OWNER_MISSING',
  );
});
