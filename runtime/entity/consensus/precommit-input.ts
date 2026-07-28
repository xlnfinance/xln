import { shortHash, shortId } from '../../infra/logger';
import { DEBUG, log } from '../../utils';
import { finalizeCommitNotification } from './commit-finalization';
import { getEntityHashManifestMismatch } from './hanko-witness';
import {
  rejectEntityConsensusInput,
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from './input-types';
import {
  calculateQuorumPower,
  entityLog,
  getValidatorExecutionForFrame,
  normalizePrecommitBundles,
  validateVotingPower,
  verifyHashPrecommitSignatures,
} from './shared';

const mergeIncomingPrecommits = (
  context: ApplyEntityInputContext,
): ApplyEntityInputResult | null => {
  const { env, entityInput, workingReplica } = context;
  const proposal = workingReplica.proposal ?? workingReplica.lockedFrame!;
  const execution = getValidatorExecutionForFrame(workingReplica, proposal);
  if (!execution) {
    throw new Error(
      `ENTITY_VALIDATOR_EXECUTION_MISSING:${proposal.height}:${proposal.hash}`,
    );
  }
  if (
    getEntityHashManifestMismatch(
      execution.hashesToSign,
      proposal.hashesToSign,
    )
  ) {
    return rejectEntityConsensusInput(
      context,
      'PRECOMMIT_LOCAL_MANIFEST_MISMATCH',
    );
  }
  const precommitFrame = entityInput.hashPrecommitFrame;
  if (
    entityInput.hashPrecommits?.size &&
    (!precommitFrame ||
      precommitFrame.height !== proposal.height ||
      precommitFrame.frameHash.toLowerCase() !== proposal.hash.toLowerCase())
  ) {
    entityLog.warn('precommit.frame_mismatch', {
      receivedHeight: precommitFrame?.height,
      receivedHash: precommitFrame?.frameHash,
      activeHeight: proposal.height,
      activeHash: proposal.hash,
    });
    return rejectEntityConsensusInput(context, 'PRECOMMIT_FRAME_MISMATCH');
  }
  try {
    proposal.collectedSigs = normalizePrecommitBundles(
      workingReplica.state.config,
      proposal.collectedSigs ?? new Map(),
      'COLLECTED_PRECOMMITS_REJECTED',
    );
  } catch (error) {
    entityLog.error('precommit.collected_bundle_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(
      context,
      'COLLECTED_PRECOMMITS_REJECTED',
    );
  }
  let incoming = new Map<string, string[]>();
  try {
    if (entityInput.hashPrecommits?.size) {
      incoming = normalizePrecommitBundles(
        workingReplica.state.config,
        entityInput.hashPrecommits,
        'PRECOMMIT_REJECTED',
      );
    }
  } catch (error) {
    entityLog.error('precommit.bundle_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'PRECOMMIT_BUNDLE_REJECTED');
  }
  for (const [signerId, signatures] of incoming) {
    if (
      !verifyHashPrecommitSignatures(
        env,
        signerId,
        execution.hashesToSign,
        proposal.hash,
        proposal.height,
        signatures,
        'PRECOMMIT_REJECTED',
      )
    ) {
      return rejectEntityConsensusInput(
        context,
        'PRECOMMIT_SIGNATURE_REJECTED',
      );
    }
    const existing = proposal.collectedSigs.get(signerId);
    if (
      existing &&
      (existing.length !== signatures.length ||
        existing.some(
          (signature, index) => signature !== signatures[index],
        ))
    ) {
      return rejectEntityConsensusInput(
        context,
        'PRECOMMIT_SIGNER_EQUIVOCATION',
      );
    }
    proposal.collectedSigs.set(signerId, [...signatures]);
  }
  return null;
};

export const handleHashPrecommits = async (
  context: ApplyEntityInputContext,
): Promise<ApplyEntityInputResult | null> => {
  const { entityInput, workingReplica } = context;
  const hasIncoming = Boolean(entityInput.hashPrecommits?.size);
  const proposal = workingReplica.proposal ?? workingReplica.lockedFrame;
  if (!proposal) {
    return hasIncoming
      ? rejectEntityConsensusInput(context, 'PRECOMMIT_FRAME_NOT_ACTIVE')
      : null;
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
  const power = calculateQuorumPower(workingReplica.state.config, signers);
  if (!validateVotingPower(power)) {
    throw new Error(`ENTITY_CONSENSUS_FATAL_INVALID_VOTING_POWER:${power}`);
  }
  if (DEBUG) {
    const totalShares = Object.values(
      workingReplica.state.config.shares,
    ).reduce((sum, value) => sum + value, 0n);
    log.info(
      `    🔍 Threshold check: ${power} / ${totalShares} ` +
        `[${((Number(power) / Number(workingReplica.state.config.threshold)) * 100).toFixed(1)}%]`,
    );
  }
  if (power < workingReplica.state.config.threshold) return null;

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
