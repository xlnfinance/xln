/**
 * Proposer infrastructure observations are replay inputs, not Runtime state.
 * Each exact context is stored once and WAL frames commit replica-id → hash
 * references. Recovery verifies the bytes before allowing deterministic replay.
 *
 * One physical LevelDB value is capped at 10 KB. A 4-hop HTLC context carries
 * four gossip Profiles (~2.5–3.1 KB each) plus the prepared HTLC envelope, so
 * the canonical RAM object does not fit in one record. Store a tiny manifest
 * plus content-addressed Profile and HTLC leaves; never byte-chunk an opaque
 * blob, which would create a second storage layout beside the typed records.
 */
import type { EntityInfraContext } from '../../types/entity/infra-context';
import type {
  HtlcPreparedInfraContext,
  PreparedHtlcEntry,
  PreparedOriginatedHtlcPayment,
} from '../../types/entity/htlc-infra-context';
import type { Profile } from '../../entity/profile';
import { validateEntityInfraContext } from '../../entity/consensus/frame/infra-context-validation';
import { computeIntegrityDigest } from '../../support/integrity-checksum';
import {
  toEntityContextPayloadHash,
  type EntityContextPayloadHash,
} from '../../protocol/hashes';
import { decodeBuffer, encodeBuffer } from '../codec/codec';
import { keyEntityContextPayload } from '../keys';
import type {
  RuntimeDbLike,
} from '../types';

export const MAX_ENTITY_CONTEXT_PAYLOAD_BYTES = 10_000;

type StoredEntityContextManifest = Readonly<{
  kind: 'entityContext';
  version: 1;
  header: Omit<EntityInfraContext, 'gossipProfiles' | 'htlc'>;
  profileRefs: EntityContextPayloadHash[];
  /**
   * One leaf per prepared HTLC rather than one leaf for the whole frame. A Hub
   * that batches carries as many prepared HTLCs as the batch is wide, and a
   * single combined leaf crossed the 10 KB record cap at 49 entries and halted
   * the Runtime. Per-entry leaves also dedupe: an entry repeated across
   * replicas or retried frames is stored once by content address.
   */
  htlcEntryRefs: EntityContextPayloadHash[];
  htlcOriginatedRefs: EntityContextPayloadHash[];
}>;

type StoredGossipProfile = Readonly<{
  kind: 'gossipProfile';
  version: 1;
  profile: Profile;
}>;

type StoredHtlcEntry = Readonly<{
  kind: 'htlcEntry';
  version: 1;
  entry: PreparedHtlcEntry;
}>;

type StoredHtlcOriginated = Readonly<{
  kind: 'htlcOriginated';
  version: 1;
  originated: PreparedOriginatedHtlcPayment;
}>;

type StoredEntityContextRow =
  | StoredEntityContextManifest
  | StoredGossipProfile
  | StoredHtlcEntry
  | StoredHtlcOriginated;

type PayloadRow = Readonly<{
  key: Buffer;
  value: Buffer;
}>;

const hashContext = (value: Uint8Array): EntityContextPayloadHash =>
  toEntityContextPayloadHash(computeIntegrityDigest(value).toLowerCase());

const assertReplicaId = (replicaId: string, code: string): void => {
  if (
    replicaId !== replicaId.toLowerCase() ||
    !/^0x[0-9a-f]{64}:0x[0-9a-f]{40}(:[1-9][0-9]*)?$/.test(replicaId)
  ) throw new Error(`${code}:${replicaId}`);
};

const assertAppliedReplicaEntity = (
  appliedReplicaId: string,
  context: EntityInfraContext,
): void => {
  const appliedEntityId = appliedReplicaId.split(':')[0];
  if (appliedEntityId !== context.entityId) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_REPLICA_BINDING:${appliedReplicaId}`);
  }
};

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${code}_FIELDS:${actual.join(',')}`);
  }
};

const payloadBudgetLabel = (payload: StoredEntityContextRow): string => {
  if (payload.kind === 'gossipProfile') return `gossipProfile:${payload.profile.entityId}`;
  if (payload.kind === 'htlcEntry') return `htlcEntry:${payload.entry.binding.lockId}`;
  if (payload.kind === 'htlcOriginated') return `htlcOriginated:${payload.originated.lockId}`;
  return `entityContext:profiles=${payload.profileRefs.length}:htlc=${payload.htlcEntryRefs.length}`;
};

const prepareRow = (
  payload: StoredEntityContextRow,
  rowsByHash: Map<EntityContextPayloadHash, PayloadRow>,
): EntityContextPayloadHash => {
  const value = encodeBuffer(payload, { omitSymbolKeys: true });
  if (value.byteLength > MAX_ENTITY_CONTEXT_PAYLOAD_BYTES) {
    throw new Error(
      `STORAGE_ENTITY_CONTEXT_PAYLOAD_TOO_LARGE:${value.byteLength}:` +
      `max=${MAX_ENTITY_CONTEXT_PAYLOAD_BYTES}:${payloadBudgetLabel(payload)}`,
    );
  }
  const hash = hashContext(value);
  rowsByHash.set(hash, { key: keyEntityContextPayload(hash), value });
  return hash;
};

export const prepareEntityContextPayloadRows = (
  contexts: ReadonlyMap<string, EntityInfraContext>,
) => {
  const refs = new Map<string, EntityContextPayloadHash>();
  const rowsByHash = new Map<EntityContextPayloadHash, PayloadRow>();
  for (const [replicaId, context] of contexts) {
    assertReplicaId(replicaId, 'STORAGE_ENTITY_CONTEXT_REPLICA_ID_INVALID');
    const decoded = validateEntityInfraContext(context);
    // A catch-up frame is proposed by one signer and applied by another local
    // replica. The map key binds the recipient Entity; the payload's validated
    // proposerReplicaId independently binds the proposer identity.
    assertAppliedReplicaEntity(replicaId, decoded);
    const profileRefs = decoded.gossipProfiles.map(profile => prepareRow({
      kind: 'gossipProfile',
      version: 1,
      profile,
    }, rowsByHash));
    const htlcEntryRefs = decoded.htlc.entries.map(entry => prepareRow({
      kind: 'htlcEntry',
      version: 1,
      entry,
    }, rowsByHash));
    const htlcOriginatedRefs = decoded.htlc.originated.map(originated => prepareRow({
      kind: 'htlcOriginated',
      version: 1,
      originated,
    }, rowsByHash));
    refs.set(replicaId, prepareRow({
      kind: 'entityContext',
      version: 1,
      header: {
        version: decoded.version,
        proposerReplicaId: decoded.proposerReplicaId,
        entityId: decoded.entityId,
        proposerSignerId: decoded.proposerSignerId,
        parentFrameHash: decoded.parentFrameHash,
        height: decoded.height,
        peerAssertions: decoded.peerAssertions,
      },
      profileRefs,
      htlcEntryRefs,
      htlcOriginatedRefs,
    }, rowsByHash));
  }
  return { refs, rows: [...rowsByHash.values()] };
};

export const decodeEntityContextPayloadRefs = (
  value: unknown,
  code: string,
): Map<string, EntityContextPayloadHash> => {
  if (!(value instanceof Map) || value.size > 10_000) throw new Error(code);
  const refs = new Map<string, EntityContextPayloadHash>();
  for (const [replicaId, rawHash] of value) {
    if (typeof replicaId !== 'string' || typeof rawHash !== 'string') {
      throw new Error(`${code}:ENTRY`);
    }
    assertReplicaId(replicaId, `${code}:REPLICA_ID`);
    refs.set(replicaId, toEntityContextPayloadHash(rawHash.toLowerCase()));
  }
  return refs;
};

const readVerifiedPayload = async (
  db: Pick<RuntimeDbLike, 'get'>,
  replicaId: string,
  ref: EntityContextPayloadHash,
): Promise<unknown> => {
  let value: Buffer;
  try {
    value = await db.get(keyEntityContextPayload(ref));
  } catch (error) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_PAYLOAD_MISSING:${replicaId}:${ref}`, {
      cause: error,
    });
  }
  if (value.byteLength > MAX_ENTITY_CONTEXT_PAYLOAD_BYTES) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_PAYLOAD_TOO_LARGE:${replicaId}`);
  }
  const actual = hashContext(value);
  if (actual !== ref) {
    throw new Error(
      `STORAGE_ENTITY_CONTEXT_PAYLOAD_HASH_MISMATCH:${replicaId}:` +
      `expected=${ref}:actual=${actual}`,
    );
  }
  return decodeBuffer(value);
};

const decodeHashList = (value: unknown, code: string): EntityContextPayloadHash[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value.map(entry => {
    if (typeof entry !== 'string') throw new Error(`${code}:ENTRY`);
    return toEntityContextPayloadHash(entry.toLowerCase());
  });
};

const decodeGossipProfileLeaf = (value: unknown, replicaId: string): Profile => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_PROFILE_INVALID:${replicaId}`);
  exactKeys(raw, ['kind', 'version', 'profile'], `STORAGE_ENTITY_CONTEXT_PROFILE_INVALID:${replicaId}`);
  if (raw['kind'] !== 'gossipProfile' || raw['version'] !== 1) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_PROFILE_KIND:${replicaId}`);
  }
  return raw['profile'] as Profile;
};

const decodeHtlcEntryLeaf = (value: unknown, replicaId: string): PreparedHtlcEntry => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_HTLC_INVALID:${replicaId}`);
  exactKeys(raw, ['kind', 'version', 'entry'], `STORAGE_ENTITY_CONTEXT_HTLC_INVALID:${replicaId}`);
  if (raw['kind'] !== 'htlcEntry' || raw['version'] !== 1) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_HTLC_KIND:${replicaId}`);
  }
  return raw['entry'] as PreparedHtlcEntry;
};

const decodeHtlcOriginatedLeaf = (value: unknown, replicaId: string): PreparedOriginatedHtlcPayment => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_HTLC_INVALID:${replicaId}`);
  exactKeys(raw, ['kind', 'version', 'originated'], `STORAGE_ENTITY_CONTEXT_HTLC_INVALID:${replicaId}`);
  if (raw['kind'] !== 'htlcOriginated' || raw['version'] !== 1) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_HTLC_KIND:${replicaId}`);
  }
  return raw['originated'] as PreparedOriginatedHtlcPayment;
};

const decodeManifest = (value: unknown, replicaId: string): StoredEntityContextManifest => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_MANIFEST_INVALID:${replicaId}`);
  exactKeys(
    raw,
    ['kind', 'version', 'header', 'profileRefs', 'htlcEntryRefs', 'htlcOriginatedRefs'],
    `STORAGE_ENTITY_CONTEXT_MANIFEST_INVALID:${replicaId}`,
  );
  if (raw['kind'] !== 'entityContext' || raw['version'] !== 1) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_MANIFEST_KIND:${replicaId}`);
  }
  const header = record(raw['header'], `STORAGE_ENTITY_CONTEXT_HEADER_INVALID:${replicaId}`);
  exactKeys(header, [
    'version', 'proposerReplicaId', 'entityId', 'proposerSignerId',
    'parentFrameHash', 'height', 'peerAssertions',
  ], `STORAGE_ENTITY_CONTEXT_HEADER_INVALID:${replicaId}`);
  return {
    kind: 'entityContext',
    version: 1,
    header: header as StoredEntityContextManifest['header'],
    profileRefs: decodeHashList(raw['profileRefs'], `STORAGE_ENTITY_CONTEXT_PROFILE_REFS:${replicaId}`),
    htlcEntryRefs: decodeHashList(raw['htlcEntryRefs'], `STORAGE_ENTITY_CONTEXT_HTLC_REFS:${replicaId}`),
    htlcOriginatedRefs: decodeHashList(
      raw['htlcOriginatedRefs'],
      `STORAGE_ENTITY_CONTEXT_HTLC_ORIGINATED_REFS:${replicaId}`,
    ),
  };
};

export const readEntityContextPayloads = async (
  db: Pick<RuntimeDbLike, 'get'>,
  refs: ReadonlyMap<string, EntityContextPayloadHash>,
): Promise<Map<string, EntityInfraContext>> => {
  const contexts = new Map<string, EntityInfraContext>();
  for (const [replicaId, ref] of refs) {
    const manifest = decodeManifest(await readVerifiedPayload(db, replicaId, ref), replicaId);
    const gossipProfiles: Profile[] = [];
    for (const profileRef of manifest.profileRefs) {
      gossipProfiles.push(
        decodeGossipProfileLeaf(await readVerifiedPayload(db, replicaId, profileRef), replicaId),
      );
    }
    const entries: PreparedHtlcEntry[] = [];
    for (const entryRef of manifest.htlcEntryRefs) {
      entries.push(decodeHtlcEntryLeaf(await readVerifiedPayload(db, replicaId, entryRef), replicaId));
    }
    const originated: PreparedOriginatedHtlcPayment[] = [];
    for (const originatedRef of manifest.htlcOriginatedRefs) {
      originated.push(
        decodeHtlcOriginatedLeaf(await readVerifiedPayload(db, replicaId, originatedRef), replicaId),
      );
    }
    const htlc: HtlcPreparedInfraContext = { version: 1, entries, originated };
    const context = validateEntityInfraContext({
      ...manifest.header,
      gossipProfiles,
      htlc,
    });
    assertAppliedReplicaEntity(replicaId, context);
    contexts.set(replicaId, context);
  }
  return contexts;
};
