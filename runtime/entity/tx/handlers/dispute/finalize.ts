import type { AccountReplica } from '../../../../types/account';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import {
  batchAddRevealSecret,
  encodeJBatch,
  batchOpCount,
  J_BATCH_CONTRACT_LIMITS,
} from '../../../../jurisdiction/machine/batch';
import { getEntityCertifiedJurisdictionHeight } from '../../../../jurisdiction/machine/height';
import { requireAccountDeltaTransformerAddress } from '../../../../account/consensus/helpers';
import { collectKnownDisputeSecretsForSnapshot } from '../../../dispute-arguments';
import { isUsableContractAddress } from '../../../../jurisdiction/machine/contract-address';
import { shortId } from '../../../../infra/logger';
import { disputeLog, warnDisputeUnlessQuiet } from './shared';
import { admitDisputeFinalize } from './finalize-admission';
import { scheduleHook } from '../../../scheduler';
import { refreshCrossJurisdictionTargetRecovery } from '../../j-events-htlc';
import {
  buildFinalProofPayload,
  selectFinalProof,
  verifyCounterProofIdentity,
  type FinalProofPayload,
} from './finalize-proof';

type FinalizeTx = Extract<EntityTx, { type: 'disputeFinalize' }>;

const collectRegistryPublication = (
  tx: FinalizeTx,
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  finalProofbodyHash: string,
  env: EntityRuntimeContext,
): { secrets: string[]; transformerAddress: string } => {
  const secrets = tx.data.useOnchainRegistry
    ? collectKnownDisputeSecretsForSnapshot(
        account,
        state,
        counterpartyId,
        finalProofbodyHash,
      )
    : [];
  const transformerAddress = secrets.length > 0
    ? requireAccountDeltaTransformerAddress(env.state, account.state)
    : '';
  if (secrets.length > 0 && !isUsableContractAddress(transformerAddress)) {
    throw new Error('DISPUTE_FINALIZE_MISSING_DELTA_TRANSFORMER_ADDRESS');
  }
  return { secrets, transformerAddress };
};

const isFinalizeTimingAllowed = (
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  env: EntityRuntimeContext,
): boolean => {
  const activeDispute = account.activeDispute!;
  const callerIsLeft = account.state.leftEntity === state.entityId;
  const callerIsStarter = callerIsLeft === activeDispute.startedByLeft;
  if (!callerIsStarter) return true;
  const currentJBlock = getEntityCertifiedJurisdictionHeight(state);
  if (currentJBlock >= activeDispute.disputeTimeout) return true;
  addMessage(
    state,
    `❌ disputeFinalize too early for starter: currentBlock=${currentJBlock}, ` +
    `timeout=${activeDispute.disputeTimeout}`,
  );
  warnDisputeUnlessQuiet(env, 'finalize.too_early', {
    counterparty: shortId(counterpartyId),
    currentJBlock,
    timeout: activeDispute.disputeTimeout,
  });
  return false;
};

const queueDisputeFinalize = (
  state: EntityState,
  account: AccountReplica,
  proof: FinalProofPayload,
  registry: { secrets: string[]; transformerAddress: string },
): void => {
  const batch = state.jBatchState!.batch;
  if (
    batch.disputeFinalizations.length >=
    J_BATCH_CONTRACT_LIMITS.maxDisputeFinalizations
  ) {
    throw new Error(
      `J_BATCH_LIMIT_EXCEEDED: disputeFinalizations ` +
      `${batch.disputeFinalizations.length + 1}/` +
      `${J_BATCH_CONTRACT_LIMITS.maxDisputeFinalizations}`,
    );
  }
  if (batchOpCount(batch) + 1 > J_BATCH_CONTRACT_LIMITS.maxTotalOps) {
    throw new Error(
      `J_BATCH_LIMIT_EXCEEDED: disputeFinalize would exceed total ops ` +
      `${batchOpCount(batch) + 1}/${J_BATCH_CONTRACT_LIMITS.maxTotalOps}`,
    );
  }
  for (const secret of registry.secrets) {
    batchAddRevealSecret(state.jBatchState!, registry.transformerAddress, secret);
  }
  batch.disputeFinalizations.push(proof);
  encodeJBatch(batch);
  account.activeDispute!.finalizeQueued = true;
};

const selectedCrossJurisdictionRecoveryIsReady = (
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  finalProofbodyHash: string,
  outputs: EntityInput[],
): boolean => {
  const active = account.activeDispute!;
  const current = active.crossJurisdictionRecovery;
  if (!current) return true;
  const plan = refreshCrossJurisdictionTargetRecovery(
    state,
    account,
    counterpartyId,
    [finalProofbodyHash],
    current,
    outputs,
  );
  if (!plan) {
    delete active.crossJurisdictionRecovery;
    return true;
  }
  active.crossJurisdictionRecovery = plan.recovery;
  const missing = plan.recovery.requiredPullIds.filter(
    (pullId) => !Object.hasOwn(plan.recovery.resultsByPullId, pullId),
  );
  if (missing.length === 0) return true;
  if (state.crontabState) {
    scheduleHook(state.crontabState, {
      id: `dispute-deadline:${counterpartyId.toLowerCase()}`,
      triggerAt: Number(state.timestamp ?? 0) + 1000,
      type: 'dispute_deadline',
      data: { accountId: counterpartyId },
    });
  }
  addMessage(
    state,
    `⏳ disputeFinalize waiting for ${missing.length} cross-j source result(s) ` +
      `required by the selected proof`,
  );
  return false;
};

export const handleDisputeFinalize = async (
  entityState: EntityState,
  entityTx: FinalizeTx,
  env: EntityRuntimeContext,
  mutableFrameState = false,
): Promise<{ newState: EntityState; outputs: EntityInput[] }> => {
  const counterpartyId = entityTx.data.counterpartyEntityId;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  disputeLog.debug('finalize.begin', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyId),
  });
  const account = admitDisputeFinalize(newState, entityTx);
  if (!account) return { newState, outputs };
  const selection = selectFinalProof(
    entityState,
    newState,
    account,
    counterpartyId,
    env,
  );
  if (!selection) return { newState, outputs };
  if (!selectedCrossJurisdictionRecoveryIsReady(
    newState,
    account,
    counterpartyId,
    selection.finalProofbodyHash,
    outputs,
  )) {
    return { newState, outputs };
  }
  verifyCounterProofIdentity(entityState, account, counterpartyId, selection);
  const finalProof = buildFinalProofPayload(
    newState,
    account,
    counterpartyId,
    selection,
    env,
  );
  const registry = collectRegistryPublication(
    entityTx,
    newState,
    account,
    counterpartyId,
    selection.finalProofbodyHash,
    env,
  );
  disputeLog.debug('finalize.proof_selected', {
    counterparty: shortId(counterpartyId),
    mode: selection.shouldUseCounterProof ? 'counter' : 'unilateral',
    timeout: account.activeDispute!.disputeTimeout,
    initialNonce: finalProof.initialNonce,
    finalNonce: finalProof.finalNonce,
    finalNonceSource: selection.finalNonceSource,
  });
  if (!isFinalizeTimingAllowed(newState, account, counterpartyId, env)) {
    return { newState, outputs };
  }
  queueDisputeFinalize(newState, account, finalProof, registry);
  disputeLog.debug('finalize.jbatch_queued', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyId),
    mode: selection.shouldUseCounterProof ? 'counter' : 'unilateral',
  });
  const description = entityTx.data.description;
  addMessage(
    newState,
    `⚖️ Dispute finalized vs ${counterpartyId.slice(-4)} ${description ? `(${description})` : ''} - use jBroadcast to commit`,
  );
  return { newState, outputs };
};
