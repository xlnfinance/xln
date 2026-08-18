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
import type { HtlcPreparedInfraContext } from '../../types/entity/htlc-infra-context';
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
  htlcRef: EntityContextPayloadHash;
}>;

type StoredGossipProfile = Readonly<{
  kind: 'gossipProfile';
  version: 1;
  profile: Profile;
}>;

type StoredHtlcPrepared = Readonly<{
  kind: 'htlcPrepared';
  version: 1;
  htlc: HtlcPreparedInfraContext;
}>;

type StoredEntityContextRow =
  | StoredEntityContextManifest
  | StoredGossipProfile
  | StoredHtlcPrepared;

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
  if (payload.kind === 'htlcPrepared') {
    return `htlcPrepared:entries=${payload.htlc.entries.length}:originated=${payload.htlc.originated.length}`;
  }
  return `entityContext:profiles=${payload.profileRefs.length}`;
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
    const htlcRef = prepareRow({
      kind: 'htlcPrepared',
      version: 1,
      htlc: decoded.htlc,
    }, rowsByHash);
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
      htlcRef,
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

const decodeHtlcLeaf = (value: unknown, replicaId: string): HtlcPreparedInfraContext => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_HTLC_INVALID:${replicaId}`);
  exactKeys(raw, ['kind', 'version', 'htlc'], `STORAGE_ENTITY_CONTEXT_HTLC_INVALID:${replicaId}`);
  if (raw['kind'] !== 'htlcPrepared' || raw['version'] !== 1) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_HTLC_KIND:${replicaId}`);
  }
  return raw['htlc'] as HtlcPreparedInfraContext;
};

const decodeManifest = (value: unknown, replicaId: string): StoredEntityContextManifest => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_MANIFEST_INVALID:${replicaId}`);
  exactKeys(
    raw,
    ['kind', 'version', 'header', 'profileRefs', 'htlcRef'],
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
  const htlcRefRaw = raw['htlcRef'];
  if (typeof htlcRefRaw !== 'string') throw new Error(`STORAGE_ENTITY_CONTEXT_HTLC_REF:${replicaId}`);
  return {
    kind: 'entityContext',
    version: 1,
    header: header as StoredEntityContextManifest['header'],
    profileRefs: decodeHashList(raw['profileRefs'], `STORAGE_ENTITY_CONTEXT_PROFILE_REFS:${replicaId}`),
    htlcRef: toEntityContextPayloadHash(htlcRefRaw.toLowerCase()),
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
    const htlc = decodeHtlcLeaf(await readVerifiedPayload(db, replicaId, manifest.htlcRef), replicaId);
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
