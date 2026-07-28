import type {
  AccountMachine,
  EntityInput,
  EntityState,
  EntityTx,
  Env,
  RuntimeOverlayRecord,
} from '../../../../types';
import { addMessage, cloneEntityState } from '../../../../state-helpers';
import {
  encodeJBatch,
  getBatchSize,
  J_BATCH_CONTRACT_LIMITS,
} from '../../../../jurisdiction/batch';
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
  account: AccountMachine,
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
  if (getBatchSize(batch) + 1 > J_BATCH_CONTRACT_LIMITS.maxTotalOps) {
    throw new Error(
      `J_BATCH_LIMIT_EXCEEDED: disputeStart would exceed total ops ${getBatchSize(batch) + 1}/` +
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
  delete account.disputePrepare;
  freezeAccountForDispute(account, false);
  account.activeDispute ??= {
    startedByLeft: isDisputeStartedByLeft(
      sourceState.entityId,
      account.leftEntity,
      account.rightEntity,
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
  };
};

export const handleDisputeStart = async (
  entityState: EntityState,
  entityTx: StartTx,
  env: Env,
  _storageChanges: RuntimeOverlayRecord[] = [],
): Promise<{ newState: EntityState; outputs: EntityInput[] }> => {
  if (entityTx.data.starterIncrementedArguments !== undefined) {
    throw new Error('DISPUTE_INCREMENTED_ARGUMENT_OVERRIDE_UNSUPPORTED');
  }
  validateCrossJurisdictionDisputeRoute(entityState, entityTx);
  const counterpartyId = entityTx.data.counterpartyEntityId;
  const newState = cloneEntityState(entityState);
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
