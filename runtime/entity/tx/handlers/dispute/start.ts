import type { AccountReplica, RuntimeOverlayRecord } from '../../../../types/account';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import {
  encodeJBatch,
  batchOpCount,
  J_BATCH_CONTRACT_LIMITS,
} from '../../../../jurisdiction/machine/batch';
import { shortHash, shortId } from '../../../../infra/logger';
import {
  freezeAccountForDispute,
  isDisputeStartedByLeft,
} from '../../../../account/consensus/dispute-policy';
import { disputeLog } from './shared';
import {
  admitDisputeStart,
  validateCrossJurisdictionDisputeRoute,
} from './start-admission';
import {
  buildStarterArguments,
  loadStartProof,
  resolveStartNonce,
  type StartEvidence,
} from './start-evidence';
import { verifyStartHanko } from './start-hanko';

type StartTx = Extract<EntityTx, { type: 'disputeStart' }>;

const queueDisputeStart = (
  sourceState: EntityState,
  state: EntityState,
  account: AccountReplica,
  tx: StartTx,
  evidence: StartEvidence,
  outputs: EntityInput[],
): void => {
  const batch = state.jBatchState!.batch;
  if (batch.disputeStarts.length >= J_BATCH_CONTRACT_LIMITS.maxDisputeStarts) {
    throw new Error(
      `J_BATCH_LIMIT_EXCEEDED: disputeStarts ${batch.disputeStarts.length + 1}/` +
      `${J_BATCH_CONTRACT_LIMITS.maxDisputeStarts}`,
    );
  }
  if (batchOpCount(batch) + 1 > J_BATCH_CONTRACT_LIMITS.maxTotalOps) {
    throw new Error(
      `J_BATCH_LIMIT_EXCEEDED: disputeStart would exceed total ops ${batchOpCount(batch) + 1}/` +
      `${J_BATCH_CONTRACT_LIMITS.maxTotalOps}`,
    );
  }
  batch.disputeStarts.push({
    counterentity: tx.data.counterpartyEntityId,
    nonce: evidence.signedNonce,
    proofbodyHash: evidence.proofBodyHash,
    initialProofbody: evidence.initialProofbody,
    watchSeed: String(evidence.initialProofbody.watchSeed),
    sig: evidence.counterpartyHanko,
    starterInitialArguments: evidence.starterInitialArguments,
    starterIncrementedArguments: evidence.starterIncrementedArguments,
  });
  encodeJBatch(batch);
  if (tx.data.crossJurisdictionRouteId) {
    state.jBatchState!.autoBroadcastDraft = true;
    if (!state.jBatchState!.sentBatch) {
      const signerId = state.config.validators[0];
      if (!signerId) throw new Error('DISPUTE_START_CROSS_J_BROADCAST_SIGNER_MISSING');
      outputs.push({
        entityId: state.entityId,
        signerId,
        entityTxs: [{ type: 'j_broadcast', data: {} }],
      });
    }
  }
  account.status = 'disputed';
  const crossJurisdictionRecovery = account.disputePrepare?.crossJurisdictionRecovery;
  delete account.disputePrepare;
  freezeAccountForDispute(account, false);
  account.activeDispute ??= {
    startedByLeft: isDisputeStartedByLeft(
      sourceState.entityId,
      account.state.leftEntity,
      account.state.rightEntity,
    ),
    initialProofbodyHash: evidence.proofBodyHash,
    initialNonce: evidence.signedNonce,
    // Depository chooses the authoritative timeout at inclusion height.
    disputeTimeout: 0,
    jNonce: evidence.jNonce,
    starterInitialArguments: evidence.starterInitialArguments,
    starterIncrementedArguments: evidence.starterIncrementedArguments,
    observedOnChain: false,
    finalizeQueued: false,
    ...(crossJurisdictionRecovery ? { crossJurisdictionRecovery } : {}),
  };
  if (crossJurisdictionRecovery && !account.activeDispute.crossJurisdictionRecovery) {
    account.activeDispute.crossJurisdictionRecovery = crossJurisdictionRecovery;
  }
};

export const handleDisputeStart = async (
  entityState: EntityState,
  entityTx: StartTx,
  env: EntityRuntimeContext,
  _storageChanges: RuntimeOverlayRecord[] = [],
  mutableFrameState = false,
): Promise<{ newState: EntityState; outputs: EntityInput[] }> => {
  if (entityTx.data.starterIncrementedArguments !== undefined) {
    throw new Error('DISPUTE_INCREMENTED_ARGUMENT_OVERRIDE_UNSUPPORTED');
  }
  validateCrossJurisdictionDisputeRoute(entityState, entityTx);
  const counterpartyId = entityTx.data.counterpartyEntityId;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  disputeLog.debug('start.begin', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyId),
  });
  const account = admitDisputeStart(newState, counterpartyId);
  if (!account) return { newState, outputs };
  const proof = loadStartProof(entityState, newState, account, counterpartyId);
  if (!proof) return { newState, outputs };
  const nonce = resolveStartNonce(newState, account, counterpartyId, proof.proofBodyHash);
  if (!nonce) return { newState, outputs };
  const argumentsPair = buildStarterArguments(
    newState,
    account,
    counterpartyId,
    proof.proofBodyHash,
    nonce.signedNonce,
    entityTx.data.starterInitialArguments,
    env,
  );
  const evidence: StartEvidence = { ...proof, ...nonce, ...argumentsPair };
  if (!(await verifyStartHanko(entityState, newState, account, counterpartyId, evidence, env))) {
    return { newState, outputs };
  }
  queueDisputeStart(entityState, newState, account, entityTx, evidence, outputs);
  disputeLog.debug('start.jbatch_queued', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyId),
    proofBodyHash: shortHash(evidence.proofBodyHash),
    hankoLen: evidence.counterpartyHanko.length,
    signedNonce: evidence.signedNonce,
  });
  const description = entityTx.data.description;
  addMessage(
    newState,
    `⚔️ Dispute started vs ${counterpartyId.slice(-4)} ${description ? `(${description})` : ''} - account frozen, use jBroadcast to commit`,
  );
  return { newState, outputs };
};
