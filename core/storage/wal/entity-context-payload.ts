/**
 * Proposer infrastructure observations are replay inputs, not Runtime state.
 * WAL frames commit replica-id → manifest digest. Physical rows live at
 * permanent `(Runtime height, replica, row kind, row index)` paths; digests
 * authenticate bytes but never select a database key.
 *
 * One physical LevelDB value is capped at 10 KB. A 4-hop HTLC context carries
 * four gossip Profiles (~2.5–3.1 KB each) plus the prepared HTLC envelope, so
 * the canonical RAM object does not fit in one record. Store a tiny manifest
 * plus path-addressed Profile and HTLC leaves; never byte-chunk an opaque blob,
 * which would create a second storage layout beside the typed records.
 */
import type { EntityInfraContext } from '../../types/entity/infra-context';
import type {
  HtlcPreparedInfraContext,
  PreparedHtlcEntry,
  PreparedOriginatedHtlcPayment,
} from '../../types/entity/htlc-infra-context';
import type { Profile } from '../../entity/profile';
import { validateEntityInfraContext } from '../../entity/consensus/frame/infra-context-validation';
import { computeIntegrityDigest } from '../../support/bytes/integrity-checksum';
import {
  toEntityContextPayloadHash,
  type EntityContextPayloadHash,
} from '../../protocol/hashes';
import { decodeBuffer, encodeBuffer } from '../codec/codec';
import {
  keyEntityContextPayload,
  type EntityContextPayloadPathKind,
} from '../keys';
import type {
  RuntimeDbLike,
} from '../types';

export const MAX_ENTITY_CONTEXT_PAYLOAD_BYTES = 10_000;

type StoredEntityContextManifest = Readonly<{
  kind: 'entityContext';
  version: 2;
  header: Omit<EntityInfraContext, 'gossipProfiles' | 'htlc' | 'peerAssertions'> &
    Partial<Pick<EntityInfraContext, 'peerAssertions'>>;
  profilePageDigests: EntityContextPayloadHash[];
  /**
   * A Hub frame asserts liveness for every next hop it routes to in that frame;
   * at ~350 payments per frame the inline assertion list alone crossed the
   * record cap and halted the Runtime. Assertions are therefore paged like the
   * other lists (rows written before this field kept them inline in the header).
   */
  peerAssertionPageDigests: EntityContextPayloadHash[];
  /**
   * One leaf per prepared HTLC rather than one leaf for the whole frame. A Hub
   * that batches carries as many prepared HTLCs as the batch is wide, and a
   * single combined leaf crossed the 10 KB record cap at 49 entries and halted
   * the Runtime. Each leaf has a stable replica-local index and is overwritten
   * when that Runtime height is rewritten during an offline rebuild.
   */
  htlcEntryPageDigests: EntityContextPayloadHash[];
  htlcOriginatedPageDigests: EntityContextPayloadHash[];
}>;

/**
 * Splitting the leaves only moved the ceiling onto the manifest: a batch of 99
 * payments listed 198 hashes and the manifest itself passed 20 KB. Reference
 * lists are therefore paged into fixed path-derived rows, so the manifest
 * holds a handful of page digests no matter how wide the batch is.
 */
type StoredDigestPage = Readonly<{
  kind: 'digestPage';
  version: 2;
  childKind: 'gossipProfile' | 'htlcEntry' | 'htlcOriginated' | 'peerAssertions';
  digests: EntityContextPayloadHash[];
}>;

type StoredPeerAssertionsPage = Readonly<{
  kind: 'peerAssertions';
  version: 2;
  assertions: EntityInfraContext['peerAssertions'];
}>;

const REFERENCE_PAGE_SIZE = 64;
const PEER_ASSERTION_PAGE_SIZE = 64;

type StoredGossipProfile = Readonly<{
  kind: 'gossipProfile';
  version: 2;
  profile: Profile;
}>;

type StoredHtlcEntry = Readonly<{
  kind: 'htlcEntry';
  version: 2;
  entry: PreparedHtlcEntry;
}>;

type StoredHtlcOriginated = Readonly<{
  kind: 'htlcOriginated';
  version: 2;
  originated: PreparedOriginatedHtlcPayment;
}>;

type StoredEntityContextRow =
  | StoredEntityContextManifest
  | StoredGossipProfile
  | StoredHtlcEntry
  | StoredHtlcOriginated
  | StoredPeerAssertionsPage
  | StoredDigestPage;

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
  if (payload.kind === 'digestPage') {
    return `digestPage:${payload.childKind}:digests=${payload.digests.length}`;
  }
  return `entityContext:profilePages=${payload.profilePageDigests.length}:` +
    `htlcPages=${payload.htlcEntryPageDigests.length}`;
};

const prepareRow = (
  runtimeHeight: number,
  replicaId: string,
  pathKind: EntityContextPayloadPathKind,
  index: number,
  payload: StoredEntityContextRow,
  rows: PayloadRow[],
): EntityContextPayloadHash => {
  const value = encodeBuffer(payload, { omitSymbolKeys: true });
  if (value.byteLength >= MAX_ENTITY_CONTEXT_PAYLOAD_BYTES) {
    throw new Error(
      `STORAGE_ENTITY_CONTEXT_PAYLOAD_TOO_LARGE:${value.byteLength}:` +
      `max=${MAX_ENTITY_CONTEXT_PAYLOAD_BYTES}:${payloadBudgetLabel(payload)}`,
    );
  }
  const digest = hashContext(value);
  rows.push({
    key: keyEntityContextPayload(runtimeHeight, replicaId, pathKind, index),
    value,
  });
  return digest;
};

const digestPagePathKind = (
  childKind: StoredDigestPage['childKind'],
): EntityContextPayloadPathKind => {
  if (childKind === 'gossipProfile') return 'gossipProfileDigests';
  if (childKind === 'htlcEntry') return 'htlcEntryDigests';
  if (childKind === 'htlcOriginated') return 'htlcOriginatedDigests';
  return 'peerAssertionDigests';
};

const prepareDigestPages = (
  runtimeHeight: number,
  replicaId: string,
  digests: readonly EntityContextPayloadHash[],
  childKind: StoredDigestPage['childKind'],
  rows: PayloadRow[],
): EntityContextPayloadHash[] => {
  const pageDigests: EntityContextPayloadHash[] = [];
  for (let offset = 0; offset < digests.length; offset += REFERENCE_PAGE_SIZE) {
    pageDigests.push(prepareRow(
      runtimeHeight,
      replicaId,
      digestPagePathKind(childKind),
      offset / REFERENCE_PAGE_SIZE,
      {
        kind: 'digestPage',
        version: 2,
        childKind,
        digests: digests.slice(offset, offset + REFERENCE_PAGE_SIZE),
      },
      rows,
    ));
  }
  return pageDigests;
};

export const prepareEntityContextPayloadRows = (
  runtimeHeight: number,
  contexts: ReadonlyMap<string, EntityInfraContext>,
  inProcessInfraValidated = false,
) => {
  const refs = new Map<string, EntityContextPayloadHash>();
  const rows: PayloadRow[] = [];
  for (const [replicaId, context] of [...contexts.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0)) {
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
    const profileDigests = decoded.gossipProfiles.map((profile, index) => prepareRow(
      runtimeHeight, replicaId, 'gossipProfile', index,
      { kind: 'gossipProfile', version: 2, profile }, rows,
    ));
    const htlcEntryDigests = decoded.htlc.entries.map((entry, index) => prepareRow(
      runtimeHeight, replicaId, 'htlcEntry', index,
      { kind: 'htlcEntry', version: 2, entry }, rows,
    ));
    const htlcOriginatedDigests = decoded.htlc.originated.map((originated, index) => prepareRow(
      runtimeHeight, replicaId, 'htlcOriginated', index,
      { kind: 'htlcOriginated', version: 2, originated }, rows,
    ));
    const peerAssertionDigests: EntityContextPayloadHash[] = [];
    for (let offset = 0; offset < decoded.peerAssertions.length; offset += PEER_ASSERTION_PAGE_SIZE) {
      peerAssertionDigests.push(prepareRow(
        runtimeHeight,
        replicaId,
        'peerAssertions',
        offset / PEER_ASSERTION_PAGE_SIZE,
        {
          kind: 'peerAssertions',
          version: 2,
          assertions: decoded.peerAssertions.slice(offset, offset + PEER_ASSERTION_PAGE_SIZE),
        },
        rows,
      ));
    }
    refs.set(replicaId, prepareRow(
      runtimeHeight,
      replicaId,
      'manifest',
      0,
      {
        kind: 'entityContext',
        version: 2,
        header: {
          version: decoded.version,
          proposerReplicaId: decoded.proposerReplicaId,
          entityId: decoded.entityId,
          proposerSignerId: decoded.proposerSignerId,
          parentFrameHash: decoded.parentFrameHash,
          height: decoded.height,
        },
        profilePageDigests: prepareDigestPages(
          runtimeHeight, replicaId, profileDigests, 'gossipProfile', rows,
        ),
        peerAssertionPageDigests: prepareDigestPages(
          runtimeHeight, replicaId, peerAssertionDigests, 'peerAssertions', rows,
        ),
        htlcEntryPageDigests: prepareDigestPages(
          runtimeHeight, replicaId, htlcEntryDigests, 'htlcEntry', rows,
        ),
        htlcOriginatedPageDigests: prepareDigestPages(
          runtimeHeight, replicaId, htlcOriginatedDigests, 'htlcOriginated', rows,
        ),
      },
      rows,
    ));
  }
  return { refs, rows };
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
  runtimeHeight: number,
  replicaId: string,
  pathKind: EntityContextPayloadPathKind,
  index: number,
  expectedDigest: EntityContextPayloadHash,
): Promise<unknown> => {
  let value: Buffer;
  try {
    value = await db.get(keyEntityContextPayload(runtimeHeight, replicaId, pathKind, index));
  } catch (error) {
    throw new Error(
      `STORAGE_ENTITY_CONTEXT_PAYLOAD_MISSING:${runtimeHeight}:${replicaId}:${pathKind}:${index}`,
      {
      cause: error,
      },
    );
  }
  if (value.byteLength >= MAX_ENTITY_CONTEXT_PAYLOAD_BYTES) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_PAYLOAD_TOO_LARGE:${replicaId}`);
  }
  const actual = hashContext(value);
  if (actual !== expectedDigest) {
    throw new Error(
      `STORAGE_ENTITY_CONTEXT_PAYLOAD_HASH_MISMATCH:${replicaId}:` +
      `expected=${expectedDigest}:actual=${actual}`,
    );
  }
  return decodeBuffer(value);
};

const decodeDigestList = (value: unknown, code: string): EntityContextPayloadHash[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value.map(entry => {
    if (typeof entry !== 'string') throw new Error(`${code}:ENTRY`);
    return toEntityContextPayloadHash(entry.toLowerCase());
  });
};

const decodeGossipProfileLeaf = (value: unknown, replicaId: string): Profile => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_PROFILE_INVALID:${replicaId}`);
  exactKeys(raw, ['kind', 'version', 'profile'], `STORAGE_ENTITY_CONTEXT_PROFILE_INVALID:${replicaId}`);
  if (raw['kind'] !== 'gossipProfile' || raw['version'] !== 2) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_PROFILE_KIND:${replicaId}`);
  }
  return raw['profile'] as Profile;
};

const decodeHtlcEntryLeaf = (value: unknown, replicaId: string): PreparedHtlcEntry => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_HTLC_INVALID:${replicaId}`);
  exactKeys(raw, ['kind', 'version', 'entry'], `STORAGE_ENTITY_CONTEXT_HTLC_INVALID:${replicaId}`);
  if (raw['kind'] !== 'htlcEntry' || raw['version'] !== 2) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_HTLC_KIND:${replicaId}`);
  }
  return raw['entry'] as PreparedHtlcEntry;
};

const decodeHtlcOriginatedLeaf = (value: unknown, replicaId: string): PreparedOriginatedHtlcPayment => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_HTLC_INVALID:${replicaId}`);
  exactKeys(raw, ['kind', 'version', 'originated'], `STORAGE_ENTITY_CONTEXT_HTLC_INVALID:${replicaId}`);
  if (raw['kind'] !== 'htlcOriginated' || raw['version'] !== 2) {
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
  if (raw['kind'] !== 'peerAssertions' || raw['version'] !== 2 || !Array.isArray(raw['assertions'])) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_PEER_ASSERTIONS_KIND:${replicaId}`);
  }
  if (raw['assertions'].length === 0 || raw['assertions'].length > PEER_ASSERTION_PAGE_SIZE) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_PEER_ASSERTIONS_SIZE:${replicaId}:${raw['assertions'].length}`);
  }
  return raw['assertions'] as EntityInfraContext['peerAssertions'];
};

const decodeManifest = (value: unknown, replicaId: string): StoredEntityContextManifest => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_MANIFEST_INVALID:${replicaId}`);
  exactKeys(
    raw,
    [
      'kind', 'version', 'header', 'profilePageDigests', 'peerAssertionPageDigests',
      'htlcEntryPageDigests', 'htlcOriginatedPageDigests',
    ],
    `STORAGE_ENTITY_CONTEXT_MANIFEST_INVALID:${replicaId}`,
  );
  if (raw['kind'] !== 'entityContext' || raw['version'] !== 2) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_MANIFEST_KIND:${replicaId}`);
  }
  const header = record(raw['header'], `STORAGE_ENTITY_CONTEXT_HEADER_INVALID:${replicaId}`);
  exactKeys(header, [
    'version', 'proposerReplicaId', 'entityId', 'proposerSignerId',
    'parentFrameHash', 'height',
  ], `STORAGE_ENTITY_CONTEXT_HEADER_INVALID:${replicaId}`);
  return {
    kind: 'entityContext',
    version: 2,
    header: header as StoredEntityContextManifest['header'],
    profilePageDigests: decodeDigestList(
      raw['profilePageDigests'],
      `STORAGE_ENTITY_CONTEXT_PROFILE_DIGESTS:${replicaId}`,
    ),
    peerAssertionPageDigests: decodeDigestList(
      raw['peerAssertionPageDigests'],
      `STORAGE_ENTITY_CONTEXT_PEER_ASSERTION_DIGESTS:${replicaId}`,
    ),
    htlcEntryPageDigests: decodeDigestList(
      raw['htlcEntryPageDigests'],
      `STORAGE_ENTITY_CONTEXT_HTLC_DIGESTS:${replicaId}`,
    ),
    htlcOriginatedPageDigests: decodeDigestList(
      raw['htlcOriginatedPageDigests'],
      `STORAGE_ENTITY_CONTEXT_HTLC_ORIGINATED_DIGESTS:${replicaId}`,
    ),
  };
};

const decodeDigestPageLeaf = (
  value: unknown,
  replicaId: string,
  childKind: StoredDigestPage['childKind'],
): EntityContextPayloadHash[] => {
  const raw = record(value, `STORAGE_ENTITY_CONTEXT_DIGEST_PAGE_INVALID:${replicaId}`);
  exactKeys(
    raw,
    ['kind', 'version', 'childKind', 'digests'],
    `STORAGE_ENTITY_CONTEXT_DIGEST_PAGE_INVALID:${replicaId}`,
  );
  if (raw['kind'] !== 'digestPage' || raw['version'] !== 2 || raw['childKind'] !== childKind) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_DIGEST_PAGE_KIND:${replicaId}`);
  }
  const digests = decodeDigestList(
    raw['digests'],
    `STORAGE_ENTITY_CONTEXT_DIGEST_PAGE_DIGESTS:${replicaId}`,
  );
  if (digests.length === 0 || digests.length > REFERENCE_PAGE_SIZE) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_DIGEST_PAGE_SIZE:${replicaId}:${digests.length}`);
  }
  return digests;
};

const readPagedDigests = async (
  db: Pick<RuntimeDbLike, 'get'>,
  runtimeHeight: number,
  replicaId: string,
  pageDigests: readonly EntityContextPayloadHash[],
  childKind: StoredDigestPage['childKind'],
): Promise<EntityContextPayloadHash[]> => {
  const digests: EntityContextPayloadHash[] = [];
  for (const [pageIndex, pageDigest] of pageDigests.entries()) {
    digests.push(...decodeDigestPageLeaf(
      await readVerifiedPayload(
        db,
        runtimeHeight,
        replicaId,
        digestPagePathKind(childKind),
        pageIndex,
        pageDigest,
      ),
      replicaId,
      childKind,
    ));
  }
  return digests;
};

export const readEntityContextPayloads = async (
  db: Pick<RuntimeDbLike, 'get'>,
  runtimeHeight: number,
  refs: ReadonlyMap<string, EntityContextPayloadHash>,
): Promise<Map<string, EntityInfraContext>> => {
  const contexts = new Map<string, EntityInfraContext>();
  for (const [replicaId, ref] of refs) {
    const manifest = decodeManifest(await readVerifiedPayload(
      db, runtimeHeight, replicaId, 'manifest', 0, ref,
    ), replicaId);
    const gossipProfiles: Profile[] = [];
    const profileDigests = await readPagedDigests(
      db, runtimeHeight, replicaId, manifest.profilePageDigests, 'gossipProfile',
    );
    for (const [index, digest] of profileDigests.entries()) {
      gossipProfiles.push(
        decodeGossipProfileLeaf(await readVerifiedPayload(
          db, runtimeHeight, replicaId, 'gossipProfile', index, digest,
        ), replicaId),
      );
    }
    const entries: PreparedHtlcEntry[] = [];
    const entryDigests = await readPagedDigests(
      db, runtimeHeight, replicaId, manifest.htlcEntryPageDigests, 'htlcEntry',
    );
    for (const [index, digest] of entryDigests.entries()) {
      entries.push(decodeHtlcEntryLeaf(await readVerifiedPayload(
        db, runtimeHeight, replicaId, 'htlcEntry', index, digest,
      ), replicaId));
    }
    const originated: PreparedOriginatedHtlcPayment[] = [];
    const originatedDigests = await readPagedDigests(
      db, runtimeHeight, replicaId, manifest.htlcOriginatedPageDigests, 'htlcOriginated',
    );
    for (const [index, digest] of originatedDigests.entries()) {
      originated.push(
        decodeHtlcOriginatedLeaf(await readVerifiedPayload(
          db, runtimeHeight, replicaId, 'htlcOriginated', index, digest,
        ), replicaId),
      );
    }
    const htlc: HtlcPreparedInfraContext = { version: 1, entries, originated };
    const peerAssertions: EntityInfraContext['peerAssertions'][number][] = [];
    const assertionDigests = await readPagedDigests(
      db, runtimeHeight, replicaId, manifest.peerAssertionPageDigests, 'peerAssertions',
    );
    for (const [index, digest] of assertionDigests.entries()) {
      peerAssertions.push(...decodePeerAssertionsLeaf(await readVerifiedPayload(
        db, runtimeHeight, replicaId, 'peerAssertions', index, digest,
      ), replicaId));
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
