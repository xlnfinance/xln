import type {
  AccountMachine,
  EntityInput,
  EntityState,
  EntityTx,
  Env,
} from '../../../../types';
import type { ProofBodyStruct } from '../../../../../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { addMessage, cloneEntityState } from '../../../../state-helpers';
import {
  assertDisputeArgumentsWithinContractLimits,
  assertDisputeProofBodyWithinContractLimits,
  batchAddRevealSecret,
  encodeJBatch,
  getBatchSize,
  initJBatch,
  J_BATCH_CONTRACT_LIMITS,
} from '../../../../jurisdiction/batch';
import { getEntityCertifiedJurisdictionHeight } from '../../../../jurisdiction/height';
import {
  createDisputeProofHashWithNonce,
  hashProofBodyStruct,
} from '../../../../protocol/dispute/proof-builder';
import {
  buildAccountProofBodyFromEnv,
  requireAccountDeltaTransformerAddress,
} from '../../../../account/consensus/helpers';
import {
  buildDisputeArgumentsForSnapshot,
  collectKnownDisputeSecretsForSnapshot,
  type DisputeArgumentSide,
} from '../../../../protocol/dispute/arguments';
import { isUsableContractAddress } from '../../../../jurisdiction/contract-address';
import { shortHash, shortId } from '../../../../infra/logger';
import { freezeAccountForDispute } from '../../../../account/consensus/dispute-policy';
import {
  canonicalizeProofBodyStruct,
  collectDisputeEvidenceReadinessIssues,
  disputeLog,
  hasQueuedDisputeFinalize,
  isProofBodyStruct,
  reportOptionalArgumentWarnings,
  resolveDepositoryHankoDomain,
  warnDisputeUnlessQuiet,
} from './shared';

type FinalizeTx = Extract<EntityTx, { type: 'disputeFinalize' }>;

type FinalProofSelection = {
  finalNonce: number;
  finalNonceSource: string;
  finalizeSig: string;
  finalProofbody: ProofBodyStruct;
  finalProofbodyHash: string;
  shouldUseCounterProof: boolean;
  callerSide: DisputeArgumentSide;
};

type FinalProofPayload = {
  counterentity: string;
  initialNonce: number;
  finalNonce: number;
  initialProofbodyHash: string;
  finalProofbody: ProofBodyStruct;
  starterArguments: string;
  otherArguments: string;
  sig: string;
  startedByLeft: boolean;
  cooperative: false;
};

const admitDisputeFinalize = (
  state: EntityState,
  tx: FinalizeTx,
  env: Env,
): AccountMachine | null => {
  const counterpartyId = tx.data.counterpartyEntityId;
  state.jBatchState ??= initJBatch();
  if (state.jBatchState.sentBatch) {
    addMessage(
      state,
      `ℹ️ disputeFinalize queued to current batch while sentBatch nonce=${state.jBatchState.sentBatch.entityNonce} is still pending`,
    );
  }
  const account = state.accounts.get(counterpartyId);
  if (!account) {
    addMessage(state, `❌ No account with ${counterpartyId.slice(-4)} - cannot finalize dispute`);
    return null;
  }
  if (!account.activeDispute) {
    addMessage(
      state,
      `❌ No active dispute with ${counterpartyId.slice(-4)} - must call disputeStart first`,
    );
    return null;
  }
  if (account.activeDispute.observedOnChain !== true) {
    addMessage(
      state,
      `⏳ disputeFinalize blocked until DisputeStarted is observed on-chain for ${counterpartyId.slice(-4)}`,
    );
    return null;
  }
  if (account.activeDispute.finalizeQueued) {
    addMessage(
      state,
      `ℹ️ disputeFinalize already queued for ${counterpartyId.slice(-4)} (awaiting batch lifecycle)`,
    );
    return null;
  }
  if (hasQueuedDisputeFinalize(state, counterpartyId)) {
    account.activeDispute.finalizeQueued = true;
    addMessage(
      state,
      `ℹ️ disputeFinalize already present in batch lifecycle for ${counterpartyId.slice(-4)}`,
    );
    return null;
  }
  if (tx.data.cooperative === true) {
    addMessage(
      state,
      `❌ disputeFinalize cooperative=true rejected for ${counterpartyId.slice(-4)} (unilateral-only protocol)`,
    );
    warnDisputeUnlessQuiet(env, 'finalize.cooperative_rejected', {
      counterparty: shortId(counterpartyId),
    });
    return null;
  }
  freezeAccountForDispute(account, true);
  const readinessIssues = collectDisputeEvidenceReadinessIssues(
    account,
    Number(state.timestamp ?? 0),
  );
  if (readinessIssues.length > 0) {
    addMessage(
      state,
      `⏳ disputeFinalize blocked until evidence is stable for ${counterpartyId.slice(-4)}: ${readinessIssues.join('; ')}`,
    );
    return null;
  }
  return account;
};

const selectFinalProof = (
  sourceState: EntityState,
  state: EntityState,
  account: AccountMachine,
  counterpartyId: string,
  env: Env,
): FinalProofSelection | null => {
  const activeDispute = account.activeDispute!;
  const currentProof = buildAccountProofBodyFromEnv(env, account);
  const counterHash = account.counterpartyDisputeProofBodyHash;
  const counterNonce = account.counterpartyDisputeProofNonce;
  const counterHanko = account.counterpartyDisputeProofHanko;
  const counterBodyRaw = counterHash
    ? account.disputeProofBodiesByHash?.[counterHash]
    : undefined;
  const hasCounterProof =
    Boolean(counterHanko && counterHanko !== '0x') &&
    counterNonce !== undefined &&
    counterNonce > activeDispute.initialNonce &&
    Boolean(counterHash) &&
    isProofBodyStruct(counterBodyRaw);
  const finalNonce = hasCounterProof ? counterNonce! : activeDispute.initialNonce;
  const finalNonceSource = hasCounterProof
    ? 'counterpartyDisputeProof'
    : 'initialNonce (unilateral)';
  if (finalNonce <= 0) {
    addMessage(state, `❌ Invalid dispute finalNonce=${finalNonce} — must be > 0`);
    disputeLog.error('finalize.nonce_invalid', {
      counterparty: shortId(counterpartyId),
      finalNonce,
      finalNonceSource,
    });
    return null;
  }
  const storedBodyRaw = activeDispute.initialProofbodyHash
    ? account.disputeProofBodiesByHash?.[activeDispute.initialProofbodyHash]
    : undefined;
  const currentBody = canonicalizeProofBodyStruct(
    currentProof.proofBodyStruct,
    sourceState.entityId,
    counterpartyId,
    'current',
  );
  const storedBody = isProofBodyStruct(storedBodyRaw)
    ? canonicalizeProofBodyStruct(storedBodyRaw, sourceState.entityId, counterpartyId, 'stored')
    : null;
  const counterBody = hasCounterProof
    ? canonicalizeProofBodyStruct(
        counterBodyRaw as ProofBodyStruct,
        sourceState.entityId,
        counterpartyId,
        'counter',
      )
    : null;
  const shouldUseCounterProof = counterBody !== null && counterHash !== undefined;
  if (!shouldUseCounterProof && currentProof.proofBodyHash !== activeDispute.initialProofbodyHash) {
    disputeLog.warn('finalize.proof_body_hash_mismatch', {
      counterparty: shortId(counterpartyId),
      current: shortHash(currentProof.proofBodyHash),
      initial: shortHash(activeDispute.initialProofbodyHash),
    });
    if (!storedBody) {
      throw new Error('disputeFinalize: missing stored proofBody for unilateral finalize');
    }
  }
  const finalProofbody = shouldUseCounterProof
    ? counterBody
    : storedBody ?? currentBody;
  return {
    finalNonce,
    finalNonceSource,
    finalizeSig: hasCounterProof ? counterHanko! : '0x',
    finalProofbody: finalProofbody!,
    finalProofbodyHash: shouldUseCounterProof
      ? counterHash!
      : activeDispute.initialProofbodyHash,
    shouldUseCounterProof,
    callerSide: account.leftEntity === state.entityId ? 'left' : 'right',
  };
};

const verifyCounterProofIdentity = (
  sourceState: EntityState,
  account: AccountMachine,
  counterpartyId: string,
  selection: FinalProofSelection,
): void => {
  if (!selection.shouldUseCounterProof || !account.counterpartyDisputeHash) return;
  const domain = resolveDepositoryHankoDomain(sourceState);
  if (!domain) throw new Error('DISPUTE_COUNTER_FINALIZE_DEPOSITORY_MISSING');
  const expectedHash = createDisputeProofHashWithNonce(
    account,
    selection.finalProofbodyHash,
    domain,
    selection.finalNonce,
  );
  if (account.counterpartyDisputeHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(
      `DISPUTE_COUNTER_FINALIZE_HASH_MISMATCH:${counterpartyId}:` +
      `${account.counterpartyDisputeHash}:${expectedHash}`,
    );
  }
};

const buildFinalProofPayload = (
  state: EntityState,
  account: AccountMachine,
  counterpartyId: string,
  selection: FinalProofSelection,
  env: Env,
): FinalProofPayload => {
  const activeDispute = account.activeDispute!;
  const builtArguments = buildDisputeArgumentsForSnapshot(
    account,
    state,
    counterpartyId,
    selection.finalProofbodyHash,
    { secretsSide: selection.callerSide },
  );
  reportOptionalArgumentWarnings(env, counterpartyId, builtArguments.warnings);
  const starterArguments = selection.shouldUseCounterProof
    ? activeDispute.starterIncrementedArguments
    : activeDispute.starterInitialArguments;
  const otherArguments = activeDispute.startedByLeft
    ? builtArguments.rightArguments
    : builtArguments.leftArguments;
  assertDisputeProofBodyWithinContractLimits(
    selection.finalProofbody,
    'disputeFinalize.final',
  );
  const recomputedHash = hashProofBodyStruct(selection.finalProofbody);
  if (recomputedHash.toLowerCase() !== selection.finalProofbodyHash.toLowerCase()) {
    throw new Error(
      `DISPUTE_FINALIZE_PROOFBODY_HASH_MISMATCH:${counterpartyId}:` +
      `${selection.finalProofbodyHash}:${recomputedHash}`,
    );
  }
  assertDisputeArgumentsWithinContractLimits(
    [starterArguments],
    'disputeFinalize.starterArguments',
  );
  assertDisputeArgumentsWithinContractLimits(
    [otherArguments],
    'disputeFinalize.otherArguments',
  );
  return {
    counterentity: counterpartyId,
    initialNonce: activeDispute.initialNonce,
    finalNonce: selection.finalNonce,
    initialProofbodyHash: activeDispute.initialProofbodyHash,
    finalProofbody: selection.finalProofbody,
    starterArguments,
    otherArguments,
    sig: selection.finalizeSig,
    startedByLeft: activeDispute.startedByLeft,
    cooperative: false,
  };
};

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
