import { shortHash, shortId } from '../../../infra/logger';
import { DEBUG } from '../../../infra/debug-flags';
import { log } from '../../../infra/diagnostics';
import { finalizeCommitNotification } from '../commit/finalization';
import { getEntityHashManifestMismatch } from '../input/hanko-witness';
import {
  commitEntityConsensusInput,
  rejectEntityConsensusInput,
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from '../input/types';
import {
  getValidatorExecutionForFrame,
  normalizePrecommitBundles,
  verifyHashPrecommitSignatures,
} from '../leader/certificates';
import { entityLog } from '../entity-log';
import {
  calculateQuorumPower,
  validateVotingPower,
} from '../replica-validation';

const validateActivePrecommitTarget = (
  context: ApplyEntityInputContext,
): ApplyEntityInputResult | null => {
  const { entityInput, workingReplica } = context;
  const proposal = workingReplica.proposal ?? workingReplica.lockedFrame!;
  const execution = getValidatorExecutionForFrame(workingReplica, proposal);
  if (!execution) {
    throw new Error(
      `ENTITY_VALIDATOR_EXECUTION_MISSING:${proposal.height}:${proposal.hash}`,
    );
  }
  if (getEntityHashManifestMismatch(execution.hashesToSign, proposal.hashesToSign)) {
    return rejectEntityConsensusInput(context, 'PRECOMMIT_LOCAL_MANIFEST_MISMATCH');
  }
  const reference = entityInput.hashPrecommitFrame;
  if (
    entityInput.hashPrecommits?.size &&
    (!reference ||
      reference.height !== proposal.height ||
      reference.frameHash.toLowerCase() !== proposal.hash.toLowerCase())
  ) {
    entityLog.warn('precommit.frame_mismatch', {
      receivedHeight: reference?.height,
      receivedHash: reference?.frameHash,
      activeHeight: proposal.height,
      activeHash: proposal.hash,
    });
    return rejectEntityConsensusInput(context, 'PRECOMMIT_FRAME_MISMATCH');
  }
  return null;
};

const normalizeIncomingPrecommits = (
  context: ApplyEntityInputContext,
): Map<string, string[]> | ApplyEntityInputResult => {
  const { entityInput, workingReplica } = context;
  const proposal = workingReplica.proposal ?? workingReplica.lockedFrame!;
  const execution = getValidatorExecutionForFrame(workingReplica, proposal);
  if (!execution) {
    throw new Error(
      `ENTITY_VALIDATOR_EXECUTION_MISSING:${proposal.height}:${proposal.hash}`,
    );
  }
  try {
    proposal.collectedSigs = normalizePrecommitBundles(
      execution.state.config,
      proposal.collectedSigs ?? new Map(),
      'COLLECTED_PRECOMMITS_REJECTED',
    );
  } catch (error) {
    entityLog.error('precommit.collected_bundle_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'COLLECTED_PRECOMMITS_REJECTED');
  }
  try {
    return entityInput.hashPrecommits?.size
      ? normalizePrecommitBundles(
          execution.state.config,
          entityInput.hashPrecommits,
          'PRECOMMIT_REJECTED',
        )
      : new Map();
  } catch (error) {
    entityLog.error('precommit.bundle_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'PRECOMMIT_BUNDLE_REJECTED');
  }
};

const mergeVerifiedPrecommits = (
  context: ApplyEntityInputContext,
  incoming: Map<string, string[]>,
): ApplyEntityInputResult | null => {
  const { env, workingReplica } = context;
  const proposal = workingReplica.proposal ?? workingReplica.lockedFrame!;
  const execution = getValidatorExecutionForFrame(workingReplica, proposal)!;
  const collectedSigs = proposal.collectedSigs;
  if (!collectedSigs) {
    throw new Error(
      `ENTITY_PRECOMMIT_COLLECTION_MISSING_AFTER_NORMALIZATION:${proposal.height}:${proposal.hash}`,
    );
  }
  for (const [signerId, signatures] of incoming) {
    if (!verifyHashPrecommitSignatures(
      env,
      signerId,
      execution.hashesToSign,
      signatures,
      'PRECOMMIT_REJECTED',
    )) {
      return rejectEntityConsensusInput(context, 'PRECOMMIT_SIGNATURE_REJECTED');
    }
    const existing = collectedSigs.get(signerId);
    if (
      existing &&
      (existing.length !== signatures.length ||
        existing.some((signature, index) => signature !== signatures[index]))
    ) {
      return rejectEntityConsensusInput(context, 'PRECOMMIT_SIGNER_EQUIVOCATION');
    }
    collectedSigs.set(signerId, [...signatures]);
  }
  return null;
};

const mergeIncomingPrecommits = (
  context: ApplyEntityInputContext,
): ApplyEntityInputResult | null => {
  const targetRejection = validateActivePrecommitTarget(context);
  if (targetRejection) return targetRejection;
  const incoming = normalizeIncomingPrecommits(context);
  if (!(incoming instanceof Map)) return incoming;
  return mergeVerifiedPrecommits(context, incoming);
};

export const handleHashPrecommits = async (
  context: ApplyEntityInputContext,
): Promise<ApplyEntityInputResult | null> => {
  const { entityInput, workingReplica } = context;
  const hasIncoming = Boolean(entityInput.hashPrecommits?.size);
  const proposal = workingReplica.proposal ?? workingReplica.lockedFrame;
  if (!proposal) {
    if (!hasIncoming) return null;
    const reference = entityInput.hashPrecommitFrame;
    // Same catch-up shape as stale j-prefix: the Entity height already moved on,
    // so commit as a no-op so reliable ingress can terminalize the delivery.
    if (reference && workingReplica.state.height > reference.height) {
      return commitEntityConsensusInput(context);
    }
    return rejectEntityConsensusInput(context, 'PRECOMMIT_FRAME_NOT_ACTIVE');
  }
  const mergeResult = mergeIncomingPrecommits(context);
  if (mergeResult) return mergeResult;
  const execution = getValidatorExecutionForFrame(workingReplica, proposal);
  if (!execution) {
    throw new Error(
      `ENTITY_VALIDATOR_EXECUTION_MISSING:${proposal.height}:${proposal.hash}`,
    );
  }
  const signers = [...(proposal.collectedSigs?.keys() ?? [])];
  const authorityConfig = execution.state.config;
  const power = calculateQuorumPower(authorityConfig, signers);
  if (!validateVotingPower(power)) {
    throw new Error(`ENTITY_CONSENSUS_FATAL_INVALID_VOTING_POWER:${power}`);
  }
  if (DEBUG) {
    const totalShares = Object.values(
      authorityConfig.shares,
    ).reduce((sum, value) => sum + value, 0n);
    log.info(
      `    🔍 Threshold check: ${power} / ${totalShares} ` +
        `[${((Number(power) / Number(authorityConfig.threshold)) * 100).toFixed(1)}%]`,
    );
  }
  if (power < authorityConfig.threshold) return null;

  const emitterId =
    proposal.leader.relayCertificate?.preparedFrameHash === proposal.hash
      ? proposal.leader.relayCertificate.nextLeaderId
      : proposal.leader.proposerSignerId;
  const isEmitter =
    emitterId.toLowerCase() === workingReplica.signerId.toLowerCase();
  if (!isEmitter && execution.jOutputs.length > 0) {
    entityLog.warn('commit.external_output_waiting_for_certified_emitter', {
      frame: shortHash(proposal.hash),
      emitter: shortId(emitterId),
      jOutputs: execution.jOutputs.length,
    });
    return null;
  }
  entityLog.debug('commit.threshold_reached', {
    signers: signers.length,
    hashes: execution.hashesToSign.length,
  });
  return finalizeCommitNotification(
    context,
    proposal,
    execution,
    proposal.collectedSigs ?? new Map(),
    { broadcastCommit: true },
  );
};
