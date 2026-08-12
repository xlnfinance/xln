import { verifyAccountSignature } from '../../../account/crypto';
import type { EntityFrame } from '../../types';
import { createEntityFrameHashFromStateRoot, isCanonicalEntityFrameDigest } from '../frame';
import { getPrevFrameHash } from '../frame/lineage';
import { buildEntityHashesToSign } from '../input/hanko-witness';
import {
  rejectEntityConsensusInput,
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from '../input/types';
import { validateProposedFrameLeader } from './policy';

const reject = (
  context: ApplyEntityInputContext,
  code: string,
): ApplyEntityInputResult => rejectEntityConsensusInput(context, code);

const hasCanonicalProposalEnvelope = (
  context: ApplyEntityInputContext,
  frame: EntityFrame,
): string | null => {
  const state = context.workingReplica.state;
  if (!Number.isSafeInteger(frame.height) || frame.height !== state.height + 1) {
    return 'PROPOSAL_HEIGHT_INVALID';
  }
  if (!Number.isSafeInteger(frame.timestamp) || frame.timestamp < state.timestamp) {
    return 'PROPOSAL_TIMESTAMP_INVALID';
  }
  if (
    !isCanonicalEntityFrameDigest(frame.hash) ||
    !isCanonicalEntityFrameDigest(frame.stateRoot) ||
    !isCanonicalEntityFrameDigest(frame.authorityRoot)
  ) {
    return 'PROPOSAL_DIGEST_NON_CANONICAL';
  }
  if (frame.parentFrameHash !== getPrevFrameHash(state)) {
    return 'PROPOSAL_PARENT_MISMATCH';
  }
  return null;
};

const hasExactFrameManifestHead = (
  context: ApplyEntityInputContext,
  frame: EntityFrame,
): boolean => {
  const expected = buildEntityHashesToSign(
    context.workingReplica.state.entityId,
    frame.height,
    frame.hash,
  )[0]!;
  const received = frame.hashesToSign?.[0];
  return Boolean(
    received &&
    received.hash === expected.hash &&
    received.type === expected.type &&
    received.context === expected.context,
  );
};

const getUniqueProposerFrameSignature = (
  frame: EntityFrame,
): string | null => {
  const proposer = frame.leader.proposerSignerId.trim().toLowerCase();
  let matched: string[] | undefined;
  for (const [rawSignerId, signatures] of frame.collectedSigs ?? new Map()) {
    if (rawSignerId.trim().toLowerCase() !== proposer) continue;
    if (matched) return null;
    matched = signatures;
  }
  if (!Array.isArray(matched) || typeof matched[0] !== 'string') return null;
  return matched[0];
};

/**
 * Authenticate the immutable proposal body before executing any nested tx.
 *
 * The proposer signature is index zero because the canonical manifest always
 * starts with the Entity frame hash. Secondary hashes are derived only after
 * isolated replay and are verified by the ordinary precommit path.
 */
export const preauthenticateEntityProposal = (
  context: ApplyEntityInputContext,
  frame: EntityFrame,
): ApplyEntityInputResult | null => {
  const envelopeError = hasCanonicalProposalEnvelope(context, frame);
  if (envelopeError) return reject(context, envelopeError);
  if (!validateProposedFrameLeader(context.env, context.workingReplica.state, frame)) {
    return reject(context, 'PROPOSAL_LEADER_INVALID');
  }
  const recomputedHash = createEntityFrameHashFromStateRoot(
    frame.parentFrameHash,
    frame.height,
    frame.timestamp,
    frame.txs,
    frame.events,
    context.workingReplica.state.entityId,
    frame.stateRoot,
    frame.authorityRoot,
    frame.jPrefixCertificate,
  );
  if (recomputedHash !== frame.hash) {
    return reject(context, 'PROPOSAL_FRAME_HASH_MISMATCH');
  }
  if (!hasExactFrameManifestHead(context, frame)) {
    return reject(context, 'PROPOSAL_FRAME_MANIFEST_INVALID');
  }
  const signature = getUniqueProposerFrameSignature(frame);
  if (!signature) {
    return reject(context, 'PROPOSAL_PROPOSER_SIGNATURE_REQUIRED');
  }
  if (!verifyAccountSignature(
    context.env,
    frame.leader.proposerSignerId,
    frame.hash,
    signature,
  )) {
    return reject(context, 'PROPOSAL_PROPOSER_SIGNATURE_INVALID');
  }
  return null;
};
