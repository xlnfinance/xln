import { buildQuorumHanko } from '../../../hanko/signing';
import { logError, shortHash, shortId } from '../../../support/logger';
import { removeCommittedTxsFromMempool } from '../../../protocol/state/tx-multiset';
import type { EntityState, EntityFrame, EntityCandidate } from '../../types';
import type { HankoString } from '../../../types/hanko';
import { commitEntityFrameCandidateState } from '../../state-clone';
import { emitCommittedPendingFrameWarnings } from '../../scheduler';
import {
  verifyHashPrecommitSignatures,
} from '../leader/certificates';
import { entityLog } from '../entity-log';
import {
  emitCommittedEntitySizeLog,
  prepareCommittedEntitySizeLog,
} from '../state-quota';
import {
  pruneReplicaFinalizedJHistory,
  runLocalPostCommitHooks,
} from '../j-prefix/prefix-round';
import { wrapCertifiedEntityOutputs } from '../output/consumption';
import {
  appendCertifiedEntityFrameLink,
  buildCertifiedEntityFrameLink,
} from '../frame/lineage';
import { requireCertifiedEntityFrameAfterQuorum } from '../frame/phase-views';
import {
  attachHankoWitnessToOutputs,
  getEntityHashManifestMismatch,
  isWitnessHashType,
  pruneHankoWitnessToReachableState,
  sealHankoWitnessInState,
} from '../input/hanko-witness';
import { touchedAccountIdsForHankoSeal } from '../account/touched-accounts';
import {
  commitEntityConsensusInput,
  rejectEntityConsensusInput,
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from '../input/types';
import { isEntityActiveLeader } from '../leader';

type HankoBuildResult =
  | { accepted: true; hankos: HankoString[] }
  | { accepted: false; result: ApplyEntityInputResult };

const buildCommitHankos = async (
  context: ApplyEntityInputContext,
  frame: EntityFrame,
  execution: EntityCandidate,
  signaturesBySigner: Map<string, string[]>,
  localProposal: boolean,
): Promise<HankoBuildResult> => {
  const { env, workingReplica } = context;
  const hashes = execution.hashesToSign;
  // A single-signer proposer sealed its own quorum hankos while building the
  // frame; re-verifying its own fresh signatures would be one ECDSA recover
  // per hash for nothing.
  if (localProposal && frame.hankos && frame.hankos.length === hashes.length) {
    return { accepted: true, hankos: frame.hankos };
  }
  const manifestMismatch = getEntityHashManifestMismatch(
    hashes,
    frame.hashesToSign,
  );
  if (manifestMismatch) {
    logError(
      'FRAME_CONSENSUS',
      `❌ BYZANTINE: Commit secondary hash manifest mismatch: ${manifestMismatch}`,
      {
        frame: frame.hash,
        expected: hashes,
        received: frame.hashesToSign ?? null,
      },
    );
    return { accepted: false, result: rejectEntityConsensusInput(context) };
  }
  for (const [signerId, signatures] of signaturesBySigner) {
    if (
      (localProposal && signerId.toLowerCase() === workingReplica.signerId.toLowerCase()) ||
      verifyHashPrecommitSignatures(
        env,
        signerId,
        hashes,
        signatures,
        'COMMIT_REJECTED',
      )
    ) {
      continue;
    }
    logError(
      'FRAME_CONSENSUS',
      `❌ BYZANTINE: Invalid hash signature bundle from ${signerId}`,
      { frame: frame.hash },
    );
    return { accepted: false, result: rejectEntityConsensusInput(context) };
  }
  const hankos: HankoString[] = [];
  for (let index = 0; index < hashes.length; index += 1) {
    const hashInfo = hashes[index];
    if (!hashInfo) continue;
    const signatures = [...signaturesBySigner].flatMap(
      ([signerId, signerSignatures]) => {
        const signature = signerSignatures[index];
        return signature ? [{ signerId, signature }] : [];
      },
    );
    hankos.push(
      await buildQuorumHanko(
        env,
        workingReplica.state.entityId,
        hashInfo.hash,
        signatures,
        execution.state.config,
        execution.state,
      ),
    );
  }
  entityLog.debug('commit.signatures_verified', {
    count: signaturesBySigner.size,
    frame: shortHash(frame.hash),
  });
  return { accepted: true, hankos };
};

const attachCommitProofsAndOutputs = (
  context: ApplyEntityInputContext,
  frame: EntityFrame,
  execution: EntityCandidate,
  hankos: HankoString[],
): void => {
  const { env, entityOutbox, jOutbox, workingReplica } = context;
  if (!workingReplica.hankoWitness) workingReplica.hankoWitness = new Map();
  execution.hashesToSign.forEach((hashInfo, index) => {
    const hanko = hankos[index];
    if (!hanko || !isWitnessHashType(hashInfo.type)) return;
    workingReplica.hankoWitness!.set(hashInfo.hash, {
      hanko,
      type: hashInfo.type,
      entityHeight: frame.height,
      createdAt: env.state.timestamp,
    });
  });
  sealHankoWitnessInState(
    execution.state,
    workingReplica.hankoWitness,
    frame.height,
    touchedAccountIdsForHankoSeal(
      execution.state,
      execution.proposableAccounts,
      execution.storageChanges,
    ),
  );
  attachHankoWitnessToOutputs(
    execution.outputs,
    execution.jOutputs,
    workingReplica.hankoWitness,
    frame.height,
    execution.state,
  );
  pruneHankoWitnessToReachableState(
    execution.state,
    workingReplica.hankoWitness,
  );
  const emitterId =
    frame.leader.relayCertificate?.preparedFrameHash === frame.hash
      ? frame.leader.relayCertificate.nextLeaderId
      : frame.leader.proposerSignerId;
  const isEmitter =
    emitterId.toLowerCase() === workingReplica.signerId.toLowerCase();
  entityOutbox.push(
    ...wrapCertifiedEntityOutputs(
      execution.outputs,
      frame,
      execution.state,
      env,
      execution.hashesToSign,
      hankos,
      isEmitter,
    ),
  );
  if (isEmitter) jOutbox.push(...execution.jOutputs);
};

const installCommittedState = (
  context: ApplyEntityInputContext,
  frame: EntityFrame,
  execution: EntityCandidate,
  hankos: HankoString[],
): void => {
  const { env, workingReplica, candidateEffects, storageChanges } = context;
  const previousState = workingReplica.state;
  if (context.promoteCandidateState) {
    commitEntityFrameCandidateState(execution.state, frame.stateRoot);
  }
  execution.state.entityId = previousState.entityId;
  execution.state.height = frame.height;
  execution.state.prevFrameHash = frame.hash;
  // Keep the sealed overlay object. Do not spread-clone EntityState on commit.
  const committedState = execution.state;
  const entitySizeLog = prepareCommittedEntitySizeLog(
    env,
    previousState,
    committedState,
  );
  context.consumptionNodeChanges = execution.consumptionNodeChanges;
  context.accountJClaimNodeChanges = execution.accountJClaimNodeChanges;
  emitCommittedPendingFrameWarnings(previousState, committedState);
  workingReplica.state = committedState;
  storageChanges.push(
    ...execution.storageChanges,
    { family: 'entity', entityId: committedState.entityId },
  );
  emitCommittedEntitySizeLog(entitySizeLog);
  frame.hankos = hankos;
  requireCertifiedEntityFrameAfterQuorum(frame);
  appendCertifiedEntityFrameLink(
    workingReplica,
    buildCertifiedEntityFrameLink(
      committedState.entityId,
      frame,
      committedState,
      execution.authority ? { stateRoot: frame.stateRoot, authority: execution.authority } : undefined,
    ),
    candidateEffects,
  );
  candidateEffects.push(...execution.candidateEffects);
  pruneReplicaFinalizedJHistory(workingReplica);
  if (frame.txs.length > 0) {
    workingReplica.mempool = removeCommittedTxsFromMempool(
      workingReplica.mempool,
      frame.txs,
    );
  }
};

export const finalizeCommitNotification = async (
  context: ApplyEntityInputContext,
  frame: EntityFrame,
  execution: EntityCandidate,
  signaturesBySigner: Map<string, string[]>,
  options: {
    broadcastCommit?: boolean;
    /** Board to notify (defaults to the committed board); a handover notifies the retired one. */
    broadcastValidators?: readonly string[];
    /** Frame built by this replica in this same input (single-signer board = own quorum). */
    localProposal?: boolean;
  } = {},
): Promise<ApplyEntityInputResult> => {
  const { env, entityOutbox, workingReplica } = context;
  const proof = await buildCommitHankos(
    context,
    frame,
    execution,
    signaturesBySigner,
    options.localProposal === true,
  );
  if (!proof.accepted) return proof.result;
  attachCommitProofsAndOutputs(context, frame, execution, proof.hankos);
  installCommittedState(context, frame, execution, proof.hankos);
  // Runtime persists the exact proposer-observed context committed by this
  // frame. A validator must never reconstruct it from its own live gossip.
  // Our own frame's context is already exclusively ours; no clone.
  context.entityContext = options.localProposal ? frame.entityContext : structuredClone(frame.entityContext);
  if (options.broadcastCommit) {
    const precommitSigners = [...signaturesBySigner.keys()];
    const validators = options.broadcastValidators ?? workingReplica.state.config.validators;
    entityLog.debug('commit.notify_validators', {
      frame: shortHash(frame.hash),
      validators: validators.length - 1,
      precommitSigners: precommitSigners.map(shortId),
    });
    for (const validatorId of validators) {
      if (validatorId.toLowerCase() === workingReplica.signerId.toLowerCase()) {
        continue;
      }
      entityOutbox.push({
        entityId: workingReplica.entityId,
        signerId: validatorId,
        proposedFrame: frame,
      });
    }
  }

  delete workingReplica.proposal;
  delete workingReplica.lockedFrame;
  delete workingReplica.candidate;
  if (frame.leader.relayCertificate?.preparedFrameHash === frame.hash) {
    workingReplica.pendingLeaderCertificate = structuredClone(
      frame.leader.relayCertificate,
    );
  } else {
    delete workingReplica.pendingLeaderCertificate;
  }
  workingReplica.leaderVotes = new Map();
  workingReplica.lastConsensusProgressAt = env.state.timestamp;
  workingReplica.isProposer = isEntityActiveLeader(workingReplica);
  await runLocalPostCommitHooks(env, workingReplica, entityOutbox);
  entityLog.debug('commit.applied', {
    height: workingReplica.state.height,
    frame: shortHash(frame.hash),
  });
  return commitEntityConsensusInput(context);
};
