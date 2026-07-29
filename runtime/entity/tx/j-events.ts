import type {
  EntityCandidateEffect,
  AccountState,
  EntityInput,
  EntityState,
  RuntimeState,
  DisputeFinalizationEvidence,
  JurisdictionEvent,
  JurisdictionEventData,
  HashToSign,
} from '../../types';
import type { ProofBodyStruct } from '../../protocol/dispute/proof-body';
import { prepareEntityTxState } from '../state-clone';
import { addMessage } from '../frame-events';
import { hashHtlcSecret } from '../../protocol/htlc/utils';
import { cancelHook, scheduleHook } from '../scheduler';
import { scrubDisputeFinalizationsForCounterparty } from './dispute-finalize-guards';
import {
  getJEventJurisdictionRef,
} from '../../jurisdiction/event-observation';
import { verifyAccountSignature } from '../../account/crypto';
import { hashProofBodyStruct } from '../../protocol/dispute/proof-builder';
import { buildAccountProofBodyFromEnv } from '../../account/consensus/helpers';
import {
  assertDisputeProofBodyWithinContractLimits,
  cloneJBatch,
  isBatchEmpty,
  mergeBatchOps,
} from '../../jurisdiction/batch';
import { canonicalizeProofBodyStruct } from './handlers/dispute';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import {
  applyKnownHtlcSecret,
  decodeDisputeStarterInitialSecrets,
  queueCrossJurisdictionSalvageFromArgumentList,
  queueCrossJurisdictionSalvageFromDispute,
  queueCrossJurisdictionSourceDisputeFromTargetDispute,
} from './j-events-htlc';
import { mergeJEventClaimOps } from './j-events-account';
import type { JEventApplyResult, JEventAccountTx } from './j-events-types';
import { applyHankoBatchProcessedEvent } from './j-events-batch';
import { applyBatchOperationSkippedEvent } from './j-events-batch-skip';
import {
  applyEntityProviderActionCancelled,
  applyEntityProviderActionExecuted,
} from './j-events-entity-provider-action';
import { freezeAccountForDispute, isDisputeStartedByLeft } from '../../account/consensus/dispute-policy';
import {
  foldJHistoryRoot,
} from '../../jurisdiction/history-consensus';
import {
  finalizedJHistoryRoot,
  pruneCertifiedJHistory,
  reconcileJEventRangeWithFinalizedState,
  type ReconciledJEventRange,
} from '../../jurisdiction/local-history';
import { assertEntityFrameJRangeBudget } from '../../jurisdiction/range-budget';
import { getEntityLeaderState } from '../consensus/leader';
import {
  advanceCertifiedBoardFinality,
} from '../../jurisdiction/board-registry';
import { validateJEventRangeEnvelope } from '../../jurisdiction/j-event-range-validation';
import { applyAccountInput } from '../../account/consensus';
import { createAccountDisputeFinalityInput } from '../../account/input';
import { applyCertifiedBoardJEvent } from './j-events-board';
import { applyAccountSettledJEvent } from './j-events-account-settled';
import {
  applyDebtJEvent,
  applyExternalWalletJEvent,
  applyReserveUpdatedJEvent,
  applySecretRevealedJEvent,
} from './j-events-observations';

const jEventLog = createStructuredLogger('j.event');
const normalizeSignerId = (value: unknown): string => String(value || '').trim().toLowerCase();
const MAX_SAFE_NONCE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Solidity exposes dispute nonces as uint256 while AccountState deliberately
 * uses JavaScript safe integers. Convert through BigInt so an adversarial
 * value can never round to a different nonce before consensus compares it.
 */
const decodeAccountNonce = (value: unknown, code: string): number => {
  let nonce: bigint;
  try {
    if (typeof value === 'bigint') {
      nonce = value;
    } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
      nonce = BigInt(value);
    } else if (typeof value === 'string' && /^\d+$/.test(value)) {
      nonce = BigInt(value);
    } else {
      throw new Error('invalid');
    }
  } catch {
    throw new Error(`${code}:${String(value)}`);
  }
  if (nonce < 0n || nonce > MAX_SAFE_NONCE) {
    throw new Error(`${code}:${String(value)}`);
  }
  return Number(nonce);
};

const incrementAccountNonce = (nonce: number, code: string): number => {
  if (nonce >= Number.MAX_SAFE_INTEGER) throw new Error(`${code}:${nonce}`);
  return nonce + 1;
};

const invalidateSettlementIntentAfterDisputeFinality = (
  state: EntityState,
  counterpartyId: string,
  accountResult: NonNullable<
    Awaited<ReturnType<typeof applyAccountInput>>['externalFinality']
  >,
): void => {
  const removedDeferred = state.deferredAccountProposals?.delete(counterpartyId) ?? false;
  if (
    accountResult.hadSettlementWorkspace ||
    removedDeferred ||
    accountResult.removedSettlementTxs > 0
  ) {
    addMessage(
      state,
      `🧹 Invalidated stale settlement intent after dispute finality with ${counterpartyId.slice(-4)}`,
    );
  }
};

const syncJBatchEntityNonceFromEvent = (
  state: EntityState,
  eventEntityId: string,
  localEntityId: string,
  batchNonce: number | undefined,
): void => {
  if (String(eventEntityId || '').toLowerCase() !== String(localEntityId || '').toLowerCase()) return;
  if (batchNonce === undefined || batchNonce <= 0 || !state.jBatchState) return;
  const current = state.jBatchState.entityNonce || 0;
  if (batchNonce > current) {
    state.jBatchState.entityNonce = batchNonce;
    addMessage(state, `↻ Synced J batch nonce from event (${current} → ${batchNonce})`);
  }
};

const retireSentBatchInvalidatedByDisputeFinality = (
  state: EntityState,
  counterpartyId: string,
): number => {
  const jBatchState = state.jBatchState;
  const sentBatch = jBatchState?.sentBatch;
  if (!jBatchState || !sentBatch) return 0;
  const remainingBatch = cloneJBatch(sentBatch.batch);
  const removed = scrubDisputeFinalizationsForCounterparty(remainingBatch, counterpartyId);
  if (removed === 0) return 0;

  mergeBatchOps(jBatchState.batch, remainingBatch);
  delete jBatchState.sentBatch;
  jBatchState.status = isBatchEmpty(jBatchState.batch) ? 'empty' : 'accumulating';
  return removed;
};

type AppliedJRange = {
  state: EntityState;
  accountTxs: JEventAccountTx[];
  outputs: EntityInput[];
  hashesToSign: HashToSign[];
  dirtyAccounts: Set<string>;
  certifiedPrefixRoot: string;
};

const applyJRangeBlocks = async (
  entityState: EntityState,
  range: Extract<ReconciledJEventRange, { kind: 'suffix' }>,
  jurisdictionRef: string,
  signerId: string,
  signature: string,
  env: RuntimeState,
  candidateEffects: EntityCandidateEffect[],
  mutableFrameState: boolean,
): Promise<AppliedJRange> => {
  let state = prepareEntityTxState(entityState, mutableFrameState);
  const applied: AppliedJRange = {
    state,
    accountTxs: [],
    outputs: [],
    hashesToSign: [],
    dirtyAccounts: new Set(),
    certifiedPrefixRoot: finalizedJHistoryRoot(entityState),
  };
  for (const block of range.blocks) {
    applied.certifiedPrefixRoot = foldJHistoryRoot(applied.certifiedPrefixRoot, [{
      jurisdictionRef,
      jHeight: block.blockNumber,
      jBlockHash: block.blockHash,
      eventsHash: block.eventsHash,
      ...(block.disputeFinalizationEvidenceHash
        ? { disputeFinalizationEvidenceHash: block.disputeFinalizationEvidenceHash }
        : {}),
    }]);
    state.jBlockChain.push({
      jurisdictionRef,
      jHeight: block.blockNumber,
      jBlockHash: block.blockHash,
      eventsHash: block.eventsHash,
      ...(block.disputeFinalizationEvidenceHash
        ? { disputeFinalizationEvidenceHash: block.disputeFinalizationEvidenceHash }
        : {}),
      events: block.events,
      finalizedAt: state.timestamp,
      proposerSignerId: signerId,
      proposerSignature: signature,
    });
    state.lastFinalizedJHeight = block.blockNumber;
    for (const event of block.events) {
      const result = await applyFinalizedJEvent(
        state,
        event,
        env,
        block.disputeFinalizationEvidence ?? [],
        candidateEffects,
        true,
      );
      state = applied.state = result.newState;
      applied.accountTxs.push(...result.accountTxs);
      applied.outputs.push(...result.outputs);
      if (result.hashesToSign) applied.hashesToSign.push(...result.hashesToSign);
      for (const accountId of result.dirtyAccounts) applied.dirtyAccounts.add(accountId);
      if (!state.jBlockChain.some(entry => entry.jHeight === block.blockNumber)) {
        throw new Error(`j_event invariant: finalized block ${block.blockNumber} lost during apply`);
      }
    }
  }
  return applied;
};

const commitJRangeFinality = (
  entityState: EntityState,
  state: EntityState,
  range: Extract<ReconciledJEventRange, { kind: 'suffix' }>,
  jurisdictionRef: string,
  signerId: string,
  signature: string,
): EntityState => {
  state.lastFinalizedJHeight = range.scannedThroughHeight;
  state.jHistoryFinality = {
    jurisdictionRef,
    baseHeight: range.baseHeight,
    finalizedThroughHeight: range.scannedThroughHeight,
    tipBlockHash: range.tipBlockHash,
    eventHistoryRoot: range.eventHistoryRoot,
    proposerSignerId: signerId,
    proposerSignature: signature,
    entityHeight: entityState.height + 1,
  };
  const jurisdiction = state.config.jurisdiction;
  if (!jurisdiction) throw new Error('CERTIFIED_BOARD_ENTITY_JURISDICTION_MISSING');
  state.certifiedBoardState = advanceCertifiedBoardFinality(
    state.certifiedBoardState,
    jurisdiction,
    range.scannedThroughHeight,
    range.tipBlockHash,
    range.eventHistoryRoot,
  );
  state.jBlockChain.sort((left, right) => left.jHeight - right.jHeight);
  return pruneCertifiedJHistory(state);
};

export const applyJEvent = async (
  entityState: EntityState,
  data: JurisdictionEventData,
  env: RuntimeState,
  candidateEffects: EntityCandidateEffect[] = [],
  mutableFrameState = false,
): Promise<JEventApplyResult> => {
  const activeProposerId = normalizeSignerId(getEntityLeaderState(entityState).activeValidatorId);
  // Reject unauthorized senders before canonicalizing attacker-controlled bytes.
  // Active proposers still pass the exact same aggregate frame budget below.
  assertEntityFrameJRangeBudget([{ type: 'j_event', data }]);
  const expectedJurisdictionRef = getJEventJurisdictionRef(entityState.config.jurisdiction);
  const validated = validateJEventRangeEnvelope({
    entityId: entityState.entityId,
    expectedJurisdictionRef,
    activeProposerId,
    data,
    verifySignature: (signerId, digest, signature) =>
      verifyAccountSignature(env, signerId, digest, signature),
  });
  if (!validated.ok) {
    if (validated.code === 'J_RANGE_PROPOSER_SIGNATURE_INVALID') {
      throw new Error(`j_event rejected: invalid proposer signature for ${normalizeSignerId(data.from)}`);
    }
    throw new Error(`j_event rejected: ${validated.code}`);
  }
  const { signerId, jurisdictionRef, data: canonicalData } = validated.range;
  const { signature } = canonicalData;
  // Authenticate before classifying a fully stale delivery as a no-op. The
  // current Entity head is sufficient: already-applied linked-list history is
  // never replayed or consulted as authority.
  const reconciled = reconcileJEventRangeWithFinalizedState(entityState, canonicalData);

  if (reconciled.kind === 'noop') {
    return { newState: entityState, accountTxs: [], outputs: [], dirtyAccounts: [] };
  }
  const applied = await applyJRangeBlocks(
    entityState,
    reconciled,
    jurisdictionRef,
    signerId,
    signature,
    env,
    candidateEffects,
    mutableFrameState,
  );
  if (applied.certifiedPrefixRoot !== reconciled.eventHistoryRoot) {
    throw new Error(
      `J_HISTORY_FINALITY_ROOT_CORRUPTION:` +
      `expected=${applied.certifiedPrefixRoot}:certified=${reconciled.eventHistoryRoot}`,
    );
  }
  const state = commitJRangeFinality(
    entityState,
    applied.state,
    reconciled,
    jurisdictionRef,
    signerId,
    signature,
  );
  mergeJEventClaimOps(applied.accountTxs);
  jEventLog.info('history.finalized_by_entity', {
    range: `${reconciled.baseHeight + 1}-${reconciled.scannedThroughHeight}`,
    eventBlocks: reconciled.blocks.length,
    root: shortHash(reconciled.eventHistoryRoot),
    proposer: shortId(signerId),
  });
  return {
    newState: state,
    accountTxs: applied.accountTxs,
    outputs: applied.outputs,
    dirtyAccounts: [...applied.dirtyAccounts],
    ...(applied.hashesToSign.length > 0 ? { hashesToSign: applied.hashesToSign } : {}),
  };
};

export type FinalizedJEventContext = {
  entityState: EntityState;
  newState: EntityState;
  event: JurisdictionEvent;
  env: RuntimeState;
  blockNumber: number;
  transactionHash: string;
  accountTxs: JEventAccountTx[];
  outputs: EntityInput[];
  dirtyAccounts: Set<string>;
};

type DisputeAccountContext = {
  senderStr: string;
  counterentityStr: string;
  entityIdNorm: string;
  candidateCounterpartyId: string;
  counterpartyId: string;
  account: AccountState | undefined;
};

const normalizeEntityId = (id: unknown): string => String(id).toLowerCase();

function resolveDisputeAccountContext(
  state: EntityState,
  sender: string,
  counterentity: string,
): DisputeAccountContext {
  const senderStr = normalizeEntityId(sender);
  const counterentityStr = normalizeEntityId(counterentity);
  const entityIdNorm = normalizeEntityId(state.entityId);
  const candidateCounterpartyId = senderStr === entityIdNorm ? counterentityStr : senderStr;
  let counterpartyId = candidateCounterpartyId;
  let account = state.accounts.get(counterpartyId);
  if (!account) {
    for (const [key, value] of state.accounts.entries()) {
      if (normalizeEntityId(key) === candidateCounterpartyId) {
        counterpartyId = key;
        account = value;
        break;
      }
    }
  }
  return {
    senderStr,
    counterentityStr,
    entityIdNorm,
    candidateCounterpartyId,
    counterpartyId,
    account,
  };
}

const normalizeFinalProofbodyHash = (value: unknown, counterpartyId: string): string => {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`J_EVENT_DISPUTE_FINAL_PROOFBODY_HASH_INVALID:${counterpartyId}:${hash || 'missing'}`);
  }
  return hash;
};

const requireFinalizedProofBodyEvidence = (
  account: AccountState,
  finalProofbodyHashRaw: unknown,
  counterpartyId: string,
): { finalProofbodyHash: string; proofbody: ProofBodyStruct; tokenIds: number[] } => {
  const finalProofbodyHash = normalizeFinalProofbodyHash(finalProofbodyHashRaw, counterpartyId);
  const matches = Object.entries(account.disputeProofBodiesByHash ?? {})
    .filter(([proofbodyHash]) => proofbodyHash.toLowerCase() === finalProofbodyHash);
  if (matches.length === 0) {
    throw new Error(`J_EVENT_DISPUTE_FINAL_PROOFBODY_MISSING:${counterpartyId}:${finalProofbodyHash}`);
  }
  if (matches.length !== 1) {
    throw new Error(`J_EVENT_DISPUTE_FINAL_PROOFBODY_AMBIGUOUS:${counterpartyId}:${finalProofbodyHash}`);
  }
  let proofbody: ProofBodyStruct;
  let computedHash: string;
  try {
    proofbody = canonicalizeProofBodyStruct(
      matches[0]![1] as ProofBodyStruct,
      account.leftEntity,
      account.rightEntity,
      'jEvent.disputeFinalized',
    );
    assertDisputeProofBodyWithinContractLimits(proofbody, 'jEvent.disputeFinalized');
    computedHash = hashProofBodyStruct(proofbody).toLowerCase();
  } catch (error) {
    if (error instanceof Error && (
      error.message.startsWith('J_DISPUTE_PROOFBODY_') ||
      error.message.startsWith('DISPUTE_FINALIZE_PROOFBODY_')
    )) {
      throw error;
    }
    throw new Error(
      `J_EVENT_DISPUTE_FINAL_PROOFBODY_INVALID:${counterpartyId}:${finalProofbodyHash}`,
      { cause: error },
    );
  }
  if (computedHash !== finalProofbodyHash) {
    throw new Error(
      `J_EVENT_DISPUTE_FINAL_PROOFBODY_HASH_MISMATCH:${counterpartyId}:${finalProofbodyHash}:${computedHash}`,
    );
  }
  const tokenIds = proofbody.tokenIds.map((value, index) => {
    const tokenId = Number(BigInt(value));
    if (!Number.isSafeInteger(tokenId) || tokenId < 0) {
      throw new Error(`J_EVENT_DISPUTE_FINAL_TOKEN_ID_INVALID:${counterpartyId}:${index}:${String(value)}`);
    }
    return tokenId;
  });
  return { finalProofbodyHash, proofbody, tokenIds };
};

type DisputeStartedEventData = {
  sender: string;
  counterentity: string;
  nonce: string;
  proofbodyHash: string;
  starterInitialArguments: string;
  starterIncrementedArguments: string;
  watchSeed?: unknown;
  batchNonce?: number;
  disputeTimeout?: number;
  jNonce?: unknown;
};

type StartedDispute = {
  counterpartyId: string;
  senderStr: string;
  entityIdNorm: string;
  weAreStarter: boolean;
  starterInitialArguments: string;
  disputeTimeout: number;
};

const initializeStartedDispute = (
  context: FinalizedJEventContext,
  data: DisputeStartedEventData,
): StartedDispute | null => {
  const { newState, env, blockNumber, dirtyAccounts } = context;
  const { sender, counterentity, nonce, proofbodyHash } = data;
  const {
    senderStr,
    entityIdNorm,
    candidateCounterpartyId,
    counterpartyId,
    account,
  } = resolveDisputeAccountContext(newState, sender, counterentity);
  if (!account) {
    jEventLog.warn('dispute_started.account_missing', { account: shortId(candidateCounterpartyId), entity: shortId(entityIdNorm) });
    return null;
  }

  const weAreStarter = senderStr === entityIdNorm;
  const disputeTimeout = Number(data.disputeTimeout);
  if (!Number.isSafeInteger(disputeTimeout) || disputeTimeout <= Number(blockNumber || 0)) {
    throw new Error(
      `J_EVENT_DISPUTE_TIMEOUT_INVALID:block=${String(blockNumber)}:timeout=${String(data.disputeTimeout)}`,
    );
  }
  const initialNonce = decodeAccountNonce(nonce, 'J_EVENT_DISPUTE_NONCE_INVALID');
  const jNonce = decodeAccountNonce(
    data.jNonce ?? nonce,
    'J_EVENT_DISPUTE_J_NONCE_INVALID',
  );

  syncJBatchEntityNonceFromEvent(newState, senderStr, entityIdNorm, data.batchNonce);
  dirtyAccounts.add(counterpartyId.toLowerCase());
  account.status = 'disputed';
  freezeAccountForDispute(account, true);

  // Unified nonce: initialNonce = the nonce used in disputeStart (from event).
  // jNonce defaults to the dispute nonce when no richer event payload exists.
  account.activeDispute = {
    startedByLeft: isDisputeStartedByLeft(senderStr, account.leftEntity, account.rightEntity),
    initialProofbodyHash: String(proofbodyHash),
    initialNonce,
    disputeTimeout,
    jNonce,
    starterInitialArguments: data.starterInitialArguments || '0x',
    starterIncrementedArguments: data.starterIncrementedArguments || '0x',
    observedOnChain: true,
    observedBlockNumber: Number(blockNumber || 0),
    ...(data.batchNonce !== undefined ? { batchNonce: data.batchNonce } : {}),
    finalizeQueued: false,
  };
  account.jNonce = Math.max(account.jNonce, jNonce);

  const localProof = buildAccountProofBodyFromEnv(env, account);
  const onChainProofHash = String(account.activeDispute.initialProofbodyHash || '').toLowerCase();
  const storedProofKnown = Object.keys(account.disputeProofBodiesByHash ?? {})
    .some((hash) => hash.toLowerCase() === onChainProofHash);
  if (localProof.proofBodyHash.toLowerCase() !== onChainProofHash) {
    jEventLog.debug('dispute.proof_hash_not_current', {
      counterparty: shortId(counterpartyId),
      local: shortHash(localProof.proofBodyHash),
      onChain: shortHash(account.activeDispute.initialProofbodyHash),
      storedProofKnown,
    });
  }
  return {
    counterpartyId,
    senderStr,
    entityIdNorm,
    weAreStarter,
    starterInitialArguments: data.starterInitialArguments || '0x',
    disputeTimeout,
  };
};

const applyStartedDisputeFollowups = (
  context: FinalizedJEventContext,
  dispute: StartedDispute,
): void => {
  const {
    newState,
    env,
    blockNumber,
    accountTxs,
    outputs,
  } = context;
  const {
    counterpartyId,
    weAreStarter,
    starterInitialArguments,
    disputeTimeout,
  } = dispute;
  const disputeSecrets = decodeDisputeStarterInitialSecrets(starterInitialArguments);
  for (const disputeSecret of disputeSecrets) {
    const hashlock = hashHtlcSecret(disputeSecret);
    applyKnownHtlcSecret(
      env,
      newState,
      accountTxs,
      outputs,
      hashlock,
      disputeSecret,
      blockNumber,
      'DisputeStarted',
    );
  }
  queueCrossJurisdictionSalvageFromDispute(
    env,
    newState,
    outputs,
    counterpartyId,
    starterInitialArguments,
    blockNumber,
  );
  queueCrossJurisdictionSourceDisputeFromTargetDispute(
    env,
    newState,
    outputs,
    counterpartyId,
    starterInitialArguments,
  );

  addMessage(
    newState,
    `⚔️ DISPUTE ${weAreStarter ? 'STARTED' : 'vs us'} with ` +
      `${counterpartyId.slice(-4)}, timeout: block ${disputeTimeout}`,
  );
  if (!newState.crontabState) return;
  const kickoffDelayMs = weAreStarter ? 1 : 5000;
  const timestamp = Number(newState.timestamp);
  const logicalTimestamp = Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0;
  scheduleHook(newState.crontabState, {
    id: `dispute-deadline:${counterpartyId.toLowerCase()}`,
    triggerAt: logicalTimestamp + kickoffDelayMs,
    type: 'dispute_deadline',
    data: { accountId: counterpartyId },
  });
};

async function applyDisputeStartedJEvent(context: FinalizedJEventContext): Promise<void> {
  const data = context.event.data as DisputeStartedEventData;
  const dispute = initializeStartedDispute(context, data);
  if (dispute) applyStartedDisputeFollowups(context, dispute);
}

type DisputeFinalizedEventData = {
  sender: string;
  counterentity: string;
  initialNonce: string;
  initialProofbodyHash: string;
  finalProofbodyHash: string;
  batchNonce?: number;
};

const resolveFinalizationEvidence = (
  account: AccountState,
  data: DisputeFinalizedEventData,
  senderStr: string,
  counterentityStr: string,
  finalProofbodyHash: string,
  evidenceList: DisputeFinalizationEvidence[],
): {
  evidence: DisputeFinalizationEvidence[];
  finalizedJNonce: number;
  initialNonce: number;
} => {
  const evidence = evidenceList.filter((item) =>
    normalizeEntityId(item.sender) === senderStr &&
    normalizeEntityId(item.counterentity) === counterentityStr &&
    String(item.initialNonce) === String(data.initialNonce) &&
    String(item.initialProofbodyHash).toLowerCase() ===
      data.initialProofbodyHash.toLowerCase() &&
    String(item.finalProofbodyHash).toLowerCase() === finalProofbodyHash.toLowerCase()
  );
  if (evidence.length > 1) {
    throw new Error(
      `J_EVENT_DISPUTE_FINALIZATION_EVIDENCE_AMBIGUOUS:` +
      `${senderStr}:${counterentityStr}:${String(data.initialNonce)}`,
    );
  }
  const primary = evidence[0];
  const initialNonce = decodeAccountNonce(
    data.initialNonce,
    'J_EVENT_DISPUTE_INITIAL_NONCE_INVALID',
  );
  const evidenceSig = String(primary?.sig ?? '').toLowerCase();
  const evidenceIsUnsignedUnilateral = evidenceSig === '' || evidenceSig === '0x';
  const finalProofMatchesInitial =
    finalProofbodyHash.toLowerCase() === String(data.initialProofbodyHash || '').toLowerCase();
  let eventJNonce = initialNonce;
  if (primary) {
    eventJNonce = evidenceIsUnsignedUnilateral
      ? incrementAccountNonce(initialNonce, 'J_EVENT_DISPUTE_FINAL_NONCE_OVERFLOW')
      : decodeAccountNonce(
          primary.finalNonce,
          'J_EVENT_DISPUTE_FINAL_NONCE_INVALID',
        );
  } else if (finalProofMatchesInitial) {
    eventJNonce = incrementAccountNonce(
      initialNonce,
      'J_EVENT_DISPUTE_FINAL_NONCE_OVERFLOW',
    );
  }
  return {
    evidence,
    finalizedJNonce: Math.max(Number(account.jNonce ?? 0), eventJNonce),
    initialNonce,
  };
};

const retireFinalizedDisputeState = (
  context: FinalizedJEventContext,
  counterpartyId: string,
  candidateCounterpartyId: string,
  senderStr: string,
  entityIdNorm: string,
  evidence: DisputeFinalizationEvidence[],
): void => {
  const { newState, env, blockNumber, outputs } = context;
  const weAreFinalizer = senderStr === entityIdNorm;
  const removedDraft = scrubDisputeFinalizationsForCounterparty(
    newState.jBatchState?.batch,
    candidateCounterpartyId,
  );
  const removedSent = weAreFinalizer
    ? 0
    : retireSentBatchInvalidatedByDisputeFinality(newState, candidateCounterpartyId);
  const removed = removedDraft + removedSent;
  jEventLog.info('dispute_finalized.applied', {
    entity: shortId(entityIdNorm),
    counterparty: shortId(counterpartyId),
    sender: shortId(senderStr),
    block: Number(blockNumber || 0),
    removedDraft,
    removedSent,
  });
  if (removed > 0) {
    addMessage(
      newState,
      `🧹 Removed ${removed} stale dispute-finalize op(s) for ${counterpartyId.slice(-4)}`,
    );
  }
  const argumentBlobs = evidence.flatMap((item) => [
    item.leftArguments,
    item.rightArguments,
  ]);
  if (argumentBlobs.length > 0) {
    queueCrossJurisdictionSalvageFromArgumentList(
      env,
      newState,
      outputs,
      counterpartyId,
      argumentBlobs,
      blockNumber,
    );
  }
};

async function applyDisputeFinalizedJEvent(
  context: FinalizedJEventContext,
  disputeFinalizationEvidence: DisputeFinalizationEvidence[],
): Promise<void> {
  const { env, newState, event, dirtyAccounts } = context;
  const data = event.data as DisputeFinalizedEventData;
  const accountContext = resolveDisputeAccountContext(
    newState,
    data.sender,
    data.counterentity,
  );
  const {
    senderStr,
    counterentityStr,
    entityIdNorm,
    candidateCounterpartyId,
    counterpartyId,
    account,
  } = accountContext;
  if (!account) {
    jEventLog.warn('dispute_finalized.account_missing', {
      account: shortId(candidateCounterpartyId),
      entity: shortId(entityIdNorm),
    });
    return;
  }
  // Depository settles only tokenIds from this exact locally signed body.
  const finalizedProof = requireFinalizedProofBodyEvidence(
    account,
    data.finalProofbodyHash,
    counterpartyId,
  );
  const resolved = resolveFinalizationEvidence(
    account,
    data,
    senderStr,
    counterentityStr,
    finalizedProof.finalProofbodyHash,
    disputeFinalizationEvidence,
  );
  syncJBatchEntityNonceFromEvent(newState, senderStr, entityIdNorm, data.batchNonce);
  dirtyAccounts.add(counterpartyId.toLowerCase());
  // A finalized dispute changes the authoritative Account epoch. Any
  // settlement drafted or sealed against the previous epoch is unusable even
  // when its numeric nonce is higher; retaining it would strand holds or let a
  // delayed retry resurrect pre-dispute state.
  const accountInput = createAccountDisputeFinalityInput(
    account,
    entityIdNorm,
    resolved.finalizedJNonce,
    finalizedProof.tokenIds,
  );
  const accountInputResult = await applyAccountInput(env, account, accountInput);
  if (!accountInputResult.success || !accountInputResult.externalFinality) {
    throw new Error(
      `ACCOUNT_DISPUTE_FINALITY_INPUT_FAILED:${counterpartyId}:` +
      `${accountInputResult.error ?? 'RESULT_MISSING'}`,
    );
  }
  const accountFinality = accountInputResult.externalFinality;
  invalidateSettlementIntentAfterDisputeFinality(newState, counterpartyId, accountFinality);
  if (accountFinality.hadActiveDispute) {
    addMessage(
      newState,
      `✅ DISPUTE FINALIZED with ${counterpartyId.slice(-4)} ` +
      `(nonce ${resolved.initialNonce})`,
    );
    if (newState.crontabState) {
      cancelHook(newState.crontabState, `dispute-deadline:${counterpartyId.toLowerCase()}`);
    }
  } else {
    jEventLog.warn('dispute_finalized.no_active_dispute', { counterparty: shortId(counterpartyId) });
  }
  retireFinalizedDisputeState(
    context,
    counterpartyId,
    candidateCounterpartyId,
    senderStr,
    entityIdNorm,
    resolved.evidence,
  );
}

async function applyFinalizedJEvent(
  entityState: EntityState,
  event: JurisdictionEvent,
  env: RuntimeState,
  disputeFinalizationEvidence: DisputeFinalizationEvidence[] = [],
  candidateEffects: EntityCandidateEffect[] = [],
  mutableFrameState = false,
): Promise<JEventApplyResult> {
  const blockNumber = event.blockNumber ?? 0;
  const transactionHash = event.transactionHash || 'unknown';
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const accountTxs: JEventAccountTx[] = [];
  const outputs: EntityInput[] = [];
  const hashesToSign: HashToSign[] = [];
  const dirtyAccounts = new Set<string>();
  const done = (): JEventApplyResult => ({
    newState,
    accountTxs,
    outputs,
    dirtyAccounts: Array.from(dirtyAccounts),
    ...(hashesToSign.length > 0 ? { hashesToSign } : {}),
  });
  const context: FinalizedJEventContext = {
    entityState,
    newState,
    event,
    env,
    blockNumber,
    transactionHash,
    accountTxs,
    outputs,
    dirtyAccounts,
  };

  switch (event.type) {
    case 'FoundationBootstrapped':
    case 'EntityRegistered':
    case 'BoardActivated':
      applyCertifiedBoardJEvent(context);
      break;
    case 'ReserveUpdated':
      applyReserveUpdatedJEvent(context);
      break;
    case 'ExternalWalletSnapshot':
    case 'ExternalWalletDelta':
      applyExternalWalletJEvent(context);
      break;
    case 'SecretRevealed':
      applySecretRevealedJEvent(context);
      break;
    case 'AccountSettled':
      applyAccountSettledJEvent(context, candidateEffects);
      break;
    case 'DebtCreated':
    case 'DebtEnforced':
    case 'DebtForgiven':
      applyDebtJEvent(context);
      break;
    case 'DisputeStarted':
      await applyDisputeStartedJEvent(context);
      break;
    case 'DisputeFinalized':
      await applyDisputeFinalizedJEvent(context, disputeFinalizationEvidence);
      break;
    case 'BatchOperationSkipped':
      applyBatchOperationSkippedEvent(newState, event);
      break;
    case 'HankoBatchProcessed':
      await applyHankoBatchProcessedEvent({
        newState,
        event,
        blockNumber,
        outputs,
      });
      break;
    case 'EntityProviderActionExecuted':
      applyEntityProviderActionExecuted(newState, event.data, blockNumber);
      break;
    case 'EntityProviderActionCancelled':
      applyEntityProviderActionCancelled(newState, event.data, blockNumber);
      break;
    default: {
      const unhandledEvent: never = event;
      throw new Error(
        `FINALIZED_J_EVENT_HANDLER_MISSING:${String(unhandledEvent)}`,
      );
    }
  }

  return done();
}
