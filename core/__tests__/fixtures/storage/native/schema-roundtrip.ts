import { strict as assert } from 'node:assert';
import { safeStringify } from '../../../../protocol/serialization';
import { computeEntityAccountValueHash } from '../../../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../../../entity/state/persistent-account-map';
import { PersistentEntityCollectionMap } from '../../../../entity/state/persistent-collection-map';
import type { EntityState, PaybookEntry } from '../../../../entity/types';
import { decodeBuffer, encodeBuffer } from '../../../../storage/codec/codec';
import { STORAGE_SCHEMA_VERSION, keyLiveEntity } from '../../../../storage/keys';
import { validateStorageHeadValue } from '../../../../storage/schema/authoritative-schema';
import { decodeEntityGraphManifest, prepareEntityStorageLayout } from '../../../../storage/schema/entity/layout';
import type { StorageHead } from '../../../../storage/types';

const [mode, entityId = '0x' + '31'.repeat(32), signerId = '0x' + '51'.repeat(20)] = process.argv.slice(2);
const head: StorageHead = {
  schemaVersion: STORAGE_SCHEMA_VERSION, latestHeight: 0, latestMaterializedHeight: 0,
  latestSnapshotHeight: 0, snapshotPeriodFrames: 10000, retainSnapshots: Number.MAX_SAFE_INTEGER,
  epochMaxBytes: Number.MAX_SAFE_INTEGER, accountMerkleRadix: 16, epochReplayBytes: 0, retainedWalBytes: 0,
};
if (mode === 'emit') {
  const state: EntityState = {
    entityId, height: 0, timestamp: 100, nonces: new Map(), proposals: new Map(),
    config: { mode: 'proposer-based', threshold: 1n, validators: [signerId], shares: { [signerId]: 1n } },
    leaderState: { activeValidatorId: signerId, view: 0, changedAtHeight: 0 },
    reserves: new Map([[1, 123n]]), accounts: PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash),
    lastFinalizedJHeight: 0, entityEncryptionPublicKey: '0x' + '41'.repeat(32),
    profile: { name: 'current-storage-schema', isHub: false, avatar: '', bio: '', website: '' },
    paybook: { entries: PersistentEntityCollectionMap.from<PaybookEntry>(new Map(), 'paybookHashlock'), feesEarned: 0n },
  };
  const layout = prepareEntityStorageLayout(entityId, keyLiveEntity(entityId), state);
  console.log(safeStringify({
    rows: layout.puts.map(row => [row.key.toString('hex'), row.value.toString('hex')]),
    currentHead: encodeBuffer(head).toString('hex'),
    oldHead: encodeBuffer({ ...head, schemaVersion: 5 }).toString('hex'),
    oldManifest: encodeBuffer({ ...decodeEntityGraphManifest(layout.rootValue), schemaVersion: 5 }).toString('hex'),
  }));
} else if (mode === 'manifest') {
  const manifest = decodeEntityGraphManifest(Buffer.from((await Bun.stdin.text()).trim(), 'hex'));
  assert.equal(manifest.schemaVersion, STORAGE_SCHEMA_VERSION);
  assert(manifest.fields.length > 0);
  console.log('TS_CURRENT_MANIFEST_ACCEPTED');
} else if (mode === 'head') {
  const current = validateStorageHeadValue(decodeBuffer(Buffer.from((await Bun.stdin.text()).trim(), 'hex')));
  assert.equal(current.schemaVersion, STORAGE_SCHEMA_VERSION);
  console.log('TS_CURRENT_HEAD_ACCEPTED');
} else {
  throw new Error('STORAGE_SCHEMA_FIXTURE_MODE');
}
