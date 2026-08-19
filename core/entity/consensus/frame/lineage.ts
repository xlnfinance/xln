import { encodeCanonicalConsensusValue } from '../../../protocol/serialization/canonical-consensus-value';
import { cloneIsolatedProposedEntityFrame } from '../../state/input-clone';
import type {
  CertifiedEntityFrameLink,
  EntityCandidateEffect,
  EntityFrameAuthority,
  EntityReplica,
  EntityState,
  EntityFrame,
} from '../../types';
import { createEntityFrameHashFromStateRoot } from '../frame';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../state-root';

/** Return the only frame hash that may parent the next Entity frame. */
export const getPrevFrameHash = (state: EntityState): string => {
  if (state.height === 0) return 'genesis';
  if (typeof state.prevFrameHash === 'string' && state.prevFrameHash.length > 0) {
    return state.prevFrameHash;
  }
  throw new Error(
    `ENTITY_FRAME_CHAIN_CORRUPTED: missing prevFrameHash at height=${state.height} entity=${state.entityId}`,
  );
};

export const assertFrameParentMatchesState = (
  state: EntityState,
  frame: EntityFrame,
  context: string,
): void => {
  const expected = getPrevFrameHash(state);
  if (frame.parentFrameHash !== expected) {
    throw new Error(`${context}:expected=${expected}:received=${frame.parentFrameHash}:height=${frame.height}`);
  }
};

/**
 * Recompute every commitment before a certified frame enters durable lineage.
 * A caller-provided commitment is accepted only when it was already verified
 * against this exact post-state by the current transition. That path must not
 * re-encode Account frame bodies already bound by `frame.hash`.
 */
export const buildCertifiedEntityFrameLink = (
  entityId: string,
  frame: EntityFrame,
  postState: EntityState,
  verifiedCommitment?: Readonly<{
    stateRoot: string;
    authority: EntityFrameAuthority;
  }>,
): CertifiedEntityFrameLink => {
  if (postState.entityId.toLowerCase() !== entityId.toLowerCase()) {
    throw new Error(`ENTITY_CERTIFIED_LINK_ENTITY_MISMATCH:expected=${entityId}:received=${postState.entityId}`);
  }
  if (postState.height !== frame.height) {
    throw new Error(`ENTITY_CERTIFIED_LINK_HEIGHT_MISMATCH:state=${postState.height}:frame=${frame.height}`);
  }
  if (postState.prevFrameHash !== frame.hash) {
    throw new Error(
      `ENTITY_CERTIFIED_LINK_HEAD_MISMATCH:state=${postState.prevFrameHash ?? 'missing'}:frame=${frame.hash}`,
    );
  }
  const postStateRoot = verifiedCommitment?.stateRoot ?? computeCanonicalEntityConsensusStateHash(postState);
  if (postStateRoot !== frame.stateRoot) {
    throw new Error(`ENTITY_CERTIFIED_LINK_STATE_ROOT_MISMATCH:expected=${postStateRoot}:received=${frame.stateRoot}`);
  }
  const postAuthority = verifiedCommitment?.authority ?? buildEntityFrameAuthority(postState);
  const authorityRoot = computeEntityFrameAuthorityRoot(postAuthority);
  if (authorityRoot !== frame.authorityRoot) {
    throw new Error(
      `ENTITY_CERTIFIED_LINK_AUTHORITY_ROOT_MISMATCH:expected=${authorityRoot}:received=${frame.authorityRoot}`,
    );
  }
  if (!verifiedCommitment) {
    const recomputed = createEntityFrameHashFromStateRoot(
      frame.parentFrameHash,
      frame.height,
      frame.timestamp,
      frame.txs,
      frame.events,
      entityId,
      postStateRoot,
      authorityRoot,
      frame.entityContext,
      frame.jPrefixCertificate,
    );
    if (recomputed !== frame.hash) {
      throw new Error(`ENTITY_CERTIFIED_LINK_HASH_MISMATCH:expected=${recomputed}:received=${frame.hash}`);
    }
  }
  if (!frame.collectedSigs?.size) {
    throw new Error(`ENTITY_CERTIFIED_LINK_SIGNATURES_MISSING:${frame.height}:${frame.hash}`);
  }
  const frameManifestEntry = frame.hashesToSign?.[0];
  if (!frameManifestEntry || frameManifestEntry.type !== 'entityFrame' || frameManifestEntry.hash !== frame.hash) {
    throw new Error(`ENTITY_CERTIFIED_LINK_FRAME_MANIFEST_INVALID:${frame.height}:${frame.hash}`);
  }
  const cloned = cloneIsolatedProposedEntityFrame(frame);
  return { frame: cloned, postAuthority };
};

/**
 * Identity of a certified link without encoding Account/Entity tx bodies.
 * `frame.hash` already binds txs, events, context and roots. Leader metadata
 * and postAuthority are outside that hash and must still distinguish variants.
 */
export const certifiedEntityFrameLinkFingerprint = (link: CertifiedEntityFrameLink): string =>
  encodeCanonicalConsensusValue({
    frameHash: link.frame.hash.toLowerCase(),
    parentFrameHash: link.frame.parentFrameHash,
    stateRoot: link.frame.stateRoot.toLowerCase(),
    authorityRoot: link.frame.authorityRoot.toLowerCase(),
    leader: link.frame.leader,
    hashesToSign: link.frame.hashesToSign,
    collectedSigs: link.frame.collectedSigs,
    hankos: link.frame.hankos,
    postAuthority: link.postAuthority,
  });

export const appendCertifiedEntityFrameLink = (
  replica: EntityReplica,
  link: CertifiedEntityFrameLink,
  candidateEffects: EntityCandidateEffect[],
): void => {
  const current = replica.certifiedFrameHead;
  if (current && current.frame.height === link.frame.height && current.frame.hash !== link.frame.hash) {
    throw new Error(
      `ENTITY_CERTIFIED_LINEAGE_FORK:height=${link.frame.height}:` +
        `existing=${current.frame.hash}:incoming=${link.frame.hash}`,
    );
  }
  const fingerprint = certifiedEntityFrameLinkFingerprint(link);
  if (current && certifiedEntityFrameLinkFingerprint(current) === fingerprint) return;
  if (current && current.frame.height !== link.frame.height) {
    throw new Error(
      `ENTITY_CERTIFIED_HEAD_NOT_REBASED:existing=${current.frame.height}:incoming=${link.frame.height}`,
    );
  }
  const anchor = replica.certifiedFrameAnchor;
  if (anchor && (anchor.height + 1 !== link.frame.height || anchor.frameHash !== link.frame.parentFrameHash)) {
    throw new Error(
      `ENTITY_CERTIFIED_HEAD_ANCHOR_MISMATCH:anchor=${anchor.height}@${anchor.frameHash}:` +
        `incoming=${link.frame.height}@${link.frame.parentFrameHash}`,
    );
  }
  if (!anchor && (link.frame.height !== 1 || link.frame.parentFrameHash !== 'genesis')) {
    throw new Error(
      `ENTITY_CERTIFIED_HEAD_ANCHOR_MISSING:incoming=${link.frame.height}@${link.frame.parentFrameHash}`,
    );
  }
  candidateEffects.push({
    kind: 'entityFrameHistory',
    entityId: replica.entityId,
    signerId: replica.signerId,
    link,
  });
  replica.certifiedFrameHead = current && current.frame.height === link.frame.height
    ? (certifiedEntityFrameLinkFingerprint(current) < fingerprint ? current : link)
    : link;
};
