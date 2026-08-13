import type { EntityCandidateEffect, EntityInput, EntityState, HashToSign } from '../types';
import type { EntityRuntimeContext } from '../runtime-context';
import type { AccountReplica } from '../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { AccountConsensusContext } from '../../account/consensus/context';
import type { DisputeFinalizationEvidence, JurisdictionEvent, JurisdictionEventData } from '../../types/jurisdiction-events';
import type { ProofBodyStruct } from '../../protocol/dispute/proof-body';
import { prepareEntityTxState } from '../state-clone';
import { addMessage } from '../frame-events';
import { hashHtlcSecret } from '../../protocol/htlc/utils';
import {
  FailureDispositionError,
  haltRuntimeFailure,
} from '../../protocol/errors/failure-taxonomy';
import { cancelHook, scheduleHook } from '../scheduler';
import {
  scrubDisputeFinalizationsForCounterparty,
  scrubDisputeStartsForCounterparty,
  scrubCounterDisputesForActiveStart,
  scrubCounterDisputesForCounterparty,
  scrubCounterDisputesSupersededByObserved,
  scrubSourceHashLadderRegistrationsForCounterparty,
} from './dispute-finalize-guards';
import {
  getJEventJurisdictionRef,
} from '../../jurisdiction/machine/event-observation';
import { verifyAccountSignature } from '../../account/crypto';
import { hashProofBodyStruct } from '../../protocol/dispute/proof-builder';
import {
  buildAccountProofBodyFromJurisdictions,
  requireAccountDeltaTransformerAddress,
} from '../../account/consensus/helpers';
import {
  assertDisputeProofBodyWithinContractLimits,
  batchAddCounterDispute,
  cloneJBatch,
  hasJBatchWork,
  initJBatch,
  isBatchEmpty,
  prependRecoveryBatch,
} from '../../jurisdiction/machine/batch';
import { canonicalizeProofBodyStruct } from './handlers/dispute';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import {
  applyKnownHtlcSecret,
  decodeDisputeStarterInitialSecrets,
  flushDeferredHashLadderReveals,
  ladderHashForPull,
  planCrossJurisdictionTargetRecovery,
  queueCrossJurisdictionRevealPorts,
  queueCrossJurisdictionSiblingDisputeFanout,
  queueSourceHubClaimRegistrationsForAccount,
  refreshCrossJurisdictionTargetRecovery,
} from './j-events-htlc';
import {
  isCrossJurisdictionTerminalStatus,
  transitionCrossJurisdictionRouteStatus,
} from '../../extensions/cross-j';
import { transitionTargetLegTerminal } from './handlers/account-cross-j-followups';
import { mergeJEventClaimOps } from './j-events-account';
import type { JEventApplyResult, JEventAccountTx } from './j-events-types';
import { applyHankoBatchProcessedEvent } from './j-events-batch';
import {
  applyEntityProviderActionCancelled,
  applyEntityProviderActionExecuted,
} from './j-events-entity-provider-action';
import {
  foldJHistoryRoot,
} from '../../jurisdiction/machine/history-consensus';
import {
  finalizedJHistoryRoot,
  pruneCertifiedJHistory,
  reconcileJEventRangeWithFinalizedState,
  type ReconciledJEventRange,
} from '../../jurisdiction/machine/local-history';
import { assertEntityFrameJRangeBudget } from '../../jurisdiction/machine/range-budget';
import { getEntityLeaderState } from '../consensus/leader';
import {
  advanceCertifiedBoardFinality,
} from '../../jurisdiction/machine/board-registry';
import { validateJEventRangeEnvelope } from '../../jurisdiction/machine/j-event-range-validation';
import { applyAccountInput } from '../../account/consensus';
import { accountInputFailureMessage } from '../../account/consensus/result';
import type { HandleAccountInputApplied } from '../../account/consensus/types';
import {
  createAccountDisputeFinalityInput,
  createAccountDisputeStartedInput,
} from '../../account/input';
import { applyCertifiedBoardJEvent } from './j-events-board';
import { applyAccountSettledJEvent } from './j-events-account-settled';
import {
  applyDebtJEvent,
  applyExternalWalletJEvent,
  applyReserveUpdatedJEvent,
  applySecretRevealedJEvent,
} from './j-events-observations';
import { requireBoundaryUint } from '../../protocol/boundary-validation';
import {
  toUnixMs,
  toUnixS,
  unixMsToUnixSFloor,
  type UnixS,
} from '../../protocol/units';
import { getJurisdictionStackId } from '../../jurisdiction/machine/jurisdiction-runtime';
import {
  findExactSignedProofBodyPull,
  resolveFinalizedCrossJurisdictionRouteLeg,
  resolveFinalizedPullFillRatio,
  type HashLadderRegistryRecord,
} from '../../account/pull-registry-settlement';
import {
  selectFinalProof,
  verifyCounterProofIdentity,
} from './handlers/dispute/finalize-proof';
import { proofBodyHasPulls } from './handlers/dispute/start-admission';

const jEventLog = createStructuredLogger('j.event');
const normalizeSignerId = (value: unknown): string => String(value || '').trim().toLowerCase();

const incrementAccountNonce = (nonce: number, code: string): number => {
  if (nonce >= Number.MAX_SAFE_INTEGER) throw new Error(`${code}:${nonce}`);
  return nonce + 1;
};

const invalidateSettlementIntentAfterDisputeFinality = (
  state: EntityState,
  counterpartyId: string,
  accountResult: NonNullable<HandleAccountInputApplied['externalFinality']>,
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

const queueLocalJBatchBroadcast = (
  state: EntityState,
  outputs: EntityInput[],
): boolean => {
  const jBatchState = state.jBatchState;
  if (!jBatchState || jBatchState.sentBatch || !hasJBatchWork(jBatchState)) return false;
  const self = String(state.entityId || '').toLowerCase();
  if (outputs.some((output) =>
    String(output.entityId || '').toLowerCase() === self
    && output.entityTxs?.some((tx) => tx.type === 'j_broadcast')
  )) return false;
  const signerId = state.config.validators[0];
  if (!signerId) throw new Error('J_BATCH_AUTO_BROADCAST_SIGNER_MISSING');
  outputs.push({
    entityId: state.entityId,
    signerId,
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  });
  return true;
};

const retireSentBatchInvalidatedByDisputeFinality = (
  state: EntityState,
  counterpartyId: string,
): number => {
  const jBatchState = state.jBatchState;
  const sentBatch = jBatchState?.sentBatch;
  if (!jBatchState || !sentBatch) return 0;
  const remainingBatch = cloneJBatch(sentBatch.batch);
  const removed = scrubDisputeFinalizationsForCounterparty(remainingBatch, counterpartyId)
    + scrubCounterDisputesForCounterparty(remainingBatch, counterpartyId)
    + scrubSourceHashLadderRegistrationsForCounterparty(remainingBatch, counterpartyId);
  if (removed === 0) return 0;

  // The editable draft and recovered sent remainder are independently valid
  // batches. Keep them separate: blindly merging can exceed contract limits
  // and reject the authoritative finality event itself.
  prependRecoveryBatch(jBatchState, remainingBatch);
  delete jBatchState.sentBatch;
  jBatchState.status = hasJBatchWork(jBatchState) ? 'accumulating' : 'empty';
  return removed;
};

export const sentBatchOwnsDisputeFinalityAck = (
  state: EntityState,
  counterpartyId: string,
  initialProofbodyHash: string,
  batchNonce: number | undefined,
): boolean => {
  const sent = state.jBatchState?.sentBatch;
  if (
    !sent || batchNonce === undefined || !Number.isSafeInteger(batchNonce)
    || batchNonce <= 0 || sent.entityNonce !== batchNonce
  ) return false;
  const counterparty = normalizeEntityId(counterpartyId);
  const initialHash = String(initialProofbodyHash || '').toLowerCase();
  return sent.batch.disputeFinalizations.some(finalization =>
    normalizeEntityId(finalization.counterentity) === counterparty
    && String(finalization.initialProofbodyHash || '').toLowerCase() === initialHash
  );
};

const retireSentBatchInvalidatedByDisputeStart = (
  state: EntityState,
  counterpartyId: string,
  initialProofbodyHash: string,
): number => {
  const jBatchState = state.jBatchState;
  const sentBatch = jBatchState?.sentBatch;
  if (!jBatchState || !sentBatch) return 0;
  const remainingBatch = cloneJBatch(sentBatch.batch);
  const removed = scrubDisputeStartsForCounterparty(remainingBatch, counterpartyId)
    + scrubCounterDisputesForActiveStart(remainingBatch, counterpartyId, initialProofbodyHash);
  if (removed === 0) return 0;

  // The competing start is already final, so this sealed transaction can only
  // revert with E6. Requeue every still-valid operation, especially the Target
  // registration whose lazy authority is the newly active exact ProofBody.
  prependRecoveryBatch(jBatchState, remainingBatch);
  delete jBatchState.sentBatch;
  jBatchState.status = hasJBatchWork(jBatchState) ? 'accumulating' : 'empty';
  return removed;
};

const retireSentBatchSupersededByCounterDispute = (
  state: EntityState,
  counterpartyId: string,
  observedNonce: number,
  observedProposerIsLeft: boolean,
  observedProofbodyHash: string,
): number => {
  const jBatchState = state.jBatchState;
  const sentBatch = jBatchState?.sentBatch;
  if (!jBatchState || !sentBatch) return 0;
  const remainingBatch = cloneJBatch(sentBatch.batch);
  const removed = scrubCounterDisputesSupersededByObserved(
    remainingBatch,
    counterpartyId,
    observedNonce,
    observedProposerIsLeft,
    observedProofbodyHash,
    true,
  );
  if (removed === 0) return 0;
  prependRecoveryBatch(jBatchState, remainingBatch);
  delete jBatchState.sentBatch;
  jBatchState.status = hasJBatchWork(jBatchState) ? 'accumulating' : 'empty';
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
  env: EntityRuntimeContext,
  accountConsensusContext: AccountConsensusContext,
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
        accountConsensusContext,
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
  env: EntityRuntimeContext,
  accountConsensusContext: AccountConsensusContext,
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
      throw haltRuntimeFailure(
        'J_EVENT_PROPOSER_SIGNATURE_INVALID',
        `j_event rejected: invalid proposer signature for ${normalizeSignerId(data.from)}`,
      );
    }
    throw haltRuntimeFailure('J_EVENT_RANGE_REJECTED', `j_event rejected: ${validated.code}`);
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
    accountConsensusContext,
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
  env: EntityRuntimeContext;
  accountConsensusContext: AccountConsensusContext;
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
  account: AccountReplica | undefined;
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
    throw haltRuntimeFailure("J_EVENT_DISPUTE_FINAL_PROOFBODY_HASH_INVALID", `J_EVENT_DISPUTE_FINAL_PROOFBODY_HASH_INVALID:${counterpartyId}:${hash || 'missing'}`);
  }
  return hash;
};

const requireFinalizedProofBodyEvidence = (
  account: AccountReplica,
  finalProofbodyHashRaw: unknown,
  counterpartyId: string,
): { finalProofbodyHash: string; proofbody: ProofBodyStruct; tokenIds: number[] } => {
  const finalProofbodyHash = normalizeFinalProofbodyHash(finalProofbodyHashRaw, counterpartyId);
  const matches = Object.entries(account.disputeProofBodiesByHash ?? {})
    .filter(([proofbodyHash]) => proofbodyHash.toLowerCase() === finalProofbodyHash);
  if (matches.length === 0) {
    throw haltRuntimeFailure("J_EVENT_DISPUTE_FINAL_PROOFBODY_MISSING", `J_EVENT_DISPUTE_FINAL_PROOFBODY_MISSING:${counterpartyId}:${finalProofbodyHash}`);
  }
  if (matches.length !== 1) {
    throw haltRuntimeFailure("J_EVENT_DISPUTE_FINAL_PROOFBODY_AMBIGUOUS", `J_EVENT_DISPUTE_FINAL_PROOFBODY_AMBIGUOUS:${counterpartyId}:${finalProofbodyHash}`);
  }
  let proofbody: ProofBodyStruct;
  let computedHash: string;
  try {
    proofbody = canonicalizeProofBodyStruct(
      matches[0]![1] as ProofBodyStruct,
      account.state.leftEntity,
      account.state.rightEntity,
      'jEvent.disputeFinalized',
    );
    assertDisputeProofBodyWithinContractLimits(proofbody, 'jEvent.disputeFinalized');
    computedHash = hashProofBodyStruct(proofbody).toLowerCase();
  } catch (error) {
    if (error instanceof FailureDispositionError) throw error;
    throw haltRuntimeFailure("J_EVENT_DISPUTE_FINAL_PROOFBODY_INVALID", `J_EVENT_DISPUTE_FINAL_PROOFBODY_INVALID:${counterpartyId}:${finalProofbodyHash}`, error);
  }
  if (computedHash !== finalProofbodyHash) {
    throw haltRuntimeFailure("J_EVENT_DISPUTE_FINAL_PROOFBODY_HASH_MISMATCH", `J_EVENT_DISPUTE_FINAL_PROOFBODY_HASH_MISMATCH:${counterpartyId}:${finalProofbodyHash}:${computedHash}`);
  }
  const tokenIds = proofbody.tokenIds.map((value, index) => {
    const tokenId = Number(BigInt(value));
    if (!Number.isSafeInteger(tokenId) || tokenId < 0) {
      throw haltRuntimeFailure("J_EVENT_DISPUTE_FINAL_TOKEN_ID_INVALID", `J_EVENT_DISPUTE_FINAL_TOKEN_ID_INVALID:${counterpartyId}:${index}:${String(value)}`);
    }
    return tokenId;
  });
  return { finalProofbodyHash, proofbody, tokenIds };
};

const installOnchainDisputeProofBody = (
  account: AccountReplica,
  rawProofbody: ProofBodyStruct,
  expectedHashRaw: unknown,
  counterpartyId: string,
  context: string,
): ProofBodyStruct => {
  const expectedHash = normalizeFinalProofbodyHash(expectedHashRaw, counterpartyId);
  const proofbody = canonicalizeProofBodyStruct(
    rawProofbody,
    account.state.leftEntity,
    account.state.rightEntity,
    context,
  );
  assertDisputeProofBodyWithinContractLimits(proofbody, context);
  const computedHash = hashProofBodyStruct(proofbody).toLowerCase();
  if (computedHash !== expectedHash) {
    throw haltRuntimeFailure("J_EVENT_DISPUTE_PROOFBODY_SIDECAR_HASH_MISMATCH", `J_EVENT_DISPUTE_PROOFBODY_SIDECAR_HASH_MISMATCH:` +
      `${counterpartyId}:${expectedHash}:${computedHash}`);
  }
  account.disputeProofBodiesByHash ??= {};
  account.disputeProofBodiesByHash[expectedHash] = proofbody;
  return proofbody;
};

type DisputeStartedEventData = {
  sender: string;
  counterentity: string;
  nonce: string;
  proposerIsLeft: boolean;
  proofbodyHash: string;
  starterInitialArguments: string;
  starterCounterArguments: string;
  starterCounterProofCommitment: string;
  initialProofbody: ProofBodyStruct;
  watchSeed?: unknown;
  batchNonce?: number;
  disputeTimeout?: number;
  disputeStartTimestamp?: number;
  leftResponseSeconds?: number;
  rightResponseSeconds?: number;
  jNonce?: unknown;
};

type StartedDispute = {
  counterpartyId: string;
  senderStr: string;
  entityIdNorm: string;
  weAreStarter: boolean;
  starterInitialArguments: string;
  disputeTimeout: UnixS;
  counterProofQueued: boolean;
  initialProofbody: ProofBodyStruct;
  canonicalDeltaTransformerAddress: string;
};

const queueSelectedPullCounterProof = (
  context: FinalizedJEventContext,
  account: AccountReplica,
  counterpartyId: string,
): boolean => {
  const active = account.activeDispute!;
  const callerIsLeft = account.state.leftEntity.toLowerCase() === context.newState.entityId.toLowerCase();
  const callerIsStarter = callerIsLeft === active.startedByLeft;
  if (
    callerIsStarter
    || !account.counterpartyDisputeProofHanko
    || account.counterpartyDisputeProofHanko === '0x'
    || account.counterpartyDisputeProofNonce === undefined
    || !account.counterpartyDisputeProofBodyHash
  ) return false;
  const selection = selectFinalProof(
    context.entityState,
    context.newState,
    account,
    counterpartyId,
    context.env,
  );
  if (!selection?.shouldUseCounterProof) return false;
  const deltaTransformer = requireAccountDeltaTransformerAddress(
    context.env.state,
    account.state,
  );
  if (!proofBodyHasPulls(selection.finalProofbody, deltaTransformer)) return false;
  verifyCounterProofIdentity(context.newState, account, counterpartyId, selection);
  const nowSec = unixMsToUnixSFloor(toUnixMs(Number(context.newState.timestamp || 0)));
  if (nowSec >= active.disputeTimeout) {
    // Missing the signed response period is an economic outcome, not a reason
    // to reject the authoritative DisputeStarted J event and halt the replica.
    addMessage(
      context.newState,
      `❌ Pull counter-proof ${selection.finalNonce} missed T=${active.disputeTimeout}`,
    );
    jEventLog.error('counter_dispute.deadline_missed', {
      counterparty: shortId(counterpartyId),
      finalNonce: selection.finalNonce,
      nowSec,
      timeoutSec: active.disputeTimeout,
    });
    return false;
  }
  context.newState.jBatchState ??= initJBatch();
  batchAddCounterDispute(context.newState.jBatchState, {
    counterentity: counterpartyId,
    initialNonce: active.initialNonce,
    initialProofbodyHash: active.initialProofbodyHash,
    counterNonce: selection.finalNonce,
    proposerIsLeft: selection.proposerIsLeft,
    counterProofbody: selection.finalProofbody,
    sig: selection.finalizeSig,
  });
  if (context.newState.jBatchState.sentBatch) {
    // The immutable batch owns the current nonce. Keep this urgent response
    // latched so its exact HankoBatchProcessed ACK emits the one continuation
    // that broadcasts the counter-proof draft before T.
    context.newState.jBatchState.autoBroadcastDraft = true;
  }
  // The selected proof is already authenticated locally and the registry
  // write is processed after counterDisputes in the same processBatch. Queue
  // its Source evidence now: waiting for CounterDisputeRegistered would let a
  // valid counter-proof consume the Hub's shorter Source window before the
  // first immutable registry write can be mined.
  queueSourceHubClaimRegistration(
    context,
    counterpartyId,
    selection.finalProofbody,
    deltaTransformer,
  );
  addMessage(
    context.newState,
    `🛡️ Locked newer Pull state N${selection.finalNonce} before dispute T`,
  );
  return true;
};

const retireStartedDisputeBatchOps = (
  state: EntityState,
  counterpartyId: string,
  initialProofbodyHash: string,
  weAreStarter: boolean,
  outputs: EntityInput[],
): { removedDraft: number; removedRecovery: number; removedSent: number } => {
  const removedDraft = scrubDisputeStartsForCounterparty(
    state.jBatchState?.batch,
    counterpartyId,
  ) + scrubCounterDisputesForActiveStart(
    state.jBatchState?.batch,
    counterpartyId,
    initialProofbodyHash,
  );
  let removedRecovery = 0;
  for (const recoveryBatch of state.jBatchState?.recoveryBatches ?? []) {
    removedRecovery += scrubDisputeStartsForCounterparty(recoveryBatch, counterpartyId)
      + scrubCounterDisputesForActiveStart(recoveryBatch, counterpartyId, initialProofbodyHash);
  }
  if (state.jBatchState?.recoveryBatches) {
    state.jBatchState.recoveryBatches = state.jBatchState.recoveryBatches
      .filter(batch => !isBatchEmpty(batch));
    if (state.jBatchState.recoveryBatches.length === 0) delete state.jBatchState.recoveryBatches;
  }
  const counterpartyKey = counterpartyId.toLowerCase();
  const proofKey = initialProofbodyHash.toLowerCase();
  const observedStartIsInOwnSentBatch = weAreStarter && Boolean(
    state.jBatchState?.sentBatch?.batch.disputeStarts.some(start =>
      String(start.counterentity || '').toLowerCase() === counterpartyKey
      && String(start.proofbodyHash || '').toLowerCase() === proofKey
    ),
  );
  // Keep a matching locally-originated sent batch until HankoBatchProcessed
  // acknowledges the whole transaction. Any competing start — including one
  // sent by our Entity with a different valid proof — makes every local start
  // for this Account fail E6. Independent reveal registrations remain valid
  // and are preserved while the start is retired deterministically.
  const removedSent = observedStartIsInOwnSentBatch
    ? 0
    : retireSentBatchInvalidatedByDisputeStart(
      state,
      counterpartyId,
      initialProofbodyHash,
    );
  const removed = removedDraft + removedRecovery + removedSent;
  if (removed === 0) return { removedDraft, removedRecovery, removedSent };
  // Requeueing a retired sent batch needs a new durable continuation: no
  // periodic scheduler owns arbitrary accumulating J batches. A mutable draft
  // already has the continuation emitted when its start/reveal was queued;
  // emitting another across Entity frames could arrive after the first seals
  // the batch and fail on the now-active sentBatch.
  const broadcastQueued = removedSent > 0 || removedRecovery > 0
    ? queueLocalJBatchBroadcast(state, outputs)
    : false;
  jEventLog.info('dispute_started.stale_batch_ops_removed', {
    counterparty: shortId(counterpartyId),
    removedDraft,
    removedRecovery,
    removedSent,
    broadcastQueued,
  });
  addMessage(
    state,
    `🧹 Removed ${removed} stale dispute-start op(s) for ${counterpartyId.slice(-4)}`,
  );
  return { removedDraft, removedRecovery, removedSent };
};

const applyStartedDisputeAccountInput = async (
  context: FinalizedJEventContext,
  account: AccountReplica,
  entityIdNorm: string,
  senderStr: string,
  counterpartyId: string,
  data: DisputeStartedEventData,
): Promise<void> => {
  const initialNonce = requireBoundaryUint(data.nonce, 'J_EVENT_DISPUTE_NONCE_INVALID');
  const jNonce = requireBoundaryUint(
    data.jNonce ?? data.nonce,
    'J_EVENT_DISPUTE_J_NONCE_INVALID',
  );
  const accountInput = createAccountDisputeStartedInput(account.state, entityIdNorm, {
    kind: 'dispute_started',
    starterEntityId: senderStr,
    initialProofbodyHash: String(data.proofbodyHash),
    initialNonce,
    initialProposerIsLeft: data.proposerIsLeft,
    disputeTimeout: toUnixS(Number(data.disputeTimeout)),
    disputeStartTimestamp: toUnixS(Number(data.disputeStartTimestamp)),
    leftResponseSeconds: requireBoundaryUint(
      data.leftResponseSeconds,
      'J_EVENT_DISPUTE_LEFT_RESPONSE_SECONDS_INVALID',
    ),
    rightResponseSeconds: requireBoundaryUint(
      data.rightResponseSeconds,
      'J_EVENT_DISPUTE_RIGHT_RESPONSE_SECONDS_INVALID',
    ),
    jNonce,
    starterInitialArguments: data.starterInitialArguments || '0x',
    starterCounterArguments: data.starterCounterArguments || '0x',
    starterCounterProofCommitment: data.starterCounterProofCommitment,
    observedBlockNumber: Number(context.blockNumber || 0),
    ...(data.batchNonce !== undefined ? { batchNonce: data.batchNonce } : {}),
  });
  const result = await applyAccountInput(
    context.accountConsensusContext,
    account,
    accountInput,
  );
  if (!result.ok) {
    throw new Error(
      `ACCOUNT_DISPUTE_STARTED_INPUT_FAILED:${counterpartyId}:` +
      `${accountInputFailureMessage(result)}`,
    );
  }
};

const initializeStartedDispute = async (
  context: FinalizedJEventContext,
  data: DisputeStartedEventData,
): Promise<StartedDispute | null> => {
  const {
    newState,
    env,
    dirtyAccounts,
  } = context;
  const { sender, counterentity, proofbodyHash } = data;
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

  installOnchainDisputeProofBody(
    account,
    data.initialProofbody,
    data.proofbodyHash,
    counterpartyId,
    'jEvent.disputeStarted',
  );

  const weAreStarter = senderStr === entityIdNorm;
  const disputeTimeout = toUnixS(Number(data.disputeTimeout));
  await applyStartedDisputeAccountInput(
    context,
    account,
    entityIdNorm,
    senderStr,
    counterpartyId,
    data,
  );

  syncJBatchEntityNonceFromEvent(newState, senderStr, entityIdNorm, data.batchNonce);
  const activeDispute = account.activeDispute;
  if (!activeDispute) {
    throw new Error(`ACCOUNT_DISPUTE_STARTED_STATE_MISSING:${counterpartyId}`);
  }
  const retired = retireStartedDisputeBatchOps(
    newState,
    counterpartyId,
    String(proofbodyHash),
    weAreStarter,
    context.outputs,
  );
  const counterProofQueued = queueSelectedPullCounterProof(context, account, counterpartyId);
  const flushedReveals = flushDeferredHashLadderReveals(newState);
  if (
    (flushedReveals > 0 || counterProofQueued)
    && retired.removedDraft === 0
    && retired.removedRecovery === 0
    && retired.removedSent === 0
  ) {
    // Newly queued counter-proof/reveal work needs one durable continuation.
    // Draft/sent retirement already owns it on the competing-batch path.
    queueLocalJBatchBroadcast(newState, context.outputs);
  }
  dirtyAccounts.add(counterpartyId.toLowerCase());
  const localProof = buildAccountProofBodyFromJurisdictions(env.state, account);
  const onChainProofHash = String(activeDispute.initialProofbodyHash || '').toLowerCase();
  const storedProofKnown = Object.keys(account.disputeProofBodiesByHash ?? {})
    .some((hash) => hash.toLowerCase() === onChainProofHash);
  if (localProof.proofBodyHash.toLowerCase() !== onChainProofHash) {
    jEventLog.debug('dispute.proof_hash_not_current', {
      counterparty: shortId(counterpartyId),
      local: shortHash(localProof.proofBodyHash),
      onChain: shortHash(activeDispute.initialProofbodyHash),
      storedProofKnown,
    });
  }
  const initialProofbody = requireFinalizedProofBodyEvidence(
    account,
    activeDispute.initialProofbodyHash,
    counterpartyId,
  ).proofbody;
  return {
    counterpartyId,
    senderStr,
    entityIdNorm,
    weAreStarter,
    starterInitialArguments: data.starterInitialArguments || '0x',
    disputeTimeout,
    counterProofQueued,
    initialProofbody,
    canonicalDeltaTransformerAddress: requireAccountDeltaTransformerAddress(
      env.state,
      account.state,
    ),
  };
};

const applyStartedDisputeFollowups = (
  context: FinalizedJEventContext,
  dispute: StartedDispute,
): void => {
  const {
    newState,
    blockNumber,
    accountTxs,
    outputs,
  } = context;
  const {
    counterpartyId,
    weAreStarter,
    starterInitialArguments,
    disputeTimeout,
    counterProofQueued,
    initialProofbody,
    canonicalDeltaTransformerAddress,
  } = dispute;
  const disputeSecrets = decodeDisputeStarterInitialSecrets(starterInitialArguments);
  for (const disputeSecret of disputeSecrets) {
    const hashlock = hashHtlcSecret(disputeSecret);
    applyKnownHtlcSecret(
      newState,
      accountTxs,
      outputs,
      hashlock,
      disputeSecret,
      blockNumber,
      'DisputeStarted',
    );
  }
  if (!weAreStarter && !counterProofQueued) {
    const account = newState.accounts.get(counterpartyId);
    const active = account?.activeDispute;
    if (!account || !active) {
      throw haltRuntimeFailure("CROSS_J_TARGET_ACTIVE_DISPUTE_MISSING", `CROSS_J_TARGET_ACTIVE_DISPUTE_MISSING:${counterpartyId}`);
    }
    const plan = planCrossJurisdictionTargetRecovery(
      newState,
      account,
      counterpartyId,
      [active.initialProofbodyHash],
      active.crossJurisdictionRecovery?.resultsByPullId ?? {},
    );
    if (plan) active.crossJurisdictionRecovery = plan.recovery;
  }
  // Never publish the obsolete initial body while superseding it. The selected
  // body's Source registration was queued beside the counterDispute above, so
  // Depository locks the selected nonce/hash before consuming its registry
  // evidence in the same processBatch. CounterDisputeRegistered is only an
  // idempotent confirmation path; waiting for it would lose the shorter Source
  // window.
  if (!counterProofQueued) {
    queueSourceHubClaimRegistration(
      context,
      counterpartyId,
      initialProofbody,
      canonicalDeltaTransformerAddress,
    );
  }
  // Any local dispute on a live cross-j leg starts the sibling clock too.
  queueCrossJurisdictionSiblingDisputeFanout(
    newState,
    outputs,
    counterpartyId,
    blockNumber,
  );

  addMessage(
    newState,
    `⚔️ DISPUTE ${weAreStarter ? 'STARTED' : 'vs us'} with ` +
      `${counterpartyId.slice(-4)}, timeout: unix ${disputeTimeout}`,
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
  const dispute = await initializeStartedDispute(context, data);
  if (dispute) applyStartedDisputeFollowups(context, dispute);
}

type DisputeFinalizedEventData = {
  sender: string;
  counterentity: string;
  initialNonce: string;
  initialProofbodyHash: string;
  finalProofbodyHash: string;
  finalProofbody: ProofBodyStruct;
  batchNonce?: number;
};

type CounterDisputeRegisteredEventData = {
  sender: string;
  counterentity: string;
  nonce: number;
  proposerIsLeft: boolean;
  proofbodyHash: string;
  counterProofbody: ProofBodyStruct;
};

type ResolvedDisputeAccount = ReturnType<typeof resolveDisputeAccountContext>;

const selectObservedCounterDispute = (
  context: FinalizedJEventContext,
  resolved: ResolvedDisputeAccount,
  data: CounterDisputeRegisteredEventData,
  nonce: number,
  proofbodyHash: string,
): { account: AccountReplica; proofbody: ProofBodyStruct } => {
  const account = resolved.account;
  if (!account?.activeDispute) {
    throw new Error(`COUNTER_DISPUTE_ACTIVE_ACCOUNT_MISSING:${resolved.candidateCounterpartyId}`);
  }
  installOnchainDisputeProofBody(
    account,
    data.counterProofbody,
    proofbodyHash,
    resolved.counterpartyId,
    'jEvent.counterDisputeRegistered',
  );
  const active = account.activeDispute;
  if (
    nonce < active.initialNonce ||
    (
      nonce === active.initialNonce &&
      (!data.proposerIsLeft || active.initialProposerIsLeft)
    )
  ) {
    throw new Error(`COUNTER_DISPUTE_NONCE_STALE:${nonce}:${active.initialNonce}`);
  }
  if (active.selectedCounterNonce !== undefined) {
    if (nonce < active.selectedCounterNonce) {
      throw new Error(`COUNTER_DISPUTE_NONCE_REGRESSION:${nonce}:${active.selectedCounterNonce}`);
    }
    if (
      nonce === active.selectedCounterNonce
      && data.proposerIsLeft === active.selectedCounterProposerIsLeft
      && proofbodyHash !== active.selectedCounterProofbodyHash?.toLowerCase()
    ) {
      throw new Error(`COUNTER_DISPUTE_HASH_CONFLICT:${nonce}`);
    }
    if (
      nonce === active.selectedCounterNonce
      && data.proposerIsLeft !== active.selectedCounterProposerIsLeft
      && !data.proposerIsLeft
    ) {
      throw new Error(`COUNTER_DISPUTE_ROLE_REGRESSION:${nonce}`);
    }
  }
  active.selectedCounterNonce = nonce;
  active.selectedCounterProofbodyHash = proofbodyHash;
  active.selectedCounterProposerIsLeft = data.proposerIsLeft;
  const selectedProofbody = requireFinalizedProofBodyEvidence(
    account,
    proofbodyHash,
    resolved.counterpartyId,
  ).proofbody;
  const currentRecovery = active.crossJurisdictionRecovery;
  const recoveryPlan = currentRecovery
    ? refreshCrossJurisdictionTargetRecovery(
        context.newState,
        account,
        resolved.counterpartyId,
        [proofbodyHash],
        currentRecovery,
      )
    : planCrossJurisdictionTargetRecovery(
        context.newState,
        account,
        resolved.counterpartyId,
        [proofbodyHash],
        {},
      );
  if (recoveryPlan) active.crossJurisdictionRecovery = recoveryPlan.recovery;
  else delete active.crossJurisdictionRecovery;
  return { account, proofbody: selectedProofbody };
};

const retireObservedCounterDisputeOperations = (
  context: FinalizedJEventContext,
  resolved: ResolvedDisputeAccount,
  nonce: number,
  proposerIsLeft: boolean,
  proofbodyHash: string,
): number => {
  const batchState = context.newState.jBatchState;
  const removedDraft = scrubCounterDisputesSupersededByObserved(
    batchState?.batch,
    resolved.counterpartyId,
    nonce,
    proposerIsLeft,
    proofbodyHash,
    false,
  );
  let removedRecovery = 0;
  for (const recoveryBatch of batchState?.recoveryBatches ?? []) {
    removedRecovery += scrubCounterDisputesSupersededByObserved(
      recoveryBatch,
      resolved.counterpartyId,
      nonce,
      proposerIsLeft,
      proofbodyHash,
      false,
    );
  }
  if (batchState?.recoveryBatches) {
    batchState.recoveryBatches = batchState.recoveryBatches.filter(batch => !isBatchEmpty(batch));
    if (batchState.recoveryBatches.length === 0) delete batchState.recoveryBatches;
  }
  const removedSent = retireSentBatchSupersededByCounterDispute(
    context.newState,
    resolved.counterpartyId,
    nonce,
    proposerIsLeft,
    proofbodyHash,
  );
  if (removedSent > 0) queueLocalJBatchBroadcast(context.newState, context.outputs);
  return removedDraft + removedRecovery + removedSent;
};

const applyCounterDisputeRegisteredJEvent = (context: FinalizedJEventContext): void => {
  const data = context.event.data as CounterDisputeRegisteredEventData;
  const resolved = resolveDisputeAccountContext(context.newState, data.sender, data.counterentity);
  const nonce = requireBoundaryUint(data.nonce, 'COUNTER_DISPUTE_NONCE_INVALID');
  const proofbodyHash = String(data.proofbodyHash || '').toLowerCase();
  const selected = selectObservedCounterDispute(
    context,
    resolved,
    data,
    nonce,
    proofbodyHash,
  );
  queueSourceHubClaimRegistration(
    context,
    resolved.counterpartyId,
    selected.proofbody,
    requireAccountDeltaTransformerAddress(context.env.state, selected.account.state),
  );
  const removedQueued = retireObservedCounterDisputeOperations(
    context,
    resolved,
    nonce,
    data.proposerIsLeft,
    proofbodyHash,
  );
  if (removedQueued > 0) {
    addMessage(
      context.newState,
      `🧹 Retired ${removedQueued} superseded counter-proof operation(s)`,
    );
  }
  context.dirtyAccounts.add(resolved.counterpartyId.toLowerCase());
  addMessage(
    context.newState,
    `🛡️ Counter-proof N${nonce} locked for ${resolved.counterpartyId.slice(-4)}`,
  );
};

const resolveFinalizationEvidence = (
  account: AccountReplica,
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
    throw haltRuntimeFailure("J_EVENT_DISPUTE_FINALIZATION_EVIDENCE_AMBIGUOUS", `J_EVENT_DISPUTE_FINALIZATION_EVIDENCE_AMBIGUOUS:` +
      `${senderStr}:${counterentityStr}:${String(data.initialNonce)}`);
  }
  const primary = evidence[0];
  const initialNonce = requireBoundaryUint(
    data.initialNonce,
    'J_EVENT_DISPUTE_INITIAL_NONCE_INVALID',
  );
  const evidenceSig = String(primary?.sig ?? '').toLowerCase();
  const evidenceIsUnsigned = evidenceSig === '' || evidenceSig === '0x';
  const finalProofMatchesInitial =
    finalProofbodyHash.toLowerCase() === String(data.initialProofbodyHash || '').toLowerCase();
  const active = account.activeDispute;
  let eventJNonce = initialNonce;
  if (primary) {
    const finalNonce = requireBoundaryUint(
      primary.finalNonce,
      'J_EVENT_DISPUTE_FINAL_NONCE_INVALID',
    );
    const matchesSelectedCounter =
      active?.selectedCounterNonce === finalNonce &&
      active.selectedCounterProposerIsLeft === primary.proposerIsLeft &&
      active.selectedCounterProofbodyHash?.toLowerCase() === finalProofbodyHash.toLowerCase();
    const exactInitialUnilateral =
      evidenceIsUnsigned &&
      !matchesSelectedCounter &&
      finalNonce === initialNonce &&
      primary.proposerIsLeft === active?.initialProposerIsLeft &&
      finalProofMatchesInitial;
    // Solidity adopts a selected/signed branch by the full
    // (nonce, proposer role, body hash) identity. Signature presence alone is
    // insufficient: a registered counter-proof may be executed with empty sig,
    // and equal-nonce LEFT must still replace an initial RIGHT branch.
    eventJNonce = exactInitialUnilateral
      ? incrementAccountNonce(initialNonce, 'J_EVENT_DISPUTE_FINAL_NONCE_OVERFLOW')
      : finalNonce;
  } else if (finalProofMatchesInitial) {
    eventJNonce = incrementAccountNonce(
      initialNonce,
      'J_EVENT_DISPUTE_FINAL_NONCE_OVERFLOW',
    );
  }
  return {
    evidence,
    finalizedJNonce: Math.max(Number(account.state.jNonce ?? 0), eventJNonce),
    initialNonce,
  };
};

const retireFinalizedDisputeState = (
  context: FinalizedJEventContext,
  counterpartyId: string,
  candidateCounterpartyId: string,
  senderStr: string,
  entityIdNorm: string,
  initialProofbodyHash: string,
  batchNonce: number | undefined,
): void => {
  const { newState, blockNumber } = context;
  const weAreFinalizer = senderStr === entityIdNorm;
  // `sender == self` is not sufficient: a delegated watchtower finalizes on
  // behalf of our Entity but emits no HankoBatchProcessed acknowledgement.
  // Keep a sealed batch only when this exact finalization and nonce prove the
  // event came from that batch; otherwise retire stale E5/E2 operations and
  // preserve the unrelated remainder for one deterministic rebroadcast.
  const ownSentBatchWillAck = weAreFinalizer && sentBatchOwnsDisputeFinalityAck(
    newState,
    candidateCounterpartyId,
    initialProofbodyHash,
    batchNonce,
  );
  const removedDraft = scrubDisputeFinalizationsForCounterparty(
    newState.jBatchState?.batch,
    candidateCounterpartyId,
  ) + scrubCounterDisputesForCounterparty(
    newState.jBatchState?.batch,
    candidateCounterpartyId,
  ) + scrubSourceHashLadderRegistrationsForCounterparty(
    newState.jBatchState?.batch,
    candidateCounterpartyId,
  );
  let removedRecovery = 0;
  for (const recoveryBatch of newState.jBatchState?.recoveryBatches ?? []) {
    removedRecovery += scrubDisputeFinalizationsForCounterparty(recoveryBatch, candidateCounterpartyId)
      + scrubCounterDisputesForCounterparty(recoveryBatch, candidateCounterpartyId)
      + scrubSourceHashLadderRegistrationsForCounterparty(recoveryBatch, candidateCounterpartyId);
  }
  if (newState.jBatchState?.recoveryBatches) {
    newState.jBatchState.recoveryBatches = newState.jBatchState.recoveryBatches
      .filter(batch => !isBatchEmpty(batch));
    if (newState.jBatchState.recoveryBatches.length === 0) delete newState.jBatchState.recoveryBatches;
  }
  const removedSent = ownSentBatchWillAck
    ? 0
    : retireSentBatchInvalidatedByDisputeFinality(
      newState,
      candidateCounterpartyId,
    );
  const removed = removedDraft + removedRecovery + removedSent;
  const broadcastQueued = removedSent > 0 || removedRecovery > 0
    ? queueLocalJBatchBroadcast(newState, context.outputs)
    : false;
  jEventLog.info('dispute_finalized.applied', {
    entity: shortId(entityIdNorm),
    counterparty: shortId(counterpartyId),
    sender: shortId(senderStr),
    ownSentBatchWillAck,
    block: Number(blockNumber || 0),
    removedDraft,
    removedRecovery,
    removedSent,
    broadcastQueued,
  });
  if (removed > 0) {
    addMessage(
      newState,
      `🧹 Removed ${removed} stale dispute-finalize op(s) for ${counterpartyId.slice(-4)}`,
    );
  }
};

async function applyDisputeFinalizedJEvent(
  context: FinalizedJEventContext,
  disputeFinalizationEvidence: DisputeFinalizationEvidence[],
): Promise<void> {
  const { newState, event } = context;
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
  installOnchainDisputeProofBody(
    account,
    data.finalProofbody,
    data.finalProofbodyHash,
    counterpartyId,
    'jEvent.disputeFinalized',
  );
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
  await applyResolvedDisputeFinality(
    context,
    account,
    counterpartyId,
    senderStr,
    entityIdNorm,
    data.batchNonce,
    finalizedProof,
    resolved,
  );
  retireFinalizedDisputeState(
    context,
    counterpartyId,
    candidateCounterpartyId,
    senderStr,
    entityIdNorm,
    data.initialProofbodyHash,
    data.batchNonce,
  );
}

const applyResolvedDisputeFinality = async (
  context: FinalizedJEventContext,
  account: AccountReplica,
  counterpartyId: string,
  senderStr: string,
  entityIdNorm: string,
  batchNonce: number | undefined,
  finalizedProof: ReturnType<typeof requireFinalizedProofBodyEvidence>,
  resolved: ReturnType<typeof resolveFinalizationEvidence>,
): Promise<void> => {
  const { accountConsensusContext, newState, dirtyAccounts } = context;
  syncJBatchEntityNonceFromEvent(newState, senderStr, entityIdNorm, batchNonce);
  dirtyAccounts.add(counterpartyId.toLowerCase());
  // A finalized dispute changes the authoritative Account epoch. Any
  // settlement drafted or sealed against the previous epoch is unusable even
  // when its numeric nonce is higher; retaining it would strand holds or let a
  // delayed retry resurrect pre-dispute state.
  // Capture exact Pull economics before Account external finality retires the
  // active dispute clock and signed ProofBody evidence.
  const crossJSettlements = resolveCrossJurisdictionFinalitySettlements(
    newState,
    account,
    entityIdNorm,
    counterpartyId,
    finalizedProof.proofbody,
    requireAccountDeltaTransformerAddress(context.env.state, account.state),
  );
  const accountInput = createAccountDisputeFinalityInput(
    account.state,
    entityIdNorm,
    resolved.finalizedJNonce,
    finalizedProof.tokenIds,
  );
  const accountInputResult = await applyAccountInput(
    accountConsensusContext,
    account,
    accountInput,
  );
  if (!accountInputResult.ok || !accountInputResult.externalFinality) {
    throw new Error(
      `ACCOUNT_DISPUTE_FINALITY_INPUT_FAILED:${counterpartyId}:` +
      `${accountInputFailureMessage(accountInputResult)}`,
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
  terminalizeCrossJurisdictionRoutesOnFinality(newState, crossJSettlements);
};

type HashLadderRevealRegisteredEventData = {
  entity: string;
  counterpartyEntity: string;
  ladderHash: string;
  fillRatio: number;
  fullSecret: string;
  reveals: [string, string, string, string];
  targetRole: boolean;
  revealedAt: number;
};

/**
 * Resolve economics before Account finality retires the active clock/body.
 * The exact signed Pull contributes claimedRatio; only a timestamped record
 * inside this beneficiary's [S,S+W] interval may raise it. Queue latches and
 * raw event ratios are deliberately not settlement authority.
 */
type CrossJurisdictionFinalitySettlement = Readonly<{
  route: CrossJurisdictionSwapRoute;
  settledRatio: number;
}>;

const resolveCrossJurisdictionFinalitySettlements = (
  state: EntityState,
  account: AccountReplica,
  entityId: string,
  counterpartyId: string,
  finalProofbody: ProofBodyStruct,
  canonicalDeltaTransformerAddress: string,
): CrossJurisdictionFinalitySettlement[] => {
  const self = entityId.toLowerCase();
  const counterparty = counterpartyId.toLowerCase();
  const localStack = state.config.jurisdiction
    ? getJurisdictionStackId(state.config.jurisdiction)
    : undefined;
  const settlements: CrossJurisdictionFinalitySettlement[] = [];
  for (const route of state.crossJurisdictionSwaps?.values?.() ?? []) {
    if (isCrossJurisdictionTerminalStatus(route.status)) continue;
    const role = resolveFinalizedCrossJurisdictionRouteLeg({
      route,
      self,
      counterparty,
      ...(localStack ? { localStack } : {}),
    });
    if (!role) continue;
    const expectedPull = role === 'source' ? route.sourcePull : route.targetPull;
    if (!expectedPull) {
      // A raw intent is persisted before either bilateral Pull exists. If an
      // older Account dispute finalizes during that short preparation window,
      // the intent has no locked exposure to settle and must be retired rather
      // than fail-stopping authoritative J history. Missing Pulls after intent
      // are corruption and remain loud.
      if (route.status === 'intent' && !route.sourcePull && !route.targetPull) {
        settlements.push({ route, settledRatio: 0 });
        continue;
      }
      throw haltRuntimeFailure("CROSS_J_FINALITY_PULL_MISSING", `CROSS_J_FINALITY_PULL_MISSING:${route.orderId}:${role}`);
    }
    const record = role === 'source' ? route.sourceRegistryRecord : route.targetRegistryRecord;
    const signedPull = findExactSignedProofBodyPull(
      finalProofbody,
      expectedPull,
      role === 'target',
      canonicalDeltaTransformerAddress,
    );
    settlements.push({
      route,
      // A valid older bilateral proof may predate a route that exists only in
      // newer local state. On-chain finality then never executed that Pull.
      // Retire the local route at zero instead of fail-stopping the watcher;
      // malformed/ambiguous canonical clauses still throw above.
      settledRatio: signedPull
        ? resolveFinalizedPullFillRatio({
            account,
            proofbody: finalProofbody,
            canonicalDeltaTransformerAddress,
            expectedPull,
            targetRole: role === 'target',
            ...(record ? { record } : {}),
          })
        : 0,
    });
  }
  return settlements;
};

export const terminalizeCrossJurisdictionRoutesOnFinality = (
  newState: EntityState,
  settlements: readonly CrossJurisdictionFinalitySettlement[],
): void => {
  for (const { route, settledRatio } of settlements) {
    // Depository emits DisputeFinalized before HankoBatchProcessed for the
    // same processBatch transaction. Registry evidence remains independently
    // publishable, but this route has no future financial consumer after
    // finality, so retaining deferred work would be useless state and gas.
    delete route.pendingSourceRegistryReveal;
    delete route.pendingTargetRegistryReveal;
    if (route.status === 'intent' && !route.sourcePull && !route.targetPull) {
      transitionCrossJurisdictionRouteStatus(
        route,
        'cancelled',
        Number(newState.timestamp || 0),
      );
      newState.crossJurisdictionSwaps!.set(route.orderId, route);
      addMessage(newState, `🌉 Cross-j route ${route.orderId} cancelled before Pull lock on Account finality`);
      continue;
    }
    const terminal = transitionTargetLegTerminal(
      route,
      Number(newState.timestamp || 0),
      settledRatio,
    );
    newState.crossJurisdictionSwaps!.set(route.orderId, route);
    addMessage(newState, `🌉 Cross-j route ${route.orderId} terminal after dispute finality: ${terminal}`);
  }
};

const updateRegistryRecord = (
  existing: HashLadderRegistryRecord | undefined,
  data: HashLadderRevealRegisteredEventData,
  orderId: string,
): HashLadderRegistryRecord => {
  const next = { fillRatio: Math.floor(Number(data.fillRatio)), revealedAt: Number(data.revealedAt) };
  if (!Number.isSafeInteger(next.revealedAt) || next.revealedAt <= 0) {
    throw haltRuntimeFailure("CROSS_J_REGISTRY_REVEALED_AT_INVALID", `CROSS_J_REGISTRY_REVEALED_AT_INVALID:${orderId}:${String(data.revealedAt)}`);
  }
  if (!existing) return next;
  if (existing.fillRatio === next.fillRatio) {
    if (!data.targetRole && existing.revealedAt !== next.revealedAt) {
      throw haltRuntimeFailure("CROSS_J_REGISTRY_RETRY_TIME_CONFLICT", `CROSS_J_REGISTRY_RETRY_TIME_CONFLICT:${orderId}`);
    }
    if (next.revealedAt < existing.revealedAt) {
      throw haltRuntimeFailure("CROSS_J_REGISTRY_RECORD_TIME_REGRESSION", `CROSS_J_REGISTRY_RECORD_TIME_REGRESSION:${orderId}`);
    }
    // Target exact-ratio publication intentionally refreshes its timestamp.
    // This lets evidence published before a target dispute be republished
    // inside the signed target window without changing the claimed ratio.
    return next.revealedAt === existing.revealedAt ? existing : next;
  }
  if (!data.targetRole || next.fillRatio < existing.fillRatio || next.revealedAt < existing.revealedAt) {
    throw haltRuntimeFailure("CROSS_J_REGISTRY_RECORD_CONFLICT", `CROSS_J_REGISTRY_RECORD_CONFLICT:${orderId}:${existing.fillRatio}:${next.fillRatio}`);
  }
  return next;
};

/**
 * The hash-ladder reveal registry event — the only cross-j settlement trigger.
 * Roles, self-selected per entity:
 *  1. source-user lane: emit the port instruction to the target user.
 *  2. registering entity: confirm a pending port result on its own dispute.
 *  3. every route mirror: store the raw timestamped registry record; latch the
 *     queue-only role-specific fill-ratio latch when this entity was writer.
 *
 * Invariant: the role-specific fill-ratio field means "my Depository slot is
 * already written" (exact-once queue guard). Source and target pulls share the
 * same ladderHash — latching from a *foreign* entity's reveal (e.g. hub) would
 * make the target-user salvage return already-queued and skip the port write,
 * settling the target leg at 0 on the honest path. claimedRatio remains only
 * the signed close-proof value; observed records never overwrite it.
 */
const applyHashLadderRevealRegisteredJEvent = (context: FinalizedJEventContext): void => {
  const { newState, outputs, blockNumber, dirtyAccounts } = context;
  const data = context.event.data as HashLadderRevealRegisteredEventData;
  queueCrossJurisdictionRevealPorts(newState, outputs, data, Number(blockNumber || 0));

  const self = String(newState.entityId || '').toLowerCase();
  const ladderHash = String(data.ladderHash || '').toLowerCase();
  const writerIsSelf = String(data.entity || '').toLowerCase() === self;
  if (writerIsSelf) {
    for (const [accountId, account] of newState.accounts.entries()) {
      if (String(accountId).toLowerCase() !== String(data.counterpartyEntity).toLowerCase()) continue;
      const recovery = account.activeDispute?.crossJurisdictionRecovery;
      if (!recovery) continue;
      for (const pullId of recovery.requiredPullIds) {
        if (Object.hasOwn(recovery.resultsByPullId, pullId)) continue;
        const route = [...(newState.crossJurisdictionSwaps?.values?.() ?? [])]
          .find(candidate =>
            candidate.targetPull?.pullId === pullId || candidate.sourcePull?.pullId === pullId,
          );
        if (!route) continue;
        const pull = route.targetPull?.pullId === pullId ? route.targetPull : route.sourcePull;
        if (!pull || ladderHashForPull(pull) !== ladderHash) continue;
        const expectedTargetRole = route.targetPull?.pullId === pullId;
        if (data.targetRole !== expectedTargetRole) continue;
        recovery.resultsByPullId = { ...recovery.resultsByPullId, [pullId]: String(data.fillRatio) };
        dirtyAccounts.add(String(accountId).toLowerCase());
      }
    }
  }

  for (const route of newState.crossJurisdictionSwaps?.values?.() ?? []) {
    if (isCrossJurisdictionTerminalStatus(route.status)) continue;
    const rolePull = data.targetRole ? route.targetPull : route.sourcePull;
    const roleLeg = data.targetRole ? route.target : route.source;
    const matches = Boolean(
      rolePull
      && ladderHashForPull(rolePull) === ladderHash
      && String(roleLeg.counterpartyEntityId).toLowerCase() === String(data.entity).toLowerCase()
      && String(roleLeg.entityId).toLowerCase() === String(data.counterpartyEntity).toLowerCase()
    );
    if (!matches) continue;
    const observed = Math.floor(Number(data.fillRatio));
    let dirty = false;
    // Own-slot latch only — foreign reveals must not block our port/claim queue.
    if (writerIsSelf) {
      if (data.targetRole) {
        route.targetRegistryFillRatio = observed;
        dirty = true;
      } else if (route.sourceRegistryFillRatio === undefined) {
        route.sourceRegistryFillRatio = observed;
        dirty = true;
      } else if (route.sourceRegistryFillRatio !== observed) {
        throw haltRuntimeFailure("CROSS_J_SOURCE_REGISTRY_CONFLICT", `CROSS_J_SOURCE_REGISTRY_CONFLICT:${route.orderId}:` +
          `${route.sourceRegistryFillRatio}:${observed}`);
      }
    }
    if (data.targetRole) {
      const next = updateRegistryRecord(route.targetRegistryRecord, data, route.orderId);
      if (next !== route.targetRegistryRecord) route.targetRegistryRecord = next;
      dirty = true;
    } else {
      const next = updateRegistryRecord(route.sourceRegistryRecord, data, route.orderId);
      if (next !== route.sourceRegistryRecord) route.sourceRegistryRecord = next;
      dirty = true;
    }
    if (dirty) newState.crossJurisdictionSwaps!.set(route.orderId, route);
  }
};

/**
 * A source hub can claim the source pull on-chain only by publishing the
 * reveal: the registry write is the claim's precondition and simultaneously
 * the user-side port source. Queue it as soon as a dispute touching the pull
 * is observed, at exactly the committed fill ratio.
 */
const queueSourceHubClaimRegistration = (
  context: FinalizedJEventContext,
  counterpartyId: string,
  signedProofbody: ProofBodyStruct,
  canonicalDeltaTransformerAddress: string,
): void => {
  const { newState, env, outputs } = context;
  for (const claim of queueSourceHubClaimRegistrationsForAccount(
    newState,
    counterpartyId,
    env.runtimeSeed,
    signedProofbody,
    canonicalDeltaTransformerAddress,
  )) {
    const { fillRatio: ratio, result: queued } = claim;
    if (queued !== 'queued' && queued !== 'deferred-batch-pending') continue;
    queueLocalJBatchBroadcast(newState, outputs);
    addMessage(
      newState,
      queued === 'queued'
        ? `🌉 Cross-j claim ${claim.routeId}: registering source reveal ratio ${ratio}`
        : `⏳ Cross-j claim ${claim.routeId}: reveal deferred until disputeFinalizations leave the jBatch`,
    );
  }
};

async function applyFinalizedJEvent(
  entityState: EntityState,
  event: JurisdictionEvent,
  env: EntityRuntimeContext,
  accountConsensusContext: AccountConsensusContext,
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
    accountConsensusContext,
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
    case 'CounterDisputeRegistered':
      applyCounterDisputeRegisteredJEvent(context);
      break;
    case 'DisputeFinalized':
      await applyDisputeFinalizedJEvent(context, disputeFinalizationEvidence);
      break;
    case 'HashLadderRevealRegistered':
      applyHashLadderRevealRegisteredJEvent(context);
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
