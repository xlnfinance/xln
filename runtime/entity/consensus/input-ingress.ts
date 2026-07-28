import { shortId } from '../../infra/logger';
import { cloneIsolatedEntityInput } from '../../protocol/runtime-input-clone';
import { cloneEntityReplica } from '../../state-helpers';
import type { EntityInput, EntityReplica, RuntimeState } from '../../types';
import { formatEntityDisplay, HEAVY_LOGS, log } from '../../utils';
import { copyLocalEntityLeaderTimeoutVoteAuthorization } from './leader';
import { normalizeProposedFrameCollectedSigs } from './hanko-witness';
import {
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from './input-types';
import {
  entityLog,
  getEntityMempoolAdmissionError,
  isSingleSignerEntity,
  isEntityInputWellFormed,
  validateEntityReplica,
} from './shared';

export type EntityInputIngress =
  | { accepted: false; result: ApplyEntityInputResult }
  | {
      accepted: true;
      context: ApplyEntityInputContext;
      entityDisplay: string;
      quietRuntimeLogs: boolean;
    };

const rejectIngress = (
  code: string,
  replica: EntityReplica,
): EntityInputIngress => ({
  accepted: false,
  result: {
    outcome: { kind: 'rejected', code },
    newState: replica.state,
    outputs: [],
    jOutputs: [],
    workingReplica: replica,
  },
});

const logEntityInput = (
  env: RuntimeState,
  input: EntityInput,
  replica: EntityReplica,
  entityDisplay: string,
  frameHash: string,
): void => {
  if (env.quietRuntimeLogs !== true) {
    const hasActivity = Boolean(
      (input.entityTxs?.length ?? 0) > 0 ||
      input.proposedFrame ||
      input.hashPrecommits?.size ||
      input.jPrefixAttestations?.size,
    );
    const write = hasActivity ? entityLog.info : entityLog.debug;
    write('input.received', {
      entity: entityDisplay,
      signer: shortId(replica.signerId),
      ts: env.timestamp,
      txs: input.entityTxs?.map(tx => tx.type) ?? [],
      mempool: replica.mempool.length,
      proposer: replica.isProposer,
      proposal: replica.proposal?.hash?.slice(0, 10) || 'none',
      frame: frameHash,
      precommits: input.hashPrecommits?.size || 0,
      jPrefixAttestations: input.jPrefixAttestations?.size || 0,
    });
  }
  if (input.hashPrecommits?.size && HEAVY_LOGS) {
    entityLog.debug('input.precommits', {
      signers: [...input.hashPrecommits.keys()].map(shortId),
    });
  }
};

export const prepareEntityInputIngress = (
  env: RuntimeState,
  replica: EntityReplica,
  ingressInput: EntityInput,
  trustedLocalCrossJurisdiction: boolean,
): EntityInputIngress => {
  if (trustedLocalCrossJurisdiction && !isSingleSignerEntity(replica.state)) {
    throw new Error(`CROSS_J_LOCAL_COMMAND_SINGLE_SIGNER_REQUIRED:${replica.entityId}`);
  }
  const admissionError = getEntityMempoolAdmissionError(
    replica,
    ingressInput,
    trustedLocalCrossJurisdiction,
  );
  if (admissionError) {
    log.error(
      `❌ Entity mempool admission rejected for ${ingressInput.entityId}: ${admissionError}`,
    );
    return rejectIngress('ENTITY_MEMPOOL_ADMISSION_REJECTED', replica);
  }

  // Validate the exact retry bytes before canonical clone normalization can
  // discard forbidden fields or coerce malformed signature containers.
  const workingReplica = cloneEntityReplica(replica);
  if (!isEntityInputWellFormed(ingressInput)) {
    const detail =
      `entityId=${ingressInput.entityId} ` +
      `txs=${ingressInput.entityTxs?.map(tx => tx.type).join(',') || 'none'}`;
    log.error(`❌ Invalid ingress input for ${ingressInput.entityId}: ${detail}`);
    return rejectIngress('ENTITY_INPUT_INVALID', workingReplica);
  }
  const input = cloneIsolatedEntityInput(ingressInput);
  if (ingressInput.leaderTimeoutVote && input.leaderTimeoutVote) {
    copyLocalEntityLeaderTimeoutVoteAuthorization(
      ingressInput.leaderTimeoutVote,
      input.leaderTimeoutVote,
    );
  }
  normalizeProposedFrameCollectedSigs(input.proposedFrame);
  const entityDisplay = formatEntityDisplay(input.entityId);
  const frameHash = input.proposedFrame?.hash?.slice(0, 10) || 'none';
  logEntityInput(env, input, workingReplica, entityDisplay, frameHash);

  if (!isEntityInputWellFormed(input)) {
    const detail =
      `entityId=${input.entityId} ` +
      `txs=${input.entityTxs?.map(tx => tx.type).join(',') || 'none'}`;
    log.error(`❌ Invalid input for ${input.entityId}: ${detail}`);
    return rejectIngress('ENTITY_INPUT_INVALID', workingReplica);
  }
  if (!validateEntityReplica(workingReplica)) {
    log.error(
      `❌ Invalid replica state for ${workingReplica.entityId}:${workingReplica.signerId}`,
    );
    return rejectIngress('ENTITY_REPLICA_INVALID', workingReplica);
  }
  return {
    accepted: true,
    context: {
      env,
      entityInput: input,
      workingReplica,
      entityOutbox: [],
      jOutbox: [],
      frameHash,
    },
    entityDisplay,
    quietRuntimeLogs: env.quietRuntimeLogs === true,
  };
};
