import type {
  AccountMachine,
  EntityInput,
  EntityState,
  EntityTx,
  Env,
} from '../../../../types';
import { addMessage, cloneEntityState } from '../../../../state-helpers';
import {
  batchAddRevealSecret,
  encodeJBatch,
  getBatchSize,
  J_BATCH_CONTRACT_LIMITS,
} from '../../../../jurisdiction/batch';
import { getEntityCertifiedJurisdictionHeight } from '../../../../jurisdiction/height';
import { requireAccountDeltaTransformerAddress } from '../../../../account/consensus/helpers';
import { collectKnownDisputeSecretsForSnapshot } from '../../../../protocol/dispute/arguments';
import { isUsableContractAddress } from '../../../../jurisdiction/contract-address';
import { shortId } from '../../../../infra/logger';
import { disputeLog, warnDisputeUnlessQuiet } from './shared';
import { admitDisputeFinalize } from './finalize-admission';
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
  account: AccountMachine,
  counterpartyId: string,
  finalProofbodyHash: string,
  env: Env,
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
    ? requireAccountDeltaTransformerAddress(env, account)
    : '';
  if (secrets.length > 0 && !isUsableContractAddress(transformerAddress)) {
    throw new Error('DISPUTE_FINALIZE_MISSING_DELTA_TRANSFORMER_ADDRESS');
  }
  return { secrets, transformerAddress };
};

const isFinalizeTimingAllowed = (
  state: EntityState,
  account: AccountMachine,
  counterpartyId: string,
  selection: FinalProofSelection,
  env: Env,
): boolean => {
  const activeDispute = account.activeDispute!;
  const callerIsLeft = account.leftEntity === state.entityId;
  const callerIsStarter = callerIsLeft === activeDispute.startedByLeft;
  if (selection.shouldUseCounterProof || !callerIsStarter) return true;
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
  account: AccountMachine,
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
  if (getBatchSize(batch) + 1 > J_BATCH_CONTRACT_LIMITS.maxTotalOps) {
    throw new Error(
      `J_BATCH_LIMIT_EXCEEDED: disputeFinalize would exceed total ops ` +
      `${getBatchSize(batch) + 1}/${J_BATCH_CONTRACT_LIMITS.maxTotalOps}`,
    );
  }
  for (const secret of registry.secrets) {
    batchAddRevealSecret(state.jBatchState!, registry.transformerAddress, secret);
  }
  batch.disputeFinalizations.push(proof);
  encodeJBatch(batch);
  account.activeDispute!.finalizeQueued = true;
};

export const handleDisputeFinalize = async (
  entityState: EntityState,
  entityTx: FinalizeTx,
  env: Env,
): Promise<{ newState: EntityState; outputs: EntityInput[] }> => {
  const counterpartyId = entityTx.data.counterpartyEntityId;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  disputeLog.debug('finalize.begin', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyId),
    cooperativeRequested: entityTx.data.cooperative === true,
  });
  const account = admitDisputeFinalize(newState, entityTx, env);
  if (!account) return { newState, outputs };
  const selection = selectFinalProof(
    entityState,
    newState,
    account,
    counterpartyId,
    env,
  );
  if (!selection) return { newState, outputs };
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
  if (!isFinalizeTimingAllowed(newState, account, counterpartyId, selection, env)) {
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
