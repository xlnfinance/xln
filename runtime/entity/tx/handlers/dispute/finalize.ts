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
import { requireAccountDeltaTransformerAddress } from '../../../../account/consensus/helpers';
import { collectKnownDisputeSecretsForSnapshot } from '../../../dispute-arguments';
import { isUsableContractAddress } from '../../../../jurisdiction/machine/contract-address';
import { shortId } from '../../../../infra/logger';
import { disputeLog, warnDisputeUnlessQuiet } from './shared';
import { admitDisputeFinalize } from './finalize-admission';
import { proofBodyHasPulls } from './start-admission';
import { scheduleHook } from '../../../scheduler';
import {
  countDeferredHashLadderReveals,
  flushDeferredHashLadderReveals,
  refreshCrossJurisdictionTargetRecovery,
} from '../../j-events-htlc';
import {
  buildFinalProofPayload,
  selectFinalProof,
  verifyCounterProofIdentity,
  type FinalProofPayload,
  type FinalProofSelection,
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

/**
 * Timing gate mirrors Account.sol:
 * - no pulls: the non-starter may immediately accept the state selected and
 *   signed by the starter; its fresh outer Hanko makes that mutual consent
 * - the starter has no fresh response from its peer and therefore waits T
 * - pulls present: both wait full T (applyPull reverts PullRevealWindowActive)
 * Role is security authority, not presentation metadata. Never collapse these
 * branches into a generic pull-free fast path.
 */
const resolveFinalizeSubmitNotBefore = (
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  env: EntityRuntimeContext,
  selection: FinalProofSelection,
): number | null | undefined => {
  const activeDispute = account.activeDispute!;
  const timeoutSec = Number(activeDispute.disputeTimeout || 0);
  const nowSec = Math.floor(Number(state.timestamp || 0) / 1000);

  const hasPulls = proofBodyHasPulls(
    selection.finalProofbody,
    requireAccountDeltaTransformerAddress(env.state, account.state),
  );
  if (
    hasPulls
    && selection.shouldUseCounterProof
    && activeDispute.selectedCounterNonce === undefined
  ) {
    addMessage(state, '⏳ Pull counter-proof must be locked on-chain before finalization');
    return undefined;
  }
  const callerIsLeft = account.state.leftEntity === state.entityId;
  const callerIsStarter = callerIsLeft === activeDispute.startedByLeft;
  const hasSelectedCounterProof = activeDispute.selectedCounterNonce !== undefined;
  if (timeoutSec > 0 && nowSec >= timeoutSec) {
    return hasPulls || callerIsStarter || hasSelectedCounterProof ? timeoutSec : null;
  }
  // Once Solidity has selected a registered counter-proof, neither side may
  // execute it before T—even when its ProofBody has no Pulls. The immediate
  // non-starter path below applies only to the starter-selected initial state.
  if (hasSelectedCounterProof) {
    addMessage(state, `❌ selected counter-proof cannot finalize before timeout: nowSec=${nowSec}, timeoutSec=${timeoutSec}`);
    return undefined;
  }
  if (!hasPulls) {
    if (!callerIsStarter) return null;
  }

  addMessage(
    state,
    `❌ disputeFinalize too early: nowSec=${nowSec}, timeoutSec=${timeoutSec}` +
      `${hasPulls ? ', pulls=yes' : ', starter-unilateral'}`,
  );
  warnDisputeUnlessQuiet(env, 'finalize.too_early', {
    counterparty: shortId(counterpartyId),
    nowSec,
    timeoutSec,
    hasPulls,
  });
  return undefined;
};

const queueDisputeFinalize = (
  state: EntityState,
  account: AccountReplica,
  proof: FinalProofPayload,
  registry: { secrets: string[]; transformerAddress: string },
  submitNotBeforeTimestamp: number | null,
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
  batch.disputeFinalizations.push({
    ...proof,
    ...(submitNotBeforeTimestamp === null ? {} : { submitNotBeforeTimestamp }),
  });
  encodeJBatch(batch);
  account.activeDispute!.finalizeQueued = true;
};

const selectedCrossJurisdictionRecoveryIsReady = (
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
  finalProofbodyHash: string,
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
  const timeoutSec = Number(active.disputeTimeout || 0);
  const nowSec = Math.floor(Number(state.timestamp || 0) / 1000);
  // One canonical clock: the signed Target slot remains writable until the
  // local on-chain disputeTimeout. Before it, missing ports wait; at/after it,
  // DeltaTransformer deterministically reads the latest target slot or zero.
  if (timeoutSec > 0 && nowSec >= timeoutSec) return true;
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
      `required by the selected proof (nowSec=${nowSec}, timeoutSec=${timeoutSec})`,
  );
  return false;
};

/** Flush pending hash-ladder reveals before disputeFinalize can enter jBatch. */
const deferFinalizeForPendingReveals = (
  state: EntityState,
  outputs: EntityInput[],
  counterpartyId: string,
  account: AccountReplica,
): boolean => {
  // Pull every mutable witness into the draft before deciding. A sent batch is
  // immutable, so its deferred witnesses remain counted and keep finalization
  // out of the draft until the acknowledgement releases them.
  flushDeferredHashLadderReveals(state);
  const pendingReveals =
    (state.jBatchState?.batch.hashLadderRegistrations.length ?? 0)
    + countDeferredHashLadderReveals(state);
  if (pendingReveals <= 0) return false;
  const firstValidator = state.config.validators?.[0];
  if (firstValidator) {
    outputs.push({
      entityId: state.entityId,
      signerId: firstValidator,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    });
  }
  if (state.crontabState) {
    const timeoutSec = Number(account.activeDispute!.disputeTimeout || 0);
    const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : Number(state.timestamp ?? 0) + 1000;
    scheduleHook(state.crontabState, {
      id: `dispute-deadline:${counterpartyId.toLowerCase()}`,
      triggerAt: Math.min(Number(state.timestamp ?? 0) + 1000, timeoutMs),
      type: 'dispute_deadline',
      data: { accountId: counterpartyId },
    });
  }
  addMessage(
    state,
    `⏳ disputeFinalize deferred: ${pendingReveals} hashLadderReveal(s) must broadcast first`,
  );
  return true;
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
  const submitNotBeforeTimestamp = resolveFinalizeSubmitNotBefore(
    newState,
    account,
    counterpartyId,
    env,
    selection,
  );
  if (submitNotBeforeTimestamp === undefined) {
    return { newState, outputs };
  }
  // F3: never co-batch hash-ladder reveals with finalize. A chain tip still
  // before disputeTimeout reverts PullRevealWindowActive and drops the reveal
  // with the finalize in the same processBatch. Flush reveals via j_broadcast.
  if (deferFinalizeForPendingReveals(newState, outputs, counterpartyId, account)) {
    return { newState, outputs };
  }
  queueDisputeFinalize(
    newState,
    account,
    finalProof,
    registry,
    submitNotBeforeTimestamp,
  );
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
