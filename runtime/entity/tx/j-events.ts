import type {
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
import { getTokenInfo } from '../../account/utils';
import { CANONICAL_J_EVENTS } from '../../jadapter/helpers';
import { hashHtlcSecret } from '../../protocol/htlc/utils';
import { scheduleHook as scheduleCrontabHook, cancelHook as cancelCrontabHook } from '../scheduler';
import { scrubDisputeFinalizationsForCounterparty } from './dispute-finalize-guards';
import { normalizeJurisdictionEvents } from '../../jurisdiction/event-normalization';
import {
  getJEventJurisdictionRef,
} from '../../jurisdiction/event-observation';
import { verifyAccountSignature } from '../../account/crypto';
import { markStorageEntityDirty } from '../../machine/env-events';
import { hashProofBodyStruct } from '../../protocol/dispute/proof-builder';
import { buildAccountProofBodyFromEnv } from '../../account/consensus/helpers';
import { assertDisputeProofBodyWithinContractLimits } from '../../jurisdiction/batch';
import { canonicalizeProofBodyStruct } from './handlers/dispute';
import { applyDebtCreated, applyDebtEnforced, applyDebtForgiven } from './j-events-debt';
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
import {
  applyEntityProviderActionCancelled,
  applyEntityProviderActionExecuted,
} from './j-events-entity-provider-action';
import { isDisputeStartedByLeft } from '../../account/consensus/dispute-policy';
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
  applySignerEntityExternalWalletDelta,
  applySignerEntityExternalWalletSnapshot,
} from '../signer-wallet';
import {
  advanceCertifiedBoardFinality,
  applyCertifiedBoardRegistryEvent,
  cacheCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardRecord,
} from '../../jurisdiction/board-registry';
import { clearFinalizedSettlementWorkspace } from '../../account/tx/handlers/settle-transition';
import {
  BOARD_RESEAL_HOOK_ID,
  markBoardRotationResealsPending,
} from './board-rotation-reseal';
import { validateJEventRangeEnvelope } from '../../jurisdiction/j-event-range-validation';

const jEventLog = createStructuredLogger('j.event');
const normalizeSignerId = (value: unknown): string => String(value || '').trim().toLowerCase();

const getTokenSymbol = (tokenId: number): string => getTokenInfo(tokenId).symbol;
const getTokenDecimals = (tokenId: number): number => getTokenInfo(tokenId).decimals;

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

export const applyJEvent = async (
  entityState: EntityState,
  data: JurisdictionEventData,
  env: Env,
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

type FinalizedJEventContext = {
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
    delta.collateral = 0n;
    delta.ondelta = 0n;
    delta.offdelta = 0n;
    delta.leftHold = 0n;
    delta.rightHold = 0n;
    delta.leftAllowance = 0n;
    delta.rightAllowance = 0n;
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
    scheduleCrontabHook(newState.crontabState, {
      id: `dispute-deadline:${counterpartyId.toLowerCase()}`,
      triggerAt: logicalTimestamp + kickoffDelayMs,
      type: 'dispute_deadline',
      data: { accountId: counterpartyId },
    });
    markStorageEntityDirty(env, newState.entityId);
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
      cancelCrontabHook(newState.crontabState, `dispute-deadline:${counterpartyId.toLowerCase()}`);
      markStorageEntityDirty(env, newState.entityId);
    }
  } else {
    jEventLog.warn('dispute_finalized.no_active_dispute', { counterparty: shortId(counterpartyId) });
  }
  if (account.proofHeader.nextProofNonce <= finalizedJNonce) {
    account.proofHeader.nextProofNonce = finalizedJNonce + 1;
  }
  account.status = 'disputed';
  delete account.pendingFrame;
  delete account.pendingAccountInput;
  delete account.pendingAccountInputSignerId;
  delete account.clonedForValidation;
  account.rollbackCount = 0;
  delete account.lastRollbackFrameHash;
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

  // Drop stale local draft dispute-finalize ops for this account. If the dispute
  // is already finalized on-chain, re-broadcasting it can revert a future batch.
  const removedDraft = scrubDisputeFinalizationsForCounterparty(
    newState.jBatchState?.batch,
    candidateCounterpartyId,
  );
  const removedSent = scrubDisputeFinalizationsForCounterparty(
    newState.jBatchState?.sentBatch?.batch,
    candidateCounterpartyId,
  );
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
  }
  if (account.locks.size > 0) {
    account.locks.clear();
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
): Promise<JEventApplyResult> {
  const blockNumber = event.blockNumber ?? 0;
  const transactionHash = event.transactionHash || 'unknown';
  const txHashShort = transactionHash.slice(0, 10) + '...';

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

  if (
    event.type === 'FoundationBootstrapped' ||
    event.type === 'EntityRegistered' ||
    event.type === 'BoardActivated'
  ) {
    const jurisdiction = newState.config.jurisdiction;
    if (!jurisdiction) throw new Error('CERTIFIED_BOARD_ENTITY_JURISDICTION_MISSING');
    const applied = applyCertifiedBoardRegistryEvent(
      newState.certifiedBoardState,
      getCertifiedBoardNodeStore(env),
      jurisdiction,
      event,
    );
    cacheCertifiedBoardNodes(env, applied.newNodes);
    newState.certifiedBoardState = applied.state;
    addMessage(newState, `🔐 BOARD AUTHORITY: ${event.type} | Block ${blockNumber}`);
    if (event.type === 'BoardActivated') {
      const pending = newState.entityProviderActionState?.pending;
      if (event.data.entityId.toLowerCase() === newState.entityId.toLowerCase() && pending) {
        const certifiedBoard = resolveObserverCertifiedBoardRecord(
          newState,
          getCertifiedBoardNodeStore(env),
          newState.entityId,
        );
        if (!certifiedBoard) throw new Error(`ENTITY_PROVIDER_ACTION_CERTIFIED_BOARD_MISSING:${newState.entityId}`);
        const certifiedEpoch = BigInt(certifiedBoard.boardEpoch);
        if (pending.boardEpoch > certifiedEpoch) {
          throw new Error(
            `ENTITY_PROVIDER_ACTION_PENDING_BOARD_EPOCH_AHEAD:` +
            `${pending.boardEpoch.toString()}:${certifiedEpoch.toString()}`,
          );
        }
        if (pending.boardEpoch < certifiedEpoch) {
          delete newState.entityProviderActionState!.pending;
          addMessage(newState, '🛑 Pending EntityProvider action expired at board activation');
        }
      }
      const reseal = markBoardRotationResealsPending(newState, event);
      for (const accountId of reseal.dirtyAccounts) dirtyAccounts.add(accountId);
      if (event.data.entityId.toLowerCase() === newState.entityId.toLowerCase()) {
        if (reseal.dirtyAccounts.length > 0) {
          if (!newState.crontabState) throw new Error('BOARD_RESEAL_CRONTAB_MISSING');
          scheduleCrontabHook(newState.crontabState, {
            id: BOARD_RESEAL_HOOK_ID,
            triggerAt: newState.timestamp,
            type: 'board_reseal',
            data: {
              activationJHeight: reseal.activation.jHeight,
              activationLogIndex: reseal.activation.logIndex,
              afterCounterpartyId: '',
            },
          });
        } else if (newState.crontabState) {
          cancelCrontabHook(newState.crontabState, BOARD_RESEAL_HOOK_ID);
        }
      }
    }

  } else if (event.type === 'ReserveUpdated') {
    const { entity, tokenId, newBalance } = event.data;
    const tokenIdNum = Number(tokenId);
    const tokenSymbol = getTokenSymbol(tokenIdNum);
    const decimals = getTokenDecimals(tokenIdNum);
    const balanceDisplay = (Number(newBalance) / (10 ** decimals)).toFixed(4);

    if (String(entity).toLowerCase() === String(entityState.entityId).toLowerCase()) {
      newState.reserves.set(tokenIdNum, BigInt(newBalance as string | number | bigint));
    }

    addMessage(newState, `📊 RESERVE: ${tokenSymbol} = ${balanceDisplay} | Block ${blockNumber} | Tx ${txHashShort}`);

  } else if (event.type === 'ExternalWalletSnapshot') {
    const { entityId } = event.data;
    if (String(entityId).toLowerCase() !== String(entityState.entityId).toLowerCase()) {
      return done();
    }
    const normalizedOwner = applySignerEntityExternalWalletSnapshot(newState, event, blockNumber, transactionHash);

    addMessage(newState, `💼 EXTERNAL: ${normalizedOwner.slice(0, 10)} snapshot | Block ${blockNumber} | Tx ${txHashShort}`);

  } else if (event.type === 'ExternalWalletDelta') {
    const { entityId } = event.data;
    if (String(entityId).toLowerCase() !== String(entityState.entityId).toLowerCase()) {
      return done();
    }
    const normalizedOwner = applySignerEntityExternalWalletDelta(newState, event, blockNumber, transactionHash);

    addMessage(newState, `💼 EXTERNAL: ${normalizedOwner.slice(0, 10)} delta | Block ${blockNumber} | Tx ${txHashShort}`);

  } else if (event.type === 'SecretRevealed') {
    const { hashlock, secret } = event.data;
    applyKnownHtlcSecret(env, newState, mempoolOps, outputs, String(hashlock), String(secret), blockNumber, 'SecretRevealed');

  } else if (event.type === 'AccountSettled') {
    const { leftEntity, rightEntity, tokenId, leftReserve, rightReserve, collateral } = event.data;
    const tokenIdNum = Number(tokenId);
    const myEntityId = String(entityState.entityId).toLowerCase();
    const leftId = String(leftEntity).toLowerCase();
    const rightId = String(rightEntity).toLowerCase();
    const myIsLeft = myEntityId === leftId;
    const myIsRight = myEntityId === rightId;
    if (!myIsLeft && !myIsRight) {
      jEventLog.warn('account_settled.wrong_entity', { entity: shortId(entityState.entityId), left: shortId(leftId), right: shortId(rightId) });
      return done();
    }
    const counterpartyEntityId = myIsLeft ? rightEntity : leftEntity;
    const cpShort = String(counterpartyEntityId).slice(-4);
    const ownReserve = myIsLeft ? leftReserve : rightReserve;
    const tokenSymbol = getTokenSymbol(tokenIdNum);
    const decimals = getTokenDecimals(tokenIdNum);

    if (ownReserve !== undefined && ownReserve !== null) {
      const newReserve = BigInt(ownReserve as string | number | bigint);
      newState.reserves.set(tokenIdNum, newReserve);
    } else {
      jEventLog.warn('account_settled.reserve_missing', { counterparty: shortId(cpShort), tokenId: tokenIdNum });
    }

    // Account deltas move only through bilateral account-frame consensus.
    const account = newState.accounts.get(counterpartyEntityId as string);
    if (!account) {
      jEventLog.warn('account_settled.account_missing', { counterparty: shortId(cpShort) });
      return done();
    }
    dirtyAccounts.add(String(counterpartyEntityId).toLowerCase());

    if (account.lastFinalizedJHeight === undefined) account.lastFinalizedJHeight = 0;

    const jHeight = event.blockNumber ?? blockNumber;
    const jBlockHash = event.blockHash || '';

    // The claim uses normalized payload so both sides hash the same data.
    const normalizedClaimEvents = normalizeJurisdictionEvents([event]);
    if (normalizedClaimEvents.length !== 1) {
      jEventLog.warn('account_settled.claim_normalize_failed', { tokenId: tokenIdNum, counterparty: shortId(cpShort), block: blockNumber });
      return done();
    }
    const normalizedClaimEvent = normalizedClaimEvents[0];
    if (!normalizedClaimEvent) return done();
    const eventCopy = structuredClone(normalizedClaimEvent);
    mempoolOps.push({
      accountId: counterpartyEntityId as string,
      tx: { type: 'j_event_claim', data: { jHeight, jBlockHash, events: [eventCopy] } },
    });
    const p2p = env.runtimeState?.p2p as { sendDebugEvent?: (payload: unknown) => boolean } | undefined;
    if (typeof p2p?.sendDebugEvent === 'function') {
      p2p.sendDebugEvent({
        level: 'info',
        code: 'REB_STEP',
        step: 4,
        status: 'ok',
        event: 'j_event_claim_queued',
        entityId: entityState.entityId,
        counterpartyId: String(counterpartyEntityId),
        tokenId: tokenIdNum,
        jHeight,
      });
    }

    const collDisplay = (Number(collateral) / (10 ** decimals)).toFixed(4);
    addMessage(newState, `⚖️ OBSERVED: ${tokenSymbol} ${cpShort} | coll=${collDisplay} | j-block ${blockNumber} (awaiting 2-of-2)`);

  } else if (event.type === 'DebtCreated') {
    const { debtor, creditor, tokenId, amount } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const amountDisplay = (Number(amount) / (10 ** decimals)).toFixed(4);
    applyDebtCreated(newState, event);

    addMessage(newState, `🔴 DEBT: ${(debtor as string).slice(-8)} owes ${amountDisplay} ${tokenSymbol} to ${(creditor as string).slice(-8)} | Block ${blockNumber}`);

  } else if (event.type === 'DebtEnforced') {
    const { creditor, tokenId, amountPaid } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const paidDisplay = (Number(amountPaid) / (10 ** decimals)).toFixed(4);
    applyDebtEnforced(newState, event);

    addMessage(newState, `✅ DEBT PAID: ${paidDisplay} ${tokenSymbol} to ${(creditor as string).slice(-8)} | Block ${blockNumber}`);

  } else if (event.type === 'DebtForgiven') {
    const { debtor, creditor, tokenId, amountForgiven, debtIndex } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const forgivenDisplay = (Number(amountForgiven) / (10 ** decimals)).toFixed(4);
    applyDebtForgiven(newState, event);

    addMessage(newState, `🩶 DEBT FORGIVEN: ${forgivenDisplay} ${tokenSymbol} between ${(debtor as string).slice(-8)} and ${(creditor as string).slice(-8)} | Block ${blockNumber} · debt #${debtIndex}`);

  } else if (event.type === 'DisputeStarted') {
    await applyDisputeStartedJEvent(context);

  } else if (event.type === 'DisputeFinalized') {
    applyDisputeFinalizedJEvent(context, disputeFinalizationEvidence);

  } else if (event.type === 'HankoBatchProcessed') {
    await applyHankoBatchProcessedEvent({
      newState,
      event,
      transactionHash,
      blockNumber,
      dirtyAccounts,
      outputs,
    });

  } else if (event.type === 'EntityProviderActionExecuted') {
    applyEntityProviderActionExecuted(newState, event.data, blockNumber);

  } else if (event.type === 'EntityProviderActionCancelled') {
    applyEntityProviderActionCancelled(newState, event.data, blockNumber);

  } else {
    // Unknown event - log but don't fail
    addMessage(newState, `⚠️ Unknown j-event: ${event.type} | Block ${blockNumber}`);
    jEventLog.warn('unknown_event', { type: event.type, canonical: CANONICAL_J_EVENTS });
  }

  return done();
}
