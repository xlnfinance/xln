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
  header: Omit<EntityInfraContext, 'gossipProfiles' | 'htlc' | 'peerAssertions'> &
    Partial<Pick<EntityInfraContext, 'peerAssertions'>>;
  profilePageRefs: EntityContextPayloadHash[];
  /**
   * A Hub frame asserts liveness for every next hop it routes to in that frame;
   * at ~350 payments per frame the inline assertion list alone crossed the
   * record cap and halted the Runtime. Assertions are therefore paged like the
   * other lists (rows written before this field kept them inline in the header).
   */
  peerAssertionPageRefs?: EntityContextPayloadHash[];
  /**
   * One leaf per prepared HTLC rather than one leaf for the whole frame. A Hub
   * that batches carries as many prepared HTLCs as the batch is wide, and a
   * single combined leaf crossed the 10 KB record cap at 49 entries and halted
   * the Runtime. Per-entry leaves also dedupe: an entry repeated across
   * replicas or retried frames is stored once by content address.
   */
  htlcEntryPageRefs: EntityContextPayloadHash[];
  htlcOriginatedPageRefs: EntityContextPayloadHash[];
}>;

/**
 * Splitting the leaves only moved the ceiling onto the manifest: a batch of 99
 * payments listed 198 hashes and the manifest itself passed 20 KB. Reference
 * lists are therefore paged into their own content-addressed leaves, so the
 * manifest holds a handful of page hashes no matter how wide the batch is.
 */
type StoredReferencePage = Readonly<{
  kind: 'referencePage';
  version: 1;
  childKind: 'gossipProfile' | 'htlcEntry' | 'htlcOriginated' | 'peerAssertions';
  refs: EntityContextPayloadHash[];
}>;

type StoredPeerAssertionsPage = Readonly<{
  kind: 'peerAssertions';
  version: 1;
  assertions: EntityInfraContext['peerAssertions'];
}>;

const REFERENCE_PAGE_SIZE = 64;
const PEER_ASSERTION_PAGE_SIZE = 64;

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
  | StoredHtlcOriginated
  | StoredPeerAssertionsPage
  | StoredReferencePage;

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
  if (payload.kind === 'peerAssertions') return `peerAssertions:${payload.assertions.length}`;
  if (payload.kind === 'referencePage') {
    return `referencePage:${payload.childKind}:refs=${payload.refs.length}`;
  }
  return `entityContext:profilePages=${payload.profilePageRefs.length}:` +
    `htlcPages=${payload.htlcEntryPageRefs.length}`;
};

const prepareReferencePages = (
  refs: readonly EntityContextPayloadHash[],
  childKind: StoredReferencePage['childKind'],
  rowsByHash: Map<EntityContextPayloadHash, PayloadRow>,
): EntityContextPayloadHash[] => {
  const pageRefs: EntityContextPayloadHash[] = [];
  for (let offset = 0; offset < refs.length; offset += REFERENCE_PAGE_SIZE) {
    pageRefs.push(prepareRow({
      kind: 'referencePage',
      version: 1,
      childKind,
      refs: refs.slice(offset, offset + REFERENCE_PAGE_SIZE),
    }, rowsByHash));
  }
  return pageRefs;
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
  inProcessInfraValidated = false,
) => {
  const refs = new Map<string, EntityContextPayloadHash>();
  const rowsByHash = new Map<EntityContextPayloadHash, PayloadRow>();
  for (const [replicaId, context] of contexts) {
    assertReplicaId(replicaId, 'STORAGE_ENTITY_CONTEXT_REPLICA_ID_INVALID');
    // Live saveEnvToDB never runs during WAL replay. Each collected context
    // already passed materialize or apply this tick; re-parse is a second
    // HTLC graph walk. Recovery read still full-parses. Default false keeps
    // tests and foreign callers on the strict decoder.
    const decoded = inProcessInfraValidated
      ? context
      : validateEntityInfraContext(context);
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
    const peerAssertionRefs: EntityContextPayloadHash[] = [];
    for (let offset = 0; offset < decoded.peerAssertions.length; offset += PEER_ASSERTION_PAGE_SIZE) {
      peerAssertionRefs.push(prepareRow({
        kind: 'peerAssertions',
        version: 1,
        assertions: decoded.peerAssertions.slice(offset, offset + PEER_ASSERTION_PAGE_SIZE),
      }, rowsByHash));
    }
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
      },
      profilePageRefs: prepareReferencePages(profileRefs, 'gossipProfile', rowsByHash),
      peerAssertionPageRefs: prepareReferencePages(peerAssertionRefs, 'peerAssertions', rowsByHash),
      htlcEntryPageRefs: prepareReferencePages(htlcEntryRefs, 'htlcEntry', rowsByHash),
      htlcOriginatedPageRefs: prepareReferencePages(htlcOriginatedRefs, 'htlcOriginated', rowsByHash),
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

const decodePeerAssertionsLeaf = (
  value: unknown,
  replicaId: string,
): EntityInfraContext['peerAssertions'] => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_PEER_ASSERTIONS_INVALID:${replicaId}`);
  exactKeys(raw, ['kind', 'version', 'assertions'], `STORAGE_ENTITY_CONTEXT_PEER_ASSERTIONS_INVALID:${replicaId}`);
  if (raw['kind'] !== 'peerAssertions' || raw['version'] !== 1 || !Array.isArray(raw['assertions'])) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_PEER_ASSERTIONS_KIND:${replicaId}`);
  }
  if (raw['assertions'].length === 0 || raw['assertions'].length > PEER_ASSERTION_PAGE_SIZE) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_PEER_ASSERTIONS_SIZE:${replicaId}:${raw['assertions'].length}`);
  }
  return raw['assertions'] as EntityInfraContext['peerAssertions'];
};

const decodeManifest = (value: unknown, replicaId: string): StoredEntityContextManifest => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_MANIFEST_INVALID:${replicaId}`);
  const paged = 'peerAssertionPageRefs' in raw;
  exactKeys(
    raw,
    [
      'kind', 'version', 'header', 'profilePageRefs', 'htlcEntryPageRefs', 'htlcOriginatedPageRefs',
      ...(paged ? ['peerAssertionPageRefs'] : []),
    ],
    `STORAGE_ENTITY_CONTEXT_MANIFEST_INVALID:${replicaId}`,
  );
  if (raw['kind'] !== 'entityContext' || raw['version'] !== 1) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_MANIFEST_KIND:${replicaId}`);
  }
  const header = record(raw['header'], `STORAGE_ENTITY_CONTEXT_HEADER_INVALID:${replicaId}`);
  exactKeys(header, [
    'version', 'proposerReplicaId', 'entityId', 'proposerSignerId',
    'parentFrameHash', 'height', ...(paged ? [] : ['peerAssertions']),
  ], `STORAGE_ENTITY_CONTEXT_HEADER_INVALID:${replicaId}`);
  return {
    kind: 'entityContext',
    version: 1,
    header: header as StoredEntityContextManifest['header'],
    profilePageRefs: decodeHashList(
      raw['profilePageRefs'],
      `STORAGE_ENTITY_CONTEXT_PROFILE_REFS:${replicaId}`,
    ),
    ...(paged ? {
      peerAssertionPageRefs: decodeHashList(
        raw['peerAssertionPageRefs'],
        `STORAGE_ENTITY_CONTEXT_PEER_ASSERTION_REFS:${replicaId}`,
      ),
    } : {}),
    htlcEntryPageRefs: decodeHashList(
      raw['htlcEntryPageRefs'],
      `STORAGE_ENTITY_CONTEXT_HTLC_REFS:${replicaId}`,
    ),
    htlcOriginatedPageRefs: decodeHashList(
      raw['htlcOriginatedPageRefs'],
      `STORAGE_ENTITY_CONTEXT_HTLC_ORIGINATED_REFS:${replicaId}`,
    ),
  };
};

const decodeReferencePageLeaf = (
  value: unknown,
  replicaId: string,
  childKind: StoredReferencePage['childKind'],
): EntityContextPayloadHash[] => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_REFERENCE_PAGE_INVALID:${replicaId}`);
  exactKeys(
    raw,
    ['kind', 'version', 'childKind', 'refs'],
    `STORAGE_ENTITY_CONTEXT_REFERENCE_PAGE_INVALID:${replicaId}`,
  );
  if (raw['kind'] !== 'referencePage' || raw['version'] !== 1 || raw['childKind'] !== childKind) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_REFERENCE_PAGE_KIND:${replicaId}`);
  }
  const refs = decodeHashList(raw['refs'], `STORAGE_ENTITY_CONTEXT_REFERENCE_PAGE_REFS:${replicaId}`);
  if (refs.length === 0 || refs.length > REFERENCE_PAGE_SIZE) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_REFERENCE_PAGE_SIZE:${replicaId}:${refs.length}`);
  }
  return refs;
};

const readPagedRefs = async (
  db: Pick<RuntimeDbLike, 'get'>,
  replicaId: string,
  pageRefs: readonly EntityContextPayloadHash[],
  childKind: StoredReferencePage['childKind'],
): Promise<EntityContextPayloadHash[]> => {
  const refs: EntityContextPayloadHash[] = [];
  for (const pageRef of pageRefs) {
    refs.push(...decodeReferencePageLeaf(
      await readVerifiedPayload(db, replicaId, pageRef),
      replicaId,
      childKind,
    ));
  }
  return refs;
};

export const readEntityContextPayloads = async (
  db: Pick<RuntimeDbLike, 'get'>,
  refs: ReadonlyMap<string, EntityContextPayloadHash>,
): Promise<Map<string, EntityInfraContext>> => {
  const contexts = new Map<string, EntityInfraContext>();
  for (const [replicaId, ref] of refs) {
    const manifest = decodeManifest(await readVerifiedPayload(db, replicaId, ref), replicaId);
    const gossipProfiles: Profile[] = [];
    for (const profileRef of await readPagedRefs(db, replicaId, manifest.profilePageRefs, 'gossipProfile')) {
      gossipProfiles.push(
        decodeGossipProfileLeaf(await readVerifiedPayload(db, replicaId, profileRef), replicaId),
      );
    }
    const entries: PreparedHtlcEntry[] = [];
    for (const entryRef of await readPagedRefs(db, replicaId, manifest.htlcEntryPageRefs, 'htlcEntry')) {
      entries.push(decodeHtlcEntryLeaf(await readVerifiedPayload(db, replicaId, entryRef), replicaId));
    }
    const originated: PreparedOriginatedHtlcPayment[] = [];
    for (const originatedRef of await readPagedRefs(
      db, replicaId, manifest.htlcOriginatedPageRefs, 'htlcOriginated',
    )) {
      originated.push(
        decodeHtlcOriginatedLeaf(await readVerifiedPayload(db, replicaId, originatedRef), replicaId),
      );
    }
    const htlc: HtlcPreparedInfraContext = { version: 1, entries, originated };
    let peerAssertions = manifest.header.peerAssertions ?? [];
    if (manifest.peerAssertionPageRefs) {
      const paged: EntityInfraContext['peerAssertions'][number][] = [];
      for (const pageRef of await readPagedRefs(
        db, replicaId, manifest.peerAssertionPageRefs, 'peerAssertions',
      )) {
        paged.push(...decodePeerAssertionsLeaf(await readVerifiedPayload(db, replicaId, pageRef), replicaId));
      }
      peerAssertions = paged;
    }
    const context = validateEntityInfraContext({
      ...manifest.header,
      peerAssertions,
      gossipProfiles,
      htlc,
    });
    assertAppliedReplicaEntity(replicaId, context);
    contexts.set(replicaId, context);
  }
  return contexts;
};
