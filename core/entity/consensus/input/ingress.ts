import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

import { shortId } from '../../../support/logger';
import { cloneIsolatedEntityInput } from '../../state/input-clone';
import { forkEntityReplicaForInput } from '../../replica/replica-clone';
import type { EntityInput, EntityReplica } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import { HEAVY_LOGS } from '../../../support/debug-flags';
import { log } from '../../../support/diagnostics';
import { copyLocalEntityLeaderTimeoutVoteAuthorization } from '../leader';
import { normalizeProposedFrameCollectedSigs } from './hanko-witness';
import {
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from './types';
import {
  getEntityMempoolAdmissionError,
  isSingleSignerEntity,
  isEntityInputWellFormed,
} from '../replica-validation';
import { entityLog } from '../entity-log';

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
    candidateEffects: [],
    storageChanges: [],
  },
});

const logEntityInput = (
  env: EntityRuntimeContext,
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
      ts: env.state.timestamp,
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
  env: EntityRuntimeContext,
  replica: EntityReplica,
  ingressInput: EntityInput,
  trustedLocalRuntimeProtocol: 'cross-j' | 'account-work' | undefined,
  promoteCandidateState: boolean,
): EntityInputIngress => {
  const trustedLocalCrossJurisdiction = trustedLocalRuntimeProtocol === 'cross-j';
  if (trustedLocalCrossJurisdiction && !isSingleSignerEntity(replica.state)) {
    throw haltRuntimeFailure("CROSS_J_LOCAL_COMMAND_SINGLE_SIGNER_REQUIRED", `CROSS_J_LOCAL_COMMAND_SINGLE_SIGNER_REQUIRED:${replica.entityId}`);
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

  // Validate the exact wire bytes before canonical clone normalization can
  // discard forbidden fields or coerce malformed signature containers.
  if (!isEntityInputWellFormed(ingressInput)) {
    const detail =
      `entityId=${ingressInput.entityId} ` +
      `txs=${ingressInput.entityTxs?.map(tx => tx.type).join(',') || 'none'}`;
    log.error(`❌ Invalid ingress input for ${ingressInput.entityId}: ${detail}`);
    return rejectIngress('ENTITY_INPUT_INVALID', replica);
  }
  const accountInputOnly = Boolean(
    ingressInput.entityTxs?.length &&
    ingressInput.entityTxs.every(tx => tx.type === 'accountInput') &&
    !ingressInput.proposedFrame &&
    !ingressInput.hashPrecommits &&
    !ingressInput.jPrefixAttestations &&
    !ingressInput.leaderTimeoutVote,
  );
  const workingReplica = forkEntityReplicaForInput(replica, accountInputOnly);
  const input = cloneIsolatedEntityInput(ingressInput);
  if (ingressInput.leaderTimeoutVote && input.leaderTimeoutVote) {
    copyLocalEntityLeaderTimeoutVoteAuthorization(
      ingressInput.leaderTimeoutVote,
      input.leaderTimeoutVote,
    );
  }
  normalizeProposedFrameCollectedSigs(input.proposedFrame);
  const entityDisplay = input.entityId;
  const frameHash = input.proposedFrame?.hash?.slice(0, 10) || 'none';
  logEntityInput(env, input, workingReplica, entityDisplay, frameHash);

  return {
    accepted: true,
    context: {
      env,
      entityInput: input,
      workingReplica,
      entityOutbox: [],
      jOutbox: [],
      candidateEffects: [],
      storageChanges: [],
      frameHash,
      promoteCandidateState,
      // The WAL journals one context per committed proposer frame, keyed by
      // replica and height, for external inputs and for Runtime-derived
      // account-work / immediate cross-J frames alike. Replay consumes the
      // exact height-bound context of each frame and never re-materializes.
      usePersistedReplayContext: true,
    },
    entityDisplay,
    quietRuntimeLogs: env.quietRuntimeLogs === true,
  };
};
