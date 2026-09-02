import type { RuntimeReplica } from '../../runtime/types';
import { createHash } from 'node:crypto';
import { withRuntimeCommittedRead } from '../../runtime/frame/lifecycle/writer-lock';
import { unpackRadixMerklePath } from '../../protocol/state/radix-merkle';
import { decodeBuffer, encodeBuffer } from '../codec/codec';
import { readBoundedEncodedValue } from '../codec/bounded-value';
import { iterateKeys } from '../database/level';
import {
  KEY_HEAD,
  KEY_RUNTIME_MACHINE_LEAF,
  decodeEntityId,
  keyFrame,
  keyRscoreCheckpoint,
  keyRuntimeMachineTreePrefix,
  parseAccountJClaimPathNodeKey,
  parseCertifiedBoardPathNodeKey,
  parseLiveAccountBranchKey,
  parseLiveAccountFieldKey,
  parseLiveAccountLeafKey,
  parseLiveBookBranchKey,
  parseLiveBookKey,
  parseLiveBookLeafKey,
  parseLiveEntityBranchKey,
  parseLiveEntityFieldKey,
  parseLiveEntityLeafKey,
  parseRscoreAccountJClaimPathNodeKey,
} from '../keys';
import { RSCORE_PROTOCOL_FINGERPRINT } from '../../rscore/client';
import {
  validateStorageFrameRecordValue,
  validateStorageHeadValue,
} from '../schema/authoritative-schema';
import type { RuntimeStorageApiDeps } from '../runtime-storage-deps';
import type { RuntimeDbLike } from '../types';
import { readRuntimeMachineGraph } from '../wal/runtime-machine-graph';

type HexBytes = `0x${string}`;
type HexRow = readonly [key: HexBytes, value: HexBytes];

/** JSON projection consumed one-for-one by Rust ConcreteCheckpointSource. */
export type ConcreteCheckpointSourceExport = Readonly<{
  height: number;
  frameBytes: HexBytes;
  rootHash: string;
  leafCount: number;
  runtimeMachineLeaves: readonly HexRow[];
  stateRows: readonly HexRow[];
}>;

type ConcreteCheckpointExportDeps = Pick<
  RuntimeStorageApiDeps,
  'getStorageDb' | 'getRuntimeWalDb'
>;

const STATE_TAGS = new Set([
  0x17, 0x18, 0x19, 0x21, 0x22, 0x23, 0x24, 0x26, 0x2a, 0x2b, 0x2c,
  0x2d, 0x2e, 0x2f, 0x30, 0x36, 0x37, 0x38,
]);
const NON_STATE_TAGS = new Set([0x20, 0x31, 0x32, 0x33, 0x34, 0x35]);
const WAL_OWNED_TAGS = [0x17, 0x18, 0x19, 0x26] as const;
const DEDICATED_FIELD_TAGS = new Set([0x24, 0x36]);

const hex = (value: Uint8Array): HexBytes =>
  `0x${Buffer.from(value).toString('hex')}`;

const requireOwnerIds = (key: Buffer, count: 1 | 2): void => {
  const expected = 1 + count * 32;
  if (key.byteLength < expected) throw new Error(`CHECKPOINT_STATE_KEY_SHORT:${hex(key)}`);
  decodeEntityId(key.subarray(1, 33));
  if (count === 2) decodeEntityId(key.subarray(33, 65));
};

/** Keep TS admission parallel with Rust valid_path_key; Rust verifies again on import. */
const assertCanonicalStateKey = (key: Buffer): number => {
  const tag = key[0];
  if (tag === undefined || !STATE_TAGS.has(tag)) {
    throw new Error(`CHECKPOINT_STATE_KEY_TAG:${hex(key)}`);
  }
  if (tag === 0x17 || tag === 0x21) {
    if (key.byteLength !== 33) throw new Error(`CHECKPOINT_STATE_KEY_LENGTH:${hex(key)}`);
    requireOwnerIds(key, 1);
  } else if (tag === 0x18 || tag === 0x22) {
    if (key.byteLength !== 65) throw new Error(`CHECKPOINT_STATE_KEY_LENGTH:${hex(key)}`);
    requireOwnerIds(key, 2);
  } else if (tag === 0x19) {
    assertCanonicalRscoreNodeKey(key);
  } else if (tag === 0x23) parseLiveBookKey(key);
  else if (tag === 0x24) parseLiveAccountFieldKey(key);
  else if (tag === 0x26) assertCanonicalReplicaMetaKey(key);
  else if (tag === 0x2a) parseCertifiedBoardPathNodeKey(key);
  else if (tag === 0x2b) {
    parseCertifiedBoardPathNodeKey(Buffer.concat([Buffer.from([0x2a]), key.subarray(1)]));
  } else if (tag === 0x2c) parseAccountJClaimPathNodeKey(key);
  else if (tag === 0x2d) parseLiveBookBranchKey(key);
  else if (tag === 0x2e) parseLiveBookLeafKey(key);
  else if (tag === 0x2f) parseLiveAccountBranchKey(key);
  else if (tag === 0x30) parseLiveAccountLeafKey(key);
  else if (tag === 0x36) parseLiveEntityFieldKey(key);
  else if (tag === 0x37) parseLiveEntityBranchKey(key);
  else if (tag === 0x38) parseLiveEntityLeafKey(key);
  return tag;
};

const assertCanonicalRscoreNodeKey = (key: Buffer): void => {
  requireOwnerIds(key, 2);
  if (key.byteLength < 68) throw new Error(`CHECKPOINT_RSCORE_NODE_KEY_SHORT:${hex(key)}`);
  const namespace = key[65];
  const kind = key[66];
  const payload = key.subarray(67);
  if (namespace === 6) {
    parseRscoreAccountJClaimPathNodeKey(key);
    return;
  }
  if (namespace === undefined || namespace < 1 || namespace > 5 || (kind !== 0 && kind !== 1)) {
    throw new Error(`CHECKPOINT_RSCORE_NODE_KEY_HEADER:${hex(key)}`);
  }
  if (kind === 0) unpackRadixMerklePath(16, payload);
  else if (payload.byteLength === 0) throw new Error(`CHECKPOINT_RSCORE_NODE_KEY_EMPTY:${hex(key)}`);
};

const assertCanonicalReplicaMetaKey = (key: Buffer): void => {
  if (key.byteLength !== 65) throw new Error(`CHECKPOINT_REPLICA_META_KEY_LENGTH:${hex(key)}`);
  requireOwnerIds(key, 1);
  if (key.subarray(33, 45).some(byte => byte !== 0)) {
    throw new Error(`CHECKPOINT_REPLICA_META_SIGNER_PADDING:${hex(key)}`);
  }
};

const requiredBounded = async (db: RuntimeDbLike, key: Buffer): Promise<Buffer> => {
  const value = await readBoundedEncodedValue(db, key);
  if (!value) throw new Error(`CHECKPOINT_ROW_MISSING:${hex(key)}`);
  return value;
};

const addCanonicalEmptyAccountAuthority = (
  rows: Map<string, Buffer>,
  ownerHex: string,
): void => {
  const accountTags = new Set([0x17, 0x18, 0x19]);
  const present = [...rows.keys()].filter(key => accountTags.has(Number.parseInt(key.slice(0, 2), 16)));
  if (present.some(key => key.startsWith('17'))) return;
  if (present.length > 0) throw new Error('CHECKPOINT_RSCORE_META_MISSING');
  const ownerEntityId = `0x${ownerHex}`;
  const signerDigest = createHash('sha256')
    .update('xln.rscore.signer-config.v1')
    .digest('hex');
  rows.set(keyRscoreCheckpoint(ownerEntityId).toString('hex'), encodeBuffer({
    version: 1,
    ownerEntityId,
    protocolFingerprint: `0x${RSCORE_PROTOCOL_FINGERPRINT.toString('hex')}`,
    baseRevision: '0',
    revision: '0',
    accountsRoot: `0x${'00'.repeat(32)}`,
    signerDigest: `0x${signerDigest}`,
    accountCount: 0,
  }));
};

const readStateRows = async (currentDb: RuntimeDbLike, walDb: RuntimeDbLike): Promise<HexRow[]> => {
  const rows = new Map<string, Buffer>();
  const owners = new Set<string>();
  const add = async (db: RuntimeDbLike, key: Buffer): Promise<void> => {
    const tag = assertCanonicalStateKey(key);
    owners.add(key.subarray(1, 33).toString('hex'));
    const value = DEDICATED_FIELD_TAGS.has(tag)
      ? await db.get(key)
      : await requiredBounded(db, key);
    const id = key.toString('hex');
    const previous = rows.get(id);
    if (previous && !previous.equals(value)) {
      throw new Error(`CHECKPOINT_STATE_SOURCE_DIVERGED:0x${id}`);
    }
    rows.set(id, value);
  };
  for await (const key of iterateKeys(currentDb, { gte: Buffer.from([0x17]), lt: Buffer.from([0x39]) })) {
    const tag = key[0];
    if (tag === undefined) throw new Error('CHECKPOINT_STATE_KEY_EMPTY');
    if (STATE_TAGS.has(tag)) await add(currentDb, key);
    else if (!NON_STATE_TAGS.has(tag)) throw new Error(`CHECKPOINT_STATE_TAG_NONCANONICAL:0x${tag.toString(16)}`);
  }
  for (const tag of WAL_OWNED_TAGS) {
    for await (const key of iterateKeys(walDb, { prefix: Buffer.from([tag]) })) await add(walDb, key);
  }
  if (rows.size === 0) throw new Error('CHECKPOINT_STATE_ROWS_EMPTY');
  if (owners.size !== 1) throw new Error(`CHECKPOINT_STATE_OWNER_COUNT:${owners.size}`);
  const owner = [...owners][0];
  if (!owner) throw new Error('CHECKPOINT_STATE_OWNER_MISSING');
  addCanonicalEmptyAccountAuthority(rows, owner);
  return [...rows.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [`0x${key}`, hex(value)] as const);
};

const readMachineLeaves = async (
  walDb: RuntimeDbLike,
  leafCount: number,
): Promise<HexRow[]> => {
  const prefix = keyRuntimeMachineTreePrefix(KEY_RUNTIME_MACHINE_LEAF);
  const rows: HexRow[] = [];
  for await (const key of iterateKeys(walDb, { prefix })) {
    if (key.byteLength <= prefix.byteLength) throw new Error('CHECKPOINT_MACHINE_LEAF_KEY_EMPTY');
    rows.push([hex(key.subarray(prefix.byteLength)), hex(await walDb.get(key))]);
  }
  if (rows.length !== leafCount) {
    throw new Error(`CHECKPOINT_MACHINE_LEAF_COUNT:expected=${leafCount}:actual=${rows.length}`);
  }
  return rows;
};

/**
 * Export one immutable common-bootstrap graph while the live Runtime writer is
 * fenced. No DB copy is needed: current owns the disposable Entity graph and
 * the WAL owns frame/leaves plus Account authority and replica metadata.
 */
export const exportConcreteCheckpointSource = async (
  env: RuntimeReplica,
  deps: ConcreteCheckpointExportDeps,
): Promise<ConcreteCheckpointSourceExport> => withRuntimeCommittedRead(env, async () => {
  const height = env.state.height;
  if (!Number.isSafeInteger(height) || height < 1) throw new Error(`CHECKPOINT_HEIGHT_INVALID:${height}`);
  const currentDb = deps.getStorageDb(env, 'current');
  const walDb = deps.getRuntimeWalDb(env);
  const head = validateStorageHeadValue(decodeBuffer(await requiredBounded(walDb, KEY_HEAD)));
  const currentMaterializedHeight = Math.max(
    0,
    Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)),
  );
  if (currentMaterializedHeight !== height) {
    throw new Error(
      `CHECKPOINT_MACHINE_NOT_CURRENT:requested=${height}:current=${currentMaterializedHeight}`,
    );
  }
  const frameBytes = await requiredBounded(walDb, keyFrame(height));
  const frame = validateStorageFrameRecordValue(decodeBuffer(frameBytes));
  if (frame.height !== height) throw new Error(`CHECKPOINT_FRAME_HEIGHT:${frame.height}:${height}`);
  if (!frame.materializedState || !frame.runtimeMachineRoot) {
    throw new Error(`CHECKPOINT_FRAME_NOT_MATERIALIZED:${height}`);
  }
  // Rebuild once here so a malformed/truncated graph never leaves TS as an artifact.
  await readRuntimeMachineGraph(walDb, frame.runtimeMachineRoot);
  const runtimeMachineLeaves = await readMachineLeaves(
    walDb,
    frame.runtimeMachineRoot.leafCount,
  );
  const stateRows = await readStateRows(currentDb, walDb);
  return {
    height,
    frameBytes: hex(frameBytes),
    rootHash: frame.runtimeMachineRoot.rootHash,
    leafCount: frame.runtimeMachineRoot.leafCount,
    runtimeMachineLeaves,
    stateRows,
  };
});
