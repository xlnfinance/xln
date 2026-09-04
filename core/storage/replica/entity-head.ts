import { requireCertifiedEntityFrameAfterQuorum } from '../../entity/consensus/frame/phase-views';
import { validateProposedEntityFrame } from '../../entity/consensus/frame/validation';
import { createEntityFrameHashFromStateRoot } from '../../entity/consensus/frame';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../../entity/consensus/state-root';
import { compareStableText } from '../../protocol/serialization';
import type { CertifiedEntityFrameLink, EntityReplica } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import { normalizeEntityId } from '../keys';
import type { StorageReplicaLookup } from '../types';

export type CertifiedEntityHeadPlan = {
  lookup: StorageReplicaLookup;
  /** Exactly one current certified head per non-genesis replica; no separate Entity archive exists. */
  headByReplicaKey: Map<string, CertifiedEntityFrameLink | undefined>;
};

type ReplicaEntry = {
  replicaKey: string;
  replica: EntityReplica;
};

const replicaHeadHash = (replica: EntityReplica): string => {
  if (replica.state.height === 0) return 'genesis';
  const head = String(replica.state.prevFrameHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(head)) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_HEAD_MISSING:entity=${replica.entityId}:` +
        `signer=${replica.signerId}:height=${replica.state.height}`,
    );
  }
  return head;
};

const assertValidReplicaHeight = ({ replica }: ReplicaEntry): void => {
  if (!Number.isSafeInteger(replica.state.height) || replica.state.height < 0) {
    throw new Error(
      `STORAGE_ENTITY_REPLICA_HEIGHT_INVALID:entity=${replica.entityId}:` +
        `signer=${replica.signerId}:height=${String(replica.state.height)}`,
    );
  }
};

const assertExactCertifiedHead = (
  entityId: string,
  entry: ReplicaEntry,
): CertifiedEntityFrameLink | undefined => {
  const { replica } = entry;
  assertValidReplicaHeight(entry);
  const link = replica.certifiedFrameHead;
  if (replica.state.height === 0) {
    if (link !== undefined) {
      throw new Error(
        `STORAGE_ENTITY_GENESIS_CERTIFIED_HEAD_FORBIDDEN:${entityId}:${replica.signerId}`,
      );
    }
    if (replicaHeadHash(replica) !== 'genesis') {
      throw new Error(`STORAGE_ENTITY_GENESIS_HEAD_INVALID:${entityId}:${replica.signerId}`);
    }
    return undefined;
  }
  if (!link) {
    // Anchor-only persisted replicas are intentionally not accepted. An
    // explicit offline migration must materialize the full current head.
    throw new Error(
      `STORAGE_ENTITY_CERTIFIED_HEAD_REQUIRED:${entityId}:${replica.signerId}:` +
        `height=${replica.state.height}`,
    );
  }

  const frame = validateProposedEntityFrame(link.frame, 'StorageCertifiedEntityFrame');
  requireCertifiedEntityFrameAfterQuorum(frame);
  if (frame.height !== replica.state.height || frame.hash.toLowerCase() !== replicaHeadHash(replica)) {
    throw new Error(
      `STORAGE_ENTITY_CERTIFIED_HEAD_COORDINATES_MISMATCH:${entityId}:${replica.signerId}:` +
        `state=${replica.state.height}@${replicaHeadHash(replica)}:` +
        `frame=${frame.height}@${frame.hash}`,
    );
  }
  const stateRoot = computeCanonicalEntityConsensusStateHash(replica.state);
  const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(replica.state));
  const postAuthorityRoot = computeEntityFrameAuthorityRoot(link.postAuthority);
  if (
    stateRoot !== frame.stateRoot ||
    authorityRoot !== frame.authorityRoot ||
    postAuthorityRoot !== frame.authorityRoot
  ) {
    throw new Error(
      `STORAGE_ENTITY_CERTIFIED_HEAD_ROOT_MISMATCH:${entityId}:${replica.signerId}:` +
        `state=${stateRoot}/${frame.stateRoot}:` +
        `authority=${authorityRoot}/${postAuthorityRoot}/${frame.authorityRoot}`,
    );
  }
  const expectedHash = createEntityFrameHashFromStateRoot(
    frame.parentFrameHash,
    frame.height,
    frame.timestamp,
    frame.txs,
    frame.events,
    entityId,
    frame.stateRoot,
    frame.authorityRoot,
    frame.entityContext,
    frame.jPrefixCertificate,
  );
  if (expectedHash !== frame.hash) {
    throw new Error(
      `STORAGE_ENTITY_CERTIFIED_HEAD_HASH_MISMATCH:${entityId}:${frame.height}:` +
        `expected=${expectedHash}:received=${frame.hash}`,
    );
  }
  const manifest = frame.hashesToSign?.[0];
  if (!manifest || manifest.type !== 'entityFrame' || manifest.hash !== frame.hash) {
    throw new Error(`STORAGE_ENTITY_CERTIFIED_HEAD_MANIFEST_INVALID:${entityId}:${frame.height}`);
  }
  return link;
};

export const assertSameEntityReplicaEndpointAtEqualHeight = (
  entityId: string,
  left: EntityReplica,
  right: EntityReplica,
): void => {
  if (left.state.height !== right.state.height) return;
  const leftStateRoot = computeCanonicalEntityConsensusStateHash(left.state);
  const rightStateRoot = computeCanonicalEntityConsensusStateHash(right.state);
  const leftHead = replicaHeadHash(left);
  const rightHead = replicaHeadHash(right);
  if (leftStateRoot === rightStateRoot && leftHead === rightHead) return;
  throw new Error(
    `STORAGE_ENTITY_REPLICA_STATE_DIVERGENCE:entity=${entityId}:` +
      `height=${left.state.height}:left=${left.signerId}@${leftHead}/${leftStateRoot}:` +
      `right=${right.signerId}@${rightHead}/${rightStateRoot}`,
  );
};

const buildPlan = (
  sourceReplicas: ReadonlyMap<string, EntityReplica>,
): CertifiedEntityHeadPlan => {
  const byEntity = new Map<string, ReplicaEntry[]>();
  for (const [rawReplicaKey, replica] of sourceReplicas) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || '');
    if (!entityId) throw new Error(`STORAGE_ENTITY_REPLICA_ID_MISSING:${String(rawReplicaKey)}`);
    if (normalizeEntityId(replica.state.entityId) !== entityId) {
      throw new Error(`STORAGE_ENTITY_REPLICA_STATE_ID_MISMATCH:${entityId}`);
    }
    const entries = byEntity.get(entityId) ?? [];
    entries.push({ replicaKey: String(rawReplicaKey), replica });
    byEntity.set(entityId, entries);
  }

  const lookup: StorageReplicaLookup = new Map();
  const headByReplicaKey = new Map<string, CertifiedEntityFrameLink | undefined>();
  for (const [entityId, entries] of [...byEntity.entries()].sort(([left], [right]) =>
    compareStableText(left, right))) {
    const ordered = [...entries].sort((left, right) =>
      left.replica.state.height - right.replica.state.height ||
      compareStableText(left.replicaKey.toLowerCase(), right.replicaKey.toLowerCase()));
    for (let index = 0; index < ordered.length; index += 1) {
      const entry = ordered[index]!;
      const link = assertExactCertifiedHead(entityId, entry);
      headByReplicaKey.set(entry.replicaKey, link);
      if (index > 0) {
        assertSameEntityReplicaEndpointAtEqualHeight(
          entityId,
          ordered[index - 1]!.replica,
          entry.replica,
        );
      }
    }
    const selected = ordered.at(-1)!;
    lookup.set(entityId, {
      replicaKey: selected.replicaKey,
      replica: selected.replica,
      state: selected.replica.state,
    });
  }
  return { lookup, headByReplicaKey };
};

export const buildCertifiedEntityHeadPlan = (env: RuntimeReplica): CertifiedEntityHeadPlan =>
  buildPlan(env.state.eReplicas);

export const buildRuntimeCheckpointHeadPlan = (
  env: RuntimeReplica,
  sourceReplicas: ReadonlyMap<string, EntityReplica> = env.state.eReplicas,
): CertifiedEntityHeadPlan => {
  void env;
  return buildPlan(sourceReplicas);
};

/** Install only the exact current head selected by the validated plan. */
export const applyCertifiedEntityHeadPlan = (
  env: RuntimeReplica,
  plan: CertifiedEntityHeadPlan,
): void => {
  for (const [replicaKey, replica] of env.state.eReplicas) {
    if (!plan.headByReplicaKey.has(String(replicaKey))) {
      throw new Error(`STORAGE_ENTITY_HEAD_REPLICA_UNPLANNED:${replicaKey}`);
    }
    const head = plan.headByReplicaKey.get(String(replicaKey));
    if (head) replica.certifiedFrameHead = head;
    else delete replica.certifiedFrameHead;
  }
};
