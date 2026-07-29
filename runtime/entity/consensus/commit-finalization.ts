import { cacheCommittedAccountJClaimNodeChanges } from '../../account/j-claim-store';
import { buildQuorumHanko } from '../../hanko/signing';
import { logError, shortHash, shortId } from '../../infra/logger';
import { removeCommittedTxsFromMempool } from '../../protocol/tx-multiset';
import type {
  EntityState,
  HankoString,
  ProposedEntityFrame,
  ValidatorEntityFrameExecution,
} from '../../types';
import { cacheCommittedConsumptionNodeChanges } from '../consumption-store';
import { emitCommittedPendingFrameWarnings } from '../scheduler';
import {
  appendCertifiedEntityFrameLink,
  buildCertifiedEntityFrameLink,
  emitCommittedEntitySizeLog,
  entityLog,
  prepareCommittedEntitySizeLog,
  pruneReplicaFinalizedJHistory,
  runLocalPostCommitHooks,
  verifyHashPrecommitSignatures,
  wrapCertifiedEntityOutputs,
} from './shared';
import {
  attachHankoWitnessToOutputs,
  getEntityHashManifestMismatch,
  isWitnessHashType,
  pruneHankoWitnessToReachableState,
  sealHankoWitnessInState,
} from './hanko-witness';
import {
  commitEntityConsensusInput,
  rejectEntityConsensusInput,
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from './input-types';
import { isEntityActiveLeader } from './leader';

type HankoBuildResult =
  | { accepted: true; hankos: HankoString[] }
  | { accepted: false; result: ApplyEntityInputResult };

const buildCommitHankos = async (
  context: ApplyEntityInputContext,
  frame: ProposedEntityFrame,
  execution: ValidatorEntityFrameExecution,
  signaturesBySigner: Map<string, string[]>,
): Promise<HankoBuildResult> => {
  const { env, workingReplica } = context;
  const hashes = execution.hashesToSign;
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
      verifyHashPrecommitSignatures(
        env,
        signerId,
        hashes,
        frame.hash,
        frame.height,
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
        workingReplica.state.config,
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
  frame: ProposedEntityFrame,
  execution: ValidatorEntityFrameExecution,
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
      createdAt: env.timestamp,
    });
  });
  sealHankoWitnessInState(
    execution.state,
    workingReplica.hankoWitness,
    frame.height,
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
  frame: ProposedEntityFrame,
  execution: ValidatorEntityFrameExecution,
  hankos: HankoString[],
): void => {
  const { env, workingReplica, candidateEffects, storageChanges } = context;
  const previousState = workingReplica.state;
  const committedState = {
    ...execution.state,
    entityId: previousState.entityId,
    height: frame.height,
    prevFrameHash: frame.hash,
  } as EntityState;
  const entitySizeLog = prepareCommittedEntitySizeLog(
    env,
    previousState,
    committedState,
  );
  cacheCommittedConsumptionNodeChanges(env, execution.consumptionNodeChanges);
  cacheCommittedAccountJClaimNodeChanges(
    env,
    execution.accountJClaimNodeChanges,
  );
  workingReplica.state = committedState;
  storageChanges.push(
    ...execution.storageChanges,
    { family: 'entity', entityId: committedState.entityId },
  );
  emitCommittedPendingFrameWarnings(previousState, committedState);
  emitCommittedEntitySizeLog(entitySizeLog);
  frame.hankos = hankos;
  appendCertifiedEntityFrameLink(
    workingReplica,
    buildCertifiedEntityFrameLink(
      committedState.entityId,
      frame,
      committedState,
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
  frame: ProposedEntityFrame,
  execution: ValidatorEntityFrameExecution,
  signaturesBySigner: Map<string, string[]>,
  options: { broadcastCommit?: boolean } = {},
): Promise<ApplyEntityInputResult> => {
  const { env, entityOutbox, workingReplica } = context;
  const proof = await buildCommitHankos(
    context,
    frame,
    execution,
    signaturesBySigner,
  );
  if (!proof.accepted) return proof.result;
  attachCommitProofsAndOutputs(context, frame, execution, proof.hankos);
  installCommittedState(context, frame, execution, proof.hankos);
  if (options.broadcastCommit) {
    const precommitSigners = [...signaturesBySigner.keys()];
    entityLog.debug('commit.notify_validators', {
      frame: shortHash(frame.hash),
      validators: workingReplica.state.config.validators.length - 1,
      precommitSigners: precommitSigners.map(shortId),
    });
    for (const validatorId of workingReplica.state.config.validators) {
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
  delete workingReplica.validatorExecution;
  if (frame.leader.relayCertificate?.preparedFrameHash === frame.hash) {
    workingReplica.pendingLeaderCertificate = structuredClone(
      frame.leader.relayCertificate,
    );
  } else {
    delete workingReplica.pendingLeaderCertificate;
  }
  workingReplica.leaderVotes = new Map();
  workingReplica.lastConsensusProgressAt = env.timestamp;
  workingReplica.isProposer = isEntityActiveLeader(workingReplica);
  await runLocalPostCommitHooks(env, workingReplica, entityOutbox);
  entityLog.debug('commit.applied', {
    height: workingReplica.state.height,
    frame: shortHash(frame.hash),
  });
  return commitEntityConsensusInput(context);
};
