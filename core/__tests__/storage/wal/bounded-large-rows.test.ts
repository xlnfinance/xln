import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Level } from 'level';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  getRuntimeStorageDb,
  getRuntimeWalDb,
  loadEnvFromDB,
  saveEnvToDB,
} from '../../../runtime.ts';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { createEmptyBatch } from '../../../jurisdiction/machine/batch';
import { parseProfile } from '../../../entity/profile';
import { HTLC_OPAQUE_CIPHERTEXT_VERSION } from '../../../protocol/htlc/multi-recipient';
import { computeIntegrityDigest } from '../../../support/bytes/integrity-checksum';
import {
  MAX_PHYSICAL_STORAGE_VALUE_BYTES,
  prepareBoundedStorageValueRows,
  readBoundedEncodedValue,
} from '../../../storage/codec/bounded-value';
import { encodeBuffer, writeBatch } from '../../../storage/codec/codec';
import { createSnapshot, maybeRotateSnapshots, pruneWalBeforeHeight } from '../../../storage/database/lifecycle';
import { iterateKeys } from '../../../storage/database/level';
import { createSnapshotRuntimeMachineGraphView } from '../../../storage/database/snapshot-graph-view';
import { inspectSnapshotGraphRows } from '../../../storage/read/integrity/snapshot-graph';
import { exportConcreteCheckpointSource } from '../../../storage/read/concrete-checkpoint-source';
import { toRuntimeMachineRootHash } from '../../../protocol/hashes';
import {
  KEY_BOUNDED_VALUE_CHUNK,
  KEY_HEAD,
  KEY_SNAPSHOT_GRAPH,
  STORAGE_SCHEMA_VERSION,
  keyEntityContextPayload,
} from '../../../storage/keys';
import {
  prepareEntityContextPayloadRows,
  readEntityContextPayloads,
} from '../../../storage/wal/entity-context-payload';
import {
  decodeRuntimeMachineGraphLeaves,
  prepareRuntimeMachineGraphRows,
  prepareRuntimeMachineGraphWrite,
  readRuntimeMachineGraph,
} from '../../../storage/wal/runtime-machine-graph';
import { buildStorageRuntimeMachineSnapshot } from '../../../storage/wal/snapshot';
import type { EntityInfraContext } from '../../../types/entity/infra-context';
import type { StorageHead } from '../../../storage/types';
import type { JReplica, JTx } from '../../../types/jurisdiction-runtime';

const ENTITY_ID = `0x${'11'.repeat(32)}`;
const SIGNER_ID = `0x${'22'.repeat(20)}`;
const REPLICA_ID = `${ENTITY_ID}:${SIGNER_ID}`;
const NEXT_HOP = `0x${'aa'.repeat(32)}`;
const KEY = `0x${'22'.repeat(32)}`;
const RUNTIME_HEIGHT = 17;
const J_NAME = 'bounded-rows-j';

type Db = Level<Buffer, Buffer>;

const openDbs: Db[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(openDbs.splice(0).map(db => db.close()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const openDb = async (): Promise<Db> => {
  const dir = mkdtempSync(join(tmpdir(), 'xln-bounded-rows-'));
  tempDirs.push(dir);
  const db = new Level<Buffer, Buffer>(dir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await db.open();
  openDbs.push(db);
  return db;
};

const putRows = async (db: Db, rows: readonly Readonly<{ key: Buffer; value: Buffer }>[]): Promise<void> => {
  const batch = db.batch();
  for (const row of rows) batch.put(row.key, row.value);
  await writeBatch(batch);
};

const allKeys = async (db: Db): Promise<string[]> => {
  const keys: string[] = [];
  for await (const key of iterateKeys(db, {})) keys.push(key.toString('hex'));
  return keys;
};

const rowsDigest = (rows: readonly Readonly<{ key: Buffer; value: Buffer }>[]): string => {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(row.key).update(row.value);
  return hash.digest('hex');
};

const id = (value: number): string => `0x${value.toString(16).padStart(64, '0')}`;

/** A peer-signed gossip profile is admissible up to 1 MiB; 240 accounts is ~20 KB. */
const largeProfile = () => parseProfile({
  entityId: NEXT_HOP,
  entityEncryptionPublicKey: KEY,
  name: 'wide-hub',
  avatar: '',
  bio: '',
  website: '',
  lastUpdated: 1,
  runtimeId: `0x${'11'.repeat(20)}`,
  runtimeEncPubKey: KEY,
  publicAccounts: [],
  wsUrl: null,
  relays: [],
  metadata: { isHub: true, routingFeePPM: 1, baseFee: 0n, profileHanko: `0x${'33'.repeat(65)}` },
  accounts: Array.from({ length: 240 }, (_, index) => ({
    counterpartyId: id(index + 1),
    domain: { chainId: 31337, depositoryAddress: `0x${'11'.repeat(20)}` },
    tokenCapacities: { 1: { inCapacity: 1n, outCapacity: 1n } },
  })),
});

/** A forwarded onion layer is peer-chosen opaque ciphertext; 15 KB packs to ~20 KB base64. */
const forwardEntry = (ciphertextBytes: number) => ({
  binding: {
    fromEntityId: `0x${'44'.repeat(32)}`,
    toEntityId: ENTITY_ID,
    domain: { chainId: 31337, depositoryAddress: `0x${'aa'.repeat(20)}` },
    accountFrameHash: `0x${'45'.repeat(32)}`,
    accountHeight: 3,
    envelopeHash: `0x${'55'.repeat(32)}`,
    hashlock: `0x${'66'.repeat(32)}`,
    tokenId: 1,
    amount: 1_000n,
    timelock: 10n,
    revealBeforeHeight: 100,
  },
  outcome: {
    kind: 'forward' as const,
    nextHopEntityId: NEXT_HOP,
    forwardAmount: 999n,
    innerEnvelope: {
      version: HTLC_OPAQUE_CIPHERTEXT_VERSION,
      ciphertext: Buffer.alloc(ciphertextBytes, 0x5c).toString('base64'),
    },
  },
});

const context = (
  gossipProfiles: EntityInfraContext['gossipProfiles'],
  ciphertextBytes: number,
): EntityInfraContext => ({
  version: 1,
  proposerReplicaId: REPLICA_ID,
  entityId: ENTITY_ID,
  proposerSignerId: SIGNER_ID,
  parentFrameHash: `0x${'33'.repeat(32)}`,
  height: 2,
  gossipProfiles,
  peerAssertions: [{ entityId: NEXT_HOP, online: true }],
  htlc: { version: 1, entries: [forwardEntry(ciphertextBytes)], originated: [] },
});

const batchTx = (encodedBatchBytes: number): JTx => ({
  type: 'batch',
  entityId: ENTITY_ID,
  data: {
    batch: createEmptyBatch(),
    batchSize: 0,
    encodedBatch: `0x${'ab'.repeat(encodedBatchBytes)}`,
    batchHash: `0x${'cd'.repeat(32)}`,
    entityNonce: 1,
  },
  timestamp: 1_000,
});

const installJWithPendingBatch = (
  env: ReturnType<typeof createEmptyEnv>,
  encodedBatchBytes: number,
): void => {
  env.state.jReplicas.set(J_NAME, {
    name: J_NAME,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [batchTx(encodedBatchBytes)],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
    rpcs: [`browservm://${J_NAME}`],
    chainId: 31337,
    contracts: {
      depository: '0x000000000000000000000000000000000000dead',
      entityProvider: '0x000000000000000000000000000000000000beef',
      account: '0x000000000000000000000000000000000000ac01',
      deltaTransformer: '0x000000000000000000000000000000000000de17',
    },
  } as JReplica);
};

const machineWithPendingBatch = (encodedBatchBytes: number) => {
  const env = createEmptyEnv(`bounded-machine-${encodedBatchBytes}`);
  installJWithPendingBatch(env, encodedBatchBytes);
  return buildStorageRuntimeMachineSnapshot(env);
};

const chunkKeys = (keys: readonly string[]): string[] =>
  keys.filter(key => key.startsWith(KEY_BOUNDED_VALUE_CHUNK.toString(16).padStart(2, '0')));

describe('bounded physical rows for peer-sized Entity contexts', () => {
  test('a >10 KB profile leaf and HTLC envelope leaf round-trip through LevelDB and the replay reader', async () => {
    const large = context([largeProfile()], 15_000);
    const prepared = prepareEntityContextPayloadRows(RUNTIME_HEIGHT, new Map([[REPLICA_ID, large]]));
    expect(prepared.rows.every(row => row.value.byteLength < MAX_PHYSICAL_STORAGE_VALUE_BYTES)).toBe(true);

    const db = await openDb();
    await putRows(db, prepared.rows);
    for (const kind of ['gossipProfile', 'htlcEntry'] as const) {
      // The digest page binds the logical leaf bytes; the owner row is a manifest.
      const logical = await readBoundedEncodedValue(db, keyEntityContextPayload(RUNTIME_HEIGHT, REPLICA_ID, kind, 0));
      expect(logical!.byteLength).toBeGreaterThan(MAX_PHYSICAL_STORAGE_VALUE_BYTES);
    }
    expect(chunkKeys(await allKeys(db)).length).toBeGreaterThanOrEqual(4);
    const restored = await readEntityContextPayloads(db, RUNTIME_HEIGHT, prepared.refs);
    expect(restored.get(REPLICA_ID)).toEqual(large);
  });

  test('WAL prune deletes context rows and their chunk rows with the pruned height', async () => {
    const prepared = prepareEntityContextPayloadRows(
      RUNTIME_HEIGHT,
      new Map([[REPLICA_ID, context([largeProfile()], 15_000)]]),
    );
    const db = await openDb();
    await putRows(db, prepared.rows);
    expect(chunkKeys(await allKeys(db)).length).toBeGreaterThan(0);
    await pruneWalBeforeHeight(db, RUNTIME_HEIGHT + 1);
    expect(await allKeys(db)).toEqual([]);
  });

  test('a context under 10 KB keeps its exact pre-chunking rows and digest', () => {
    const small = context([], 64);
    const prepared = prepareEntityContextPayloadRows(RUNTIME_HEIGHT, new Map([[REPLICA_ID, small]]));
    expect(prepared.rows.some(row => row.key[0] === KEY_BOUNDED_VALUE_CHUNK)).toBe(false);
    // Golden captured on ac2ab22e7, before any leaf used the bounded layout.
    expect(rowsDigest(prepared.rows)).toBe(
      'bcad50b2c8160caee16fbca7c4464dc4bf4cdfffc6a50779d44cfeacb743e982',
    );
    expect(prepared.refs.get(REPLICA_ID)).toBe(
      '0x199b597b25ddd9a63a264fbebfd004a5df19a933fbb635d37719336a5ccfbb2d',
    );
  });
});

describe('bounded physical rows for Runtime-machine graph atoms', () => {
  test('a pending J batch with a 30 KB encodedBatch checkpoints and restores through the WAL', async () => {
    const seed = `bounded-machine-wal ${process.pid} alpha beta gamma`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    const dbRoot = process.env['XLN_DB_PATH'] || 'db-tmp/runtime';
    const namespace = join(dbRoot, runtimeId);
    const cleanup = () => {
      for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-history-views', '-events', '-infra']) {
        rmSync(`${namespace}${suffix}`, { recursive: true, force: true });
      }
    };
    cleanup();
    mkdirSync(dbRoot, { recursive: true });
    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.state.height = 1;
    env.state.timestamp = 1_000;
    env.quietRuntimeLogs = true;
    installJWithPendingBatch(env, 30_000);
    try {
      await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [], new Map());
      // The Rust parity export carries each leaf's logical bytes, never a manifest.
      const exported = await exportConcreteCheckpointSource(env, {
        getStorageDb: getRuntimeStorageDb,
        getRuntimeWalDb,
      });
      const exportedMachine = decodeRuntimeMachineGraphLeaves(
        exported.runtimeMachineLeaves.map(([path, value]) => ({
          pathBytes: Buffer.from(path.slice(2), 'hex'),
          valueBytes: Buffer.from(value.slice(2), 'hex'),
        })),
        { rootHash: toRuntimeMachineRootHash(exported.rootHash), leafCount: exported.leafCount },
      );
      expect(exportedMachine['jReplicas']).toEqual(buildStorageRuntimeMachineSnapshot(env)['jReplicas']);
      await closeRuntimeDb(env);
      await closeInfraDb(env);
      const restored = await loadEnvFromDB(runtimeId, seed);
      if (!restored) throw new Error('TEST_BOUNDED_MACHINE_RESTORE_MISSING');
      const pending = restored.state.jReplicas.get(J_NAME)?.mempool[0];
      expect(pending).toEqual(batchTx(30_000));
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    } finally {
      cleanup();
    }
  });

  test('graph rewrite, snapshot copy, snapshot verify and snapshot GC own every chunk row', async () => {
    const large = machineWithPendingBatch(30_000);
    const prepared = prepareRuntimeMachineGraphRows(large);
    if (!prepared.root) throw new Error('TEST_MACHINE_ROOT_MISSING');
    expect(prepared.rows.every(row => row.value.byteLength < MAX_PHYSICAL_STORAGE_VALUE_BYTES)).toBe(true);

    const db = await openDb();
    const first = await prepareRuntimeMachineGraphWrite(db, large);
    expect(first.dels).toEqual([]);
    await putRows(db, first.rows);
    expect(chunkKeys(await allKeys(db)).length).toBe(4);
    expect(await readRuntimeMachineGraph(db, prepared.root)).toEqual(large);

    const height = 5;
    const head = encodeBuffer({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      latestHeight: height,
      latestMaterializedHeight: height,
      latestSnapshotHeight: 0,
      snapshotPeriodFrames: 1,
      retainSnapshots: 1,
      epochMaxBytes: Number.MAX_SAFE_INTEGER,
      accountMerkleRadix: 16,
      epochReplayBytes: 0,
      retainedWalBytes: 0,
    } satisfies StorageHead);
    await putRows(db, [{ key: KEY_HEAD, value: head }]);
    const snapshot = await createSnapshot(db, db, height);
    expect(snapshot.docCount).toBe(prepared.rows.length);
    const snapshotChunks = (await allKeys(db)).filter(key =>
      key.startsWith(`${KEY_SNAPSHOT_GRAPH.toString(16)}${height.toString(16).padStart(16, '0')}11`));
    expect(snapshotChunks.length).toBe(4);
    expect(await readRuntimeMachineGraph(createSnapshotRuntimeMachineGraphView(db, height), prepared.root))
      .toEqual(large);
    expect(await inspectSnapshotGraphRows(db, height, prepared.root)).toBe(prepared.rows.length);

    // An orphan continuation under the snapshot graph must fail verification.
    const orphan = Buffer.from(`${snapshotChunks[0]!.slice(0, -8)}000000ff`, 'hex');
    await putRows(db, [{ key: orphan, value: Buffer.from([1]) }]);
    await expect(inspectSnapshotGraphRows(db, height, prepared.root))
      .rejects.toThrow('STORAGE_SNAPSHOT_GRAPH_CHUNK_ORPHAN');
    await db.del(orphan);

    const small = machineWithPendingBatch(32);
    const second = await prepareRuntimeMachineGraphWrite(db, small);
    const batch = db.batch();
    for (const key of second.dels) batch.del(key);
    for (const row of second.rows) batch.put(row.key, row.value);
    await writeBatch(batch);
    const smallRoot = prepareRuntimeMachineGraphRows(small).root!;
    expect(await readRuntimeMachineGraph(db, smallRoot)).toEqual(small);
    // Live chunk rows of the replaced atom are gone; snapshot copies remain.
    expect(chunkKeys(await allKeys(db))).toEqual([]);
    expect(await readRuntimeMachineGraph(createSnapshotRuntimeMachineGraphView(db, height), prepared.root))
      .toEqual(large);

    await maybeRotateSnapshots(db, 0);
    expect((await allKeys(db)).filter(key => key.startsWith(KEY_SNAPSHOT_GRAPH.toString(16)))).toEqual([]);
  });

  test('a machine under 10 KB keeps its exact pre-chunking rows and root', () => {
    const prepared = prepareRuntimeMachineGraphRows(machineWithPendingBatch(32));
    expect(prepared.rows.some(row => row.key[0] === KEY_BOUNDED_VALUE_CHUNK)).toBe(false);
    // Golden captured on ac2ab22e7, before any atom used the bounded layout.
    expect(rowsDigest(prepared.rows)).toBe(
      '243753f0d6a94a1d716b0a5c551f84107e299ac3b02c9c2184306b79cfa8b713',
    );
    expect(prepared.root?.rootHash).toBe(
      '0xb05bbf1aeb66ce1b6eefbab5e8da1414602d7fec42bf7df1003083cac859089b',
    );
  });
});

describe('bounded manifest bytes shared with Rust', () => {
  test('the TS manifest for a 10,000-byte value equals the Rust bounded.rs golden', () => {
    const rows = prepareBoundedStorageValueRows(Buffer.from([0x16, 0x01]), Buffer.alloc(10_000, 0x5a));
    expect(rows).toHaveLength(3);
    expect(rows[0]!.value.toString('hex')).toBe(
      '03d4724095aa627974654c656e677468aa6368756e6b436f756e74a6646967657374a46b696e64a776657273696f6ecd271002' +
      'c720482fa3eb87256b150eb851e6eb6e679eafb0151f8944f5e16e9cac6a67d424a67fac626f756e64656456616c756501',
    );
    expect(computeIntegrityDigest(Buffer.alloc(10_000, 0x5a)).toLowerCase())
      .toBe('0x2fa3eb87256b150eb851e6eb6e679eafb0151f8944f5e16e9cac6a67d424a67f');
  });
});
