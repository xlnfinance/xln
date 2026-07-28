import type {
  EntityCandidateEffect,
  AccountMachine,
  EntityInput,
  EntityState,
  Env,
  DisputeFinalizationEvidence,
  JurisdictionEvent,
  JurisdictionEventData,
  HashToSign,
} from '../../types';
import type { ProofBodyStruct } from '../../protocol/dispute/proof-body';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { CANONICAL_J_EVENTS } from '../../jadapter/helpers';
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
import type { JEventApplyResult, JEventMempoolOp } from './j-events-types';
import { appendBatchHistory, emptyOpBreakdown } from './j-events-history';
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
} from '../../jurisdiction/local-history';
import { assertEntityFrameJRangeBudget } from '../../jurisdiction/range-budget';
import { getEntityLeaderState } from '../consensus/leader';
import {
  advanceCertifiedBoardFinality,
} from '../../jurisdiction/board-registry';
import { clearFinalizedSettlementWorkspace } from '../../account/tx/handlers/settle-transition';
import { validateJEventRangeEnvelope } from '../../jurisdiction/j-event-range-validation';
import { invalidateAccountMapCommitment } from '../../account/map-commitment';
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

const invalidateSettlementIntentAfterDisputeFinality = (
  state: EntityState,
  account: AccountMachine,
  counterpartyId: string,
): void => {
  const hadWorkspace = Boolean(account.settlementWorkspace);
  if (hadWorkspace) clearFinalizedSettlementWorkspace(account);
  const beforeMempool = account.mempool.length;
  account.mempool = account.mempool.filter((tx) => tx.type !== 'settle_transition');
  const removedDeferred = state.deferredAccountProposals?.delete(counterpartyId) ?? false;
  const removedMempool = beforeMempool - account.mempool.length;
  if (hadWorkspace || removedDeferred || removedMempool > 0) {
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
  batchNonce: unknown,
): void => {
  if (String(eventEntityId || '').toLowerCase() !== String(localEntityId || '').toLowerCase()) return;
  const nonce = Number(batchNonce);
  if (!Number.isFinite(nonce) || nonce <= 0 || !state.jBatchState) return;
  const current = Number(state.jBatchState.entityNonce || 0);
  if (nonce > current) {
    state.jBatchState.entityNonce = nonce;
    addMessage(state, `↻ Synced J batch nonce from event (${current} → ${nonce})`);
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

export const applyJEvent = async (
  entityState: EntityState,
  data: JurisdictionEventData,
  env: Env,
  candidateEffects: EntityCandidateEffect[] = [],
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
  const { scannedThroughHeight, tipBlockHash, signature } = canonicalData;
  // Authenticate before classifying a fully stale delivery as a no-op. The
  // current Entity head is sufficient: already-applied linked-list history is
  // never replayed or consulted as authority.
  const reconciled = reconcileJEventRangeWithFinalizedState(entityState, canonicalData);

  if (reconciled.kind === 'noop') {
    return { newState: entityState, mempoolOps: [], outputs: [], dirtyAccounts: [] };
  }
  const eventHistoryRoot = reconciled.eventHistoryRoot;

  let state = cloneEntityState(entityState);
  const mempoolOps: JEventMempoolOp[] = [];
  const outputs: EntityInput[] = [];
  const hashesToSign: HashToSign[] = [];
  const dirtyAccounts = new Set<string>();
  let certifiedPrefixRoot = finalizedJHistoryRoot(entityState);
  for (const block of reconciled.blocks) {
    certifiedPrefixRoot = foldJHistoryRoot(certifiedPrefixRoot, [{
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
      );
      state = result.newState;
      mempoolOps.push(...result.mempoolOps);
      outputs.push(...result.outputs);
      if (result.hashesToSign) hashesToSign.push(...result.hashesToSign);
      for (const accountId of result.dirtyAccounts) dirtyAccounts.add(accountId);
      if (!state.jBlockChain.some((entry) => entry.jHeight === block.blockNumber)) {
        throw new Error(`j_event invariant: finalized block ${block.blockNumber} lost during apply`);
      }
    }
  }

  if (certifiedPrefixRoot !== eventHistoryRoot) {
    throw new Error(
      `J_HISTORY_FINALITY_ROOT_CORRUPTION:expected=${certifiedPrefixRoot}:certified=${eventHistoryRoot}`,
    );
  }

  state.lastFinalizedJHeight = scannedThroughHeight;
  state.jHistoryFinality = {
    jurisdictionRef,
    baseHeight: reconciled.baseHeight,
    finalizedThroughHeight: scannedThroughHeight,
    tipBlockHash,
    eventHistoryRoot,
    proposerSignerId: signerId,
    proposerSignature: signature,
    entityHeight: entityState.height + 1,
  };
  const jurisdiction = state.config.jurisdiction;
  if (!jurisdiction) throw new Error('CERTIFIED_BOARD_ENTITY_JURISDICTION_MISSING');
  state.certifiedBoardState = advanceCertifiedBoardFinality(
    state.certifiedBoardState,
    jurisdiction,
    scannedThroughHeight,
    tipBlockHash,
    eventHistoryRoot,
  );
  state.jBlockChain.sort((left, right) => left.jHeight - right.jHeight);
  state = pruneCertifiedJHistory(state);
  mergeJEventClaimOps(mempoolOps);
  jEventLog.info('history.finalized_by_entity', {
    range: `${reconciled.baseHeight + 1}-${scannedThroughHeight}`,
    eventBlocks: reconciled.blocks.length,
    root: shortHash(eventHistoryRoot),
    proposer: shortId(signerId),
  });
  return {
    newState: state,
    mempoolOps,
    outputs,
    dirtyAccounts: [...dirtyAccounts],
    ...(hashesToSign.length > 0 ? { hashesToSign } : {}),
  };
};

export type FinalizedJEventContext = {
  entityState: EntityState;
  newState: EntityState;
  event: JurisdictionEvent;
  env: Env;
  blockNumber: number;
  transactionHash: string;
  mempoolOps: JEventMempoolOp[];
  outputs: EntityInput[];
  dirtyAccounts: Set<string>;
};

type DisputeAccountContext = {
  senderStr: string;
  counterentityStr: string;
  entityIdNorm: string;
  candidateCounterpartyId: string;
  counterpartyId: string;
  account: AccountMachine | undefined;
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
  account: AccountMachine,
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

const clearDisputeSettledDeltas = (
  account: AccountMachine,
  finalizedTokenIds: readonly number[],
): void => {
  for (const tokenId of finalizedTokenIds) {
    const delta = account.deltas.get(tokenId);
    if (!delta) continue;
    const changed = delta.collateral !== 0n || delta.ondelta !== 0n || delta.offdelta !== 0n ||
      delta.leftHold !== 0n || delta.rightHold !== 0n ||
      delta.leftAllowance !== 0n || delta.rightAllowance !== 0n;
    delta.collateral = 0n;
    delta.ondelta = 0n;
    delta.offdelta = 0n;
    delta.leftHold = 0n;
    delta.rightHold = 0n;
    delta.leftAllowance = 0n;
    delta.rightAllowance = 0n;
    if (changed) invalidateAccountMapCommitment(account, 'deltas', tokenId);
  }
};

const retireDisputeEvidenceEpoch = (account: AccountMachine): void => {
  delete account.disputeProofBodiesByHash;
  delete account.disputeProofNoncesByHash;
  delete account.disputeArgumentSnapshotsByHash;
};

async function applyDisputeStartedJEvent(context: FinalizedJEventContext): Promise<void> {
  const { newState, event, env, blockNumber, transactionHash, mempoolOps, outputs, dirtyAccounts } = context;
  const data = event.data as {
    sender: string;
    counterentity: string;
    nonce: string;
    proofbodyHash: string;
    starterInitialArguments: string;
    starterIncrementedArguments: string;
    watchSeed?: unknown;
    batchNonce?: number;
    disputeTimeout?: unknown;
    jNonce?: unknown;
  };
  const { sender, counterentity, nonce, proofbodyHash } = data;
  const {
    senderStr,
    entityIdNorm,
    candidateCounterpartyId,
    counterpartyId,
    account,
  } = resolveDisputeAccountContext(newState, sender, counterentity);
  syncJBatchEntityNonceFromEvent(newState, senderStr, entityIdNorm, data.batchNonce);

  if (!account) {
    jEventLog.warn('dispute_started.account_missing', { account: shortId(candidateCounterpartyId), entity: shortId(entityIdNorm) });
    return;
  }

  dirtyAccounts.add(counterpartyId.toLowerCase());
  account.status = 'disputed';
  freezeAccountForDispute(account, true);
  const weAreStarter = senderStr === entityIdNorm;
  const disputeTimeout = Number(data.disputeTimeout);
  if (!Number.isSafeInteger(disputeTimeout) || disputeTimeout <= Number(blockNumber || 0)) {
    throw new Error(
      `J_EVENT_DISPUTE_TIMEOUT_INVALID:block=${String(blockNumber)}:timeout=${String(data.disputeTimeout)}`,
    );
  }
  const jNonce = Number(data.jNonce ?? nonce);

  // Unified nonce: initialNonce = the nonce used in disputeStart (from event).
  // jNonce defaults to the dispute nonce when no richer event payload exists.
  account.activeDispute = {
    startedByLeft: isDisputeStartedByLeft(senderStr, account.leftEntity, account.rightEntity),
    initialProofbodyHash: String(proofbodyHash),
    initialNonce: Number(nonce),
    disputeTimeout,
    jNonce,
    starterInitialArguments: data.starterInitialArguments || '0x',
    starterIncrementedArguments: data.starterIncrementedArguments || '0x',
    observedOnChain: true,
    observedBlockNumber: Number(blockNumber || 0),
    ...(data.batchNonce !== undefined ? { batchNonce: Number(data.batchNonce) } : {}),
    finalizeQueued: false,
  };
  account.jNonce = Math.max(Number(account.jNonce ?? 0), jNonce);

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

  const starterInitialArguments = data.starterInitialArguments || '0x';
  const disputeSecrets = decodeDisputeStarterInitialSecrets(starterInitialArguments);
  if (disputeSecrets.length > 0) {
    for (const disputeSecret of disputeSecrets) {
      const hashlock = hashHtlcSecret(disputeSecret);
      applyKnownHtlcSecret(env, newState, mempoolOps, outputs, hashlock, disputeSecret, blockNumber, 'DisputeStarted');
    }
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

  addMessage(newState, `⚔️ DISPUTE ${weAreStarter ? 'STARTED' : 'vs us'} with ${counterpartyId.slice(-4)}, timeout: block ${account.activeDispute.disputeTimeout}`);
  if (!weAreStarter) {
    const ops = emptyOpBreakdown();
    ops.disputeStarts = 1;
    appendBatchHistory(newState, {
      batchHash: `event:dispute-start:${String(proofbodyHash).slice(0, 12)}`,
      txHash: transactionHash || '',
      status: 'confirmed' as const,
      broadcastedAt: newState.timestamp,
      confirmedAt: newState.timestamp,
      opCount: 1,
      entityNonce: Number(nonce || 0),
      jBlockNumber: Number(blockNumber || 0),
      operations: ops,
      source: 'counterparty-event' as const,
      eventType: 'DisputeStarted' as const,
      note: `Counterparty ${senderStr.slice(-4)} started dispute`,
    });
  }

  if (newState.crontabState) {
    const kickoffDelayMs = weAreStarter ? 1 : 5000;
    const logicalTimestamp =
      Number.isFinite(Number(newState.timestamp)) && Number(newState.timestamp) >= 0
        ? Number(newState.timestamp)
        : 0;
    scheduleHook(newState.crontabState, {
      id: `dispute-deadline:${counterpartyId.toLowerCase()}`,
      triggerAt: logicalTimestamp + kickoffDelayMs,
      type: 'dispute_deadline',
      data: { accountId: counterpartyId },
    });
  }
}

function applyDisputeFinalizedJEvent(
  context: FinalizedJEventContext,
  disputeFinalizationEvidence: DisputeFinalizationEvidence[],
): void {
  const { newState, event, env, blockNumber, transactionHash, outputs, dirtyAccounts } = context;
  const data = event.data as { sender: string; counterentity: string; initialNonce: string; initialProofbodyHash: string; finalProofbodyHash: string; batchNonce?: number };
  const { sender, counterentity, initialNonce, initialProofbodyHash } = data;
  const {
    senderStr,
    counterentityStr,
    entityIdNorm,
    candidateCounterpartyId,
    counterpartyId,
    account,
  } = resolveDisputeAccountContext(newState, sender, counterentity);

  if (!account) {
    jEventLog.warn('dispute_finalized.account_missing', { account: shortId(candidateCounterpartyId), entity: shortId(entityIdNorm) });
    return;
  }

  // Resolve and verify the exact locally signed ProofBody before touching any
  // account/J-batch state. The event carries only its hash; treating missing or
  // corrupt evidence as "clear everything" would diverge from Depository,
  // which settles only the tokenIds in this exact body.
  const finalizedProof = requireFinalizedProofBodyEvidence(
    account,
    data.finalProofbodyHash,
    counterpartyId,
  );
  const finalProofbodyHash = finalizedProof.finalProofbodyHash;
  syncJBatchEntityNonceFromEvent(newState, senderStr, entityIdNorm, data.batchNonce);
  dirtyAccounts.add(counterpartyId.toLowerCase());
  const weAreFinalizer = senderStr === entityIdNorm;
  const finalizationEvidence = disputeFinalizationEvidence.filter((evidence) =>
    normalizeEntityId(evidence.sender) === senderStr &&
    normalizeEntityId(evidence.counterentity) === counterentityStr &&
    String(evidence.initialNonce) === String(initialNonce) &&
    String(evidence.initialProofbodyHash).toLowerCase() === String(initialProofbodyHash).toLowerCase() &&
    String(evidence.finalProofbodyHash).toLowerCase() === finalProofbodyHash.toLowerCase()
  );
  if (finalizationEvidence.length > 1) {
    throw new Error(
      `J_EVENT_DISPUTE_FINALIZATION_EVIDENCE_AMBIGUOUS:${senderStr}:${counterentityStr}:${String(initialNonce)}`,
    );
  }
  const primaryFinalizationEvidence = finalizationEvidence[0];
  const initialNonceNumber = Number(initialNonce || 0);
  const evidenceFinalNonce = Number(primaryFinalizationEvidence?.finalNonce ?? NaN);
  const evidenceSig = String(primaryFinalizationEvidence?.sig ?? '').toLowerCase();
  const evidenceIsUnsignedUnilateral = evidenceSig === '' || evidenceSig === '0x';
  const finalProofMatchesInitial =
    finalProofbodyHash.toLowerCase() === String(initialProofbodyHash || '').toLowerCase();
  const eventJNonce = primaryFinalizationEvidence
    ? evidenceIsUnsignedUnilateral
      ? initialNonceNumber + 1
      : Number.isFinite(evidenceFinalNonce)
        ? evidenceFinalNonce
        : initialNonceNumber
    : finalProofMatchesInitial
      ? initialNonceNumber + 1
      : initialNonceNumber;
  const finalizedJNonce = Math.max(
    Number(account.jNonce ?? 0),
    eventJNonce,
  );
  // A finalized dispute changes the authoritative Account epoch. Any
  // settlement drafted or sealed against the previous epoch is unusable even
  // when its numeric nonce is higher; retaining it would strand holds or let a
  // delayed retry resurrect pre-dispute state.
  invalidateSettlementIntentAfterDisputeFinality(newState, account, counterpartyId);
  account.jNonce = finalizedJNonce;
  if (account.activeDispute) {
    delete account.activeDispute;
    addMessage(newState, `✅ DISPUTE FINALIZED with ${counterpartyId.slice(-4)} (nonce ${Number(initialNonce)})`);
    if (newState.crontabState) {
      cancelHook(newState.crontabState, `dispute-deadline:${counterpartyId.toLowerCase()}`);
    }
  } else {
    jEventLog.warn('dispute_finalized.no_active_dispute', { counterparty: shortId(counterpartyId) });
  }
  if (account.proofHeader.nextProofNonce <= finalizedJNonce) {
    account.proofHeader.nextProofNonce = finalizedJNonce + 1;
  }
  account.status = 'disputed';
  freezeAccountForDispute(account, false);
  delete account.counterpartyDisputeProofHanko;
  delete account.counterpartyDisputeProofNonce;
  delete account.counterpartyDisputeProofBodyHash;
  if (!weAreFinalizer) {
    const ops = emptyOpBreakdown();
    ops.disputeFinalizations = 1;
    appendBatchHistory(newState, {
      batchHash: `event:dispute-finalize:${String(initialProofbodyHash).slice(0, 12)}`,
      txHash: transactionHash || '',
      status: 'confirmed' as const,
      broadcastedAt: newState.timestamp,
      confirmedAt: newState.timestamp,
      opCount: 1,
      entityNonce: Number(initialNonce || 0),
      jBlockNumber: Number(blockNumber || 0),
      operations: ops,
      source: 'counterparty-event' as const,
      eventType: 'DisputeFinalized' as const,
      note: `Counterparty ${senderStr.slice(-4)} finalized dispute`,
    });
  }

  // Counterparty finality proves that any sealed local batch carrying the same
  // dispute finalization can no longer execute. Self-finality is different:
  // HankoBatchProcessed from the same block still owns exact batch confirmation.
  // Keep the immutable payload untouched and requeue only valid remaining ops.
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
    addMessage(newState, `🧹 Removed ${removed} stale dispute-finalize op(s) for ${counterpartyId.slice(-4)}`);
  }

  const finalizationArgumentBlobs = finalizationEvidence.flatMap((evidence) => [
    evidence.leftArguments,
    evidence.rightArguments,
  ]);
  if (finalizationArgumentBlobs.length > 0) {
    queueCrossJurisdictionSalvageFromArgumentList(
      env,
      newState,
      outputs,
      counterpartyId,
      finalizationArgumentBlobs,
      blockNumber,
    );
  }

  clearDisputeSettledDeltas(account, finalizedProof.tokenIds);

  // Drop off-chain intents from pre-dispute epoch.
  if (account.swapOffers.size > 0) {
    account.swapOffers.clear();
    invalidateAccountMapCommitment(account, 'swapOffers');
  }
  if (account.locks.size > 0) {
    account.locks.clear();
    invalidateAccountMapCommitment(account, 'locks');
  }
  // Keep exact bodies/snapshots alive through salvage and token cleanup above,
  // then retire the whole consumed epoch. A later bilateral frame can create a
  // fresh bounded epoch without carrying historical proof evidence forever.
  retireDisputeEvidenceEpoch(account);
}

async function applyFinalizedJEvent(
  entityState: EntityState,
  event: JurisdictionEvent,
  env: Env,
  disputeFinalizationEvidence: DisputeFinalizationEvidence[] = [],
  candidateEffects: EntityCandidateEffect[] = [],
): Promise<JEventApplyResult> {
  const blockNumber = event.blockNumber ?? 0;
  const transactionHash = event.transactionHash || 'unknown';
  const newState = cloneEntityState(entityState);
  const mempoolOps: JEventMempoolOp[] = [];
  const outputs: EntityInput[] = [];
  const hashesToSign: HashToSign[] = [];
  const dirtyAccounts = new Set<string>();
  const done = (): JEventApplyResult => ({
    newState,
    mempoolOps,
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
    mempoolOps,
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
      applyDisputeFinalizedJEvent(context, disputeFinalizationEvidence);
      break;
    case 'BatchOperationSkipped':
      applyBatchOperationSkippedEvent(newState, event);
      break;
    case 'HankoBatchProcessed':
      await applyHankoBatchProcessedEvent({
        newState,
        event,
        transactionHash,
        blockNumber,
        dirtyAccounts,
        outputs,
      });
      break;
    case 'EntityProviderActionExecuted':
      applyEntityProviderActionExecuted(newState, event.data, blockNumber);
      break;
    case 'EntityProviderActionCancelled':
      applyEntityProviderActionCancelled(newState, event.data, blockNumber);
      break;
    default:
      addMessage(newState, `⚠️ Unknown j-event: ${event.type} | Block ${blockNumber}`);
      jEventLog.warn('unknown_event', { type: event.type, canonical: CANONICAL_J_EVENTS });
  }

  return done();
}
