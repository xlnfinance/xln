import type {
  AccountMachine,
  EntityInput,
  EntityState,
  Env,
  DisputeFinalizationEvidence,
  JurisdictionEvent,
  JurisdictionEventData,
} from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { getTokenInfo } from '../../account/utils';
import { CANONICAL_J_EVENTS } from '../../jadapter/helpers';
import { hashHtlcSecret } from '../../protocol/htlc/utils';
import { scheduleHook as scheduleCrontabHook, cancelHook as cancelCrontabHook } from '../scheduler';
import { getRuntimeJurisdictionDefaultDisputeDelayBlocks } from '../../jurisdiction/height';
import { scrubDisputeFinalizationsForCounterparty } from './dispute-finalize-guards';
import {
  compareCanonicalJurisdictionEvents,
  normalizeJurisdictionEvents,
} from '../../jurisdiction/event-normalization';
import {
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
  getJEventJurisdictionRef,
} from '../../jurisdiction/event-observation';
import { verifyAccountSignature } from '../../account/crypto';
import { markStorageEntityDirty } from '../../machine/env-events';
import { buildAccountProofBody } from '../../protocol/dispute/proof-builder';
import { applyDebtCreated, applyDebtEnforced, applyDebtForgiven } from './j-events-debt';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import {
  applyKnownHtlcSecret,
  decodeDisputeStarterInitialSecrets,
  queueCrossJurisdictionSalvageFromArgumentList,
  queueCrossJurisdictionSalvageFromDispute,
  queueCrossJurisdictionSourceDisputeFromTargetDispute,
} from './j-events-htlc';
import {
  mergeAccountJObservations,
  mergeJEventClaimOps,
} from './j-events-account';
import type { JEventApplyResult, JEventMempoolOp } from './j-events-types';
import { appendBatchHistory, emptyOpBreakdown } from './j-events-history';
import { applyHankoBatchProcessedEvent } from './j-events-batch';
import { isDisputeStartedByLeft } from '../../account/consensus/dispute-policy';
import {
  buildJEventRangeDigest,
  canonicalJEventRangeHash,
  foldJHistoryRoot,
} from '../../jurisdiction/history-consensus';
import { finalizedJHistoryRoot } from '../../jurisdiction/local-history';
import { getEntityLeaderState } from '../consensus/leader';
import {
  applySignerEntityExternalWalletDelta,
  applySignerEntityExternalWalletSnapshot,
} from '../signer-wallet';

const jEventLog = createStructuredLogger('j.event');
const normalizeSignerId = (value: unknown): string => String(value || '').trim().toLowerCase();

const getTokenSymbol = (tokenId: number): string => getTokenInfo(tokenId).symbol;
const getTokenDecimals = (tokenId: number): number => getTokenInfo(tokenId).decimals;

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

const normalizeJEventRangeBlocks = (
  data: JurisdictionEventData,
): JurisdictionEventData['blocks'] => {
  let previousHeight = data.baseHeight;
  return data.blocks.map((block) => {
    const blockNumber = Number(block.blockNumber);
    if (
      !Number.isSafeInteger(blockNumber) ||
      blockNumber <= previousHeight ||
      blockNumber > data.scannedThroughHeight
    ) {
      throw new Error(`j_event rejected: invalid ordered block height ${String(block.blockNumber)}`);
    }
    previousHeight = blockNumber;
    const blockHash = String(block.blockHash || '').trim().toLowerCase();
    if (!blockHash) throw new Error(`j_event rejected: missing block hash at ${blockNumber}`);
    const submittedEvents = normalizeJurisdictionEvents(block.events);
    if (submittedEvents.length === 0) throw new Error(`j_event rejected: empty event block ${blockNumber}`);
    const events = [...submittedEvents].sort(compareCanonicalJurisdictionEvents);
    for (let index = 0; index < events.length; index += 1) {
      if (canonicalJurisdictionEventsHash([submittedEvents[index]!]) !== canonicalJurisdictionEventsHash([events[index]!])) {
        throw new Error(`j_event rejected: non-canonical event order at ${blockNumber}`);
      }
    }
    for (const event of events) {
      if (
        Number(event.blockNumber) !== blockNumber ||
        String(event.blockHash || '').toLowerCase() !== blockHash
      ) {
        throw new Error(`j_event rejected: mixed event block at ${blockNumber}`);
      }
    }
    const eventsHash = canonicalJurisdictionEventsHash(events);
    if (eventsHash !== String(block.eventsHash || '').trim().toLowerCase()) {
      throw new Error(`j_event rejected: events hash mismatch at ${blockNumber}`);
    }
    const evidence = block.disputeFinalizationEvidence ?? [];
    const evidenceHash = evidence.length > 0
      ? canonicalDisputeFinalizationEvidenceHash(evidence)
      : '';
    if (evidenceHash !== String(block.disputeFinalizationEvidenceHash || '').trim().toLowerCase()) {
      throw new Error(`j_event rejected: evidence hash mismatch at ${blockNumber}`);
    }
    return {
      blockNumber,
      blockHash,
      eventsHash,
      events,
      ...(evidence.length > 0 ? { disputeFinalizationEvidence: structuredClone(evidence) } : {}),
      ...(evidenceHash ? { disputeFinalizationEvidenceHash: evidenceHash } : {}),
    };
  });
};

export const applyJEvent = async (
  entityState: EntityState,
  data: JurisdictionEventData,
  env: Env,
): Promise<JEventApplyResult> => {
  const signerId = normalizeSignerId(data.from);
  const activeProposerId = normalizeSignerId(getEntityLeaderState(entityState).activeValidatorId);
  if (!signerId || signerId !== activeProposerId) {
    throw new Error(`j_event rejected: signer ${signerId || 'missing'} is not active proposer ${activeProposerId}`);
  }
  const jurisdictionRef = String(data.jurisdictionRef || '').trim().toLowerCase();
  const expectedJurisdictionRef = getJEventJurisdictionRef(entityState.config.jurisdiction);
  if (jurisdictionRef !== expectedJurisdictionRef) {
    throw new Error(`j_event rejected: jurisdiction mismatch expected=${expectedJurisdictionRef} got=${jurisdictionRef || 'missing'}`);
  }
  const baseHeight = Number(data.baseHeight);
  const scannedThroughHeight = Number(data.scannedThroughHeight);
  if (!Number.isSafeInteger(baseHeight) || baseHeight < 0) {
    throw new Error(`j_event rejected: invalid base height ${String(data.baseHeight)}`);
  }
  if (!Number.isSafeInteger(scannedThroughHeight) || scannedThroughHeight <= baseHeight) {
    throw new Error(`j_event rejected: invalid scanned height ${String(data.scannedThroughHeight)}`);
  }
  if (Number(data.observedAt) !== scannedThroughHeight) {
    throw new Error('j_event rejected: observedAt must equal scannedThroughHeight');
  }
  const tipBlockHash = String(data.tipBlockHash || '').trim().toLowerCase();
  if (!tipBlockHash) throw new Error('j_event rejected: missing tip block hash');

  const blocks = normalizeJEventRangeBlocks(data);
  const rangeHash = canonicalJEventRangeHash(jurisdictionRef, blocks);
  if (rangeHash !== String(data.rangeHash || '').trim().toLowerCase()) {
    throw new Error('j_event rejected: range body hash mismatch');
  }
  const eventHistoryRoot = foldJHistoryRoot(
    finalizedJHistoryRoot(entityState),
    blocks.map((block) => ({
      jurisdictionRef,
      jHeight: block.blockNumber,
      jBlockHash: block.blockHash,
      eventsHash: block.eventsHash,
    })),
  );
  if (eventHistoryRoot !== String(data.eventHistoryRoot || '').trim().toLowerCase()) {
    throw new Error('j_event rejected: event history root mismatch');
  }
  const signature = String(data.signature || '').trim().toLowerCase();
  const digest = buildJEventRangeDigest({
    entityId: entityState.entityId,
    jurisdictionRef,
    signerId,
    baseHeight,
    scannedThroughHeight,
    tipBlockHash,
    eventHistoryRoot,
    rangeHash,
  });
  if (!signature || !verifyAccountSignature(env, signerId, digest, signature)) {
    throw new Error(`j_event rejected: invalid proposer signature for ${signerId}`);
  }

  if (scannedThroughHeight <= entityState.lastFinalizedJHeight) {
    return { newState: entityState, mempoolOps: [], outputs: [], dirtyAccounts: [] };
  }
  if (baseHeight !== entityState.lastFinalizedJHeight) {
    throw new Error(
      `j_event rejected: non-current base expected=${entityState.lastFinalizedJHeight} got=${baseHeight}`,
    );
  }

  let state = cloneEntityState(entityState);
  const mempoolOps: JEventMempoolOp[] = [];
  const outputs: EntityInput[] = [];
  const dirtyAccounts = new Set<string>();
  for (const block of blocks) {
    state.jBlockChain.push({
      jurisdictionRef,
      jHeight: block.blockNumber,
      jBlockHash: block.blockHash,
      eventsHash: block.eventsHash,
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
      for (const accountId of result.dirtyAccounts) dirtyAccounts.add(accountId);
      if (!state.jBlockChain.some((entry) => entry.jHeight === block.blockNumber)) {
        throw new Error(`j_event invariant: finalized block ${block.blockNumber} lost during apply`);
      }
    }
  }

  state.lastFinalizedJHeight = scannedThroughHeight;
  state.jHistoryFinality = {
    jurisdictionRef,
    baseHeight,
    finalizedThroughHeight: scannedThroughHeight,
    tipBlockHash,
    eventHistoryRoot,
    proposerSignerId: signerId,
    proposerSignature: signature,
    entityHeight: entityState.height + 1,
  };
  state.jBlockChain.sort((left, right) => left.jHeight - right.jHeight);
  for (const [accountId, account] of state.accounts) {
    const leftChanged = mergeAccountJObservations(account.leftJObservations);
    const rightChanged = mergeAccountJObservations(account.rightJObservations);
    if (leftChanged || rightChanged) dirtyAccounts.add(String(accountId).toLowerCase());
  }
  mergeJEventClaimOps(mempoolOps);
  jEventLog.info('history.finalized_by_entity', {
    range: `${baseHeight + 1}-${scannedThroughHeight}`,
    eventBlocks: blocks.length,
    root: shortHash(eventHistoryRoot),
    proposer: shortId(signerId),
  });
  return { newState: state, mempoolOps, outputs, dirtyAccounts: [...dirtyAccounts] };
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

function clearDisputeSettledDeltas(
  account: AccountMachine,
  finalProofbodyHash: string,
  counterpartyId: string,
): void {
  const finalizedProofBody = finalProofbodyHash
    ? account.disputeProofBodiesByHash?.[finalProofbodyHash] as { tokenIds?: unknown[]; offdeltas?: unknown[] } | undefined
    : undefined;
  if (finalizedProofBody && Array.isArray(finalizedProofBody.tokenIds) && Array.isArray(finalizedProofBody.offdeltas)) {
    for (let i = 0; i < finalizedProofBody.tokenIds.length; i += 1) {
      const tokenId = Number(finalizedProofBody.tokenIds[i]);
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
    return;
  }

  jEventLog.warn('dispute_finalized.proof_body_missing', { counterparty: shortId(counterpartyId) });
  for (const delta of account.deltas.values()) {
    delta.collateral = 0n;
    delta.ondelta = 0n;
    delta.offdelta = 0n;
    delta.leftHold = 0n;
    delta.rightHold = 0n;
    delta.leftAllowance = 0n;
    delta.rightAllowance = 0n;
  }
}

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
  const disputeTimeout =
    Number(data.disputeTimeout ?? 0) ||
    (
      Number(blockNumber || 0) +
      getRuntimeJurisdictionDefaultDisputeDelayBlocks(env, newState.config.jurisdiction?.name, 5)
    );
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

  const localProof = buildAccountProofBody(account);
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
      batch: {
        flashloans: [],
        reserveToReserve: [],
        reserveToCollateral: [],
        collateralToReserve: [],
        settlements: [],
        disputeStarts: [{
          counterentity: counterpartyId,
          nonce: Number(nonce || 0),
          proofbodyHash: String(proofbodyHash || '0x'),
          watchSeed: String(data.watchSeed || '0x'),
          sig: '0x',
          starterInitialArguments: String(starterInitialArguments || '0x'),
          starterIncrementedArguments: String(data.starterIncrementedArguments || '0x'),
        }],
        disputeFinalizations: [],
        externalTokenToReserve: [],
        reserveToExternalToken: [],
        revealSecrets: [],
        hub_id: 0,
      },
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
  syncJBatchEntityNonceFromEvent(newState, senderStr, entityIdNorm, data.batchNonce);

  if (!account) {
    jEventLog.warn('dispute_finalized.account_missing', { account: shortId(candidateCounterpartyId), entity: shortId(entityIdNorm) });
    return;
  }

  dirtyAccounts.add(counterpartyId.toLowerCase());
  const weAreFinalizer = senderStr === entityIdNorm;
  const finalProofbodyHash = String(data.finalProofbodyHash || '0x');
  const finalizationEvidence = disputeFinalizationEvidence.filter((evidence) =>
    normalizeEntityId(evidence.sender) === senderStr &&
    normalizeEntityId(evidence.counterentity) === counterentityStr &&
    String(evidence.initialNonce) === String(initialNonce) &&
    String(evidence.initialProofbodyHash).toLowerCase() === String(initialProofbodyHash).toLowerCase() &&
    String(evidence.finalProofbodyHash).toLowerCase() === finalProofbodyHash.toLowerCase()
  );
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
      batch: {
        flashloans: [],
        reserveToReserve: [],
        reserveToCollateral: [],
        collateralToReserve: [],
        settlements: [],
        disputeStarts: [],
        disputeFinalizations: [{
          counterentity: counterpartyId,
          initialNonce: Number(initialNonce || 0),
          finalNonce: finalizedJNonce,
          initialProofbodyHash: String(initialProofbodyHash || '0x'),
          finalProofbody: {
            watchSeed: account.watchSeed,
            offdeltas: [],
            tokenIds: [],
            transformers: [],
          },
          leftArguments: '0x',
          rightArguments: '0x',
          starterInitialArguments: '0x',
          starterIncrementedArguments: '0x',
          sig: '0x',
          startedByLeft: false,
          disputeUntilBlock: Number(blockNumber || 0),
          cooperative: false,
        }],
        externalTokenToReserve: [],
        reserveToExternalToken: [],
        revealSecrets: [],
        hub_id: 0,
      },
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
  if (removed > 0) {
    addMessage(newState, `🧹 Removed ${removed} stale dispute-finalize op(s) for ${counterpartyId.slice(-4)}`);
  }

  const finalizationArgumentBlobs = finalizationEvidence.flatMap((evidence) => [
    evidence.leftArguments,
    evidence.rightArguments,
    evidence.starterInitialArguments,
    evidence.starterIncrementedArguments,
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

  clearDisputeSettledDeltas(account, finalProofbodyHash, counterpartyId);

  // Drop off-chain intents from pre-dispute epoch.
  if (account.swapOffers.size > 0) {
    account.swapOffers.clear();
  }
  if (account.locks.size > 0) {
    account.locks.clear();
  }
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
  const dirtyAccounts = new Set<string>();
  const done = (): JEventApplyResult => ({
    newState,
    mempoolOps,
    outputs,
    dirtyAccounts: Array.from(dirtyAccounts),
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

  if (event.type === 'ReserveUpdated') {
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

    if (!account.leftJObservations) account.leftJObservations = [];
    if (!account.rightJObservations) account.rightJObservations = [];
    if (!account.jEventChain) account.jEventChain = [];
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
    const observedAt = entityState.timestamp || 0;
    mempoolOps.push({
      accountId: counterpartyEntityId as string,
      tx: { type: 'j_event_claim', data: { jHeight, jBlockHash, events: [eventCopy], observedAt } },
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
    await applyHankoBatchProcessedEvent({ newState, event, transactionHash, blockNumber, dirtyAccounts });

  } else {
    // Unknown event - log but don't fail
    addMessage(newState, `⚠️ Unknown j-event: ${event.type} | Block ${blockNumber}`);
    jEventLog.warn('unknown_event', { type: event.type, canonical: CANONICAL_J_EVENTS });
  }

  return done();
}
