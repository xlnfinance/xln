import { FailureDispositionError, haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

/**
 * Entity consensus: validator replicas agree on entity frames, then route
 * committed account/J-layer side effects back into the runtime.
 */

import { accountInputAck, accountInputProposal, accountInputReferenceHeight } from '../../../account/consensus/flush';
import { proposeAccountFrame } from '../../../account/consensus/proposal/propose';
import { isProposedAccountFrame } from '../../../account/consensus/result';
import { getAccountJClaimNodeStore } from '../../account/account-j-claim-node-store';
import {
  assertCanonicalSettlementWorkspace,
  hasPendingSettlementTransition,
} from '../../../account/tx/handlers/settlement/transition';
import { markCrossJurisdictionBookAdmissionResolving } from '../../../extensions/cross-j/orderbook';
import { logError, shortHash, shortId, shortOrder } from '../../../support/logger';
import { cumulativeMarksToPhases } from '../../../support/performance/profile';
import { countOp } from '../../../support/performance/op-counters';
import { assertEntityFrameJRangeBudget } from '../../../jurisdiction/machine/range-budget';
import { replaceOrderbookPair, type OrderbookExtState } from '../../../orderbook';
import {
  applyCommittedSwapCancelsToOrderbook,
  crossJurisdictionBookOwnerRef,
  deterministicEntityTimestamp,
  normalizeEntityRef,
} from '../../../orderbook/cross-j/orderbook';
import { normalizeSwapOfferForOrderbook, swapKey, type WorkingOrderbookOffer } from '../../../orderbook/swap-execution';
import { mergeStorageOverlayRecords } from '../../../protocol/state/overlay';
import { compareStableText, safeStringify } from '../../../protocol/serialization';
import { getNextSettlementNonce } from '../../../protocol/settlement/operations';
import { assertScheduledWakeFrameOrder } from '../../scheduler/wake/scheduled-wake-validation';
import { createEntityFrameCandidateState } from '../../state-clone';
import { getEntityAccountForWrite } from '../../state/persistent-account-map';
import { getAccountPerspective } from '../../../account/state/perspective';
import { emitScopedEvents } from '../../../support/scoped-events';
import { addMessages, clearEntityFrameEvents, readEntityFrameEvents } from '../../frame-events';
import type { AccountPeerInput, AccountReplica, AccountTx, RuntimeOverlayRecord } from '../../../types/account';
import type { EntityCandidateEffect, EntityFrameEvent, EntityOutput, EntityState, HashType } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { AccountConsensusContext } from '../../../account/consensus/context';
import type { JInput } from '../../../jurisdiction/machine/input';
import type { EntityTx } from '../../../types/entity-tx';
import type { AccountJClaimNode, AccountJClaimNodeChanges, AccountJClaimNodeStore } from '../../../types/finance/account-j-claims';
import { getPerfMs } from '../../../support/time';
import {
  assertRuntimeOutputAuthorization,
  isCollectiveEntityActionTx,
  isIndividualEntityCommandTx,
} from '../../auth/authorization';
import {
  advanceEntityCommandNonce,
  assertSignedEntityCommand,
  getEntityCommandDisposition,
  normalizeEntityCommandNonceBoard,
} from '../../command';
import { isEntityCommandForbiddenTx } from '../../command/command-codec';
import {
  applyConsumptionOutput,
  createEmptyConsumptionAccumulator,
} from '../../consumption/consumption-accumulator';
import { type ConsumptionNodeChanges } from '../../consumption/consumption-store';
import {
  entityTxContainsAccountTransition,
  entityTxContainsCrossJSetup,
  selectCrossJOpeningAccountProposalTxs,
} from '../../transition/cross-j-proposer-materialization';
import { initCrontab } from '../../scheduler';
import {
  applyEntityTx,
  type ApplyEntityTxResult,
} from '../../tx/apply';
import {
  processOrderbookCancels,
  processOrderbookSwaps,
  routeRemoteCrossJurisdictionBookCancels,
  type SwapCancelRequestEvent,
  type SwapOfferEvent,
} from '../../tx/handlers/account';
import { buildSettlementSealDraft } from '../../tx/handlers/payments/settle';
import { assertOriginatedHtlcRoutesHaveLiveLocks, terminateHtlcRoute } from '../../tx/j-events-htlc/route-lifecycle';
import { hasInboundHtlcRoute } from '../../htlc/route-views';
import { MalformedEntityFrameInputError } from '../../tx/processing/invariant-errors';
import { normalizeEntityProposalBoard } from '../../tx/processing/proposals';
import { accountHasProposableMempool } from '../account/mempool-eligibility';
import { traceAccountFlushHop } from '../../../support/performance/account-delivery-trace';
import {
  getProposableAccountIds,
  getQueuedAccountIds,
} from '../account/work-index';
import { applyAccountInput } from '../../../account/consensus';
import { createAccountConsensusContext } from '../../account/account-consensus-context';
import { assertEntityFrameTxByteBudget } from '../frame';
import { assignCertifiedOutputIdentities, verifyCertifiedEntityOutput } from '../output/certification';
import { invalidateEntityAccountCommitment } from '../state-root';
import type { ApplyEntityTxsInOrderContext } from './application-types';
import { validateEntityInfraContext } from './infra-context-validation';
import { filterEntityFrameBroadcastContinuations } from '../j-prefix/broadcast-continuation';
import { applyEntityTxReturnedEffects } from './tx-effects';
import { selectSettlementContinuation } from '../account/settlement-continuation';
import {
  buildChangedEntityProfileHashToSign,
  computeEntityProfileHash,
} from '../../profile/profile-descriptor';

import {
  entityFrameProfileEnabled,
  entityFrameSlowMs,
} from './profile';
import { entityLog } from '../entity-log';
import { buildConsumptionOutputIdentity } from '../output/consumption';
import { admitOrderbookOfferForMatching } from '../account/orderbook-admission';
import {
  buildCrossJurisdictionFillNoticeOutput,
  drainCommittedCrossJurisdictionCancelAcks,
  drainPendingCrossJurisdictionFillAcks,
  ownsSourceHubRouteForFillAck,
  stashPendingCrossJurisdictionFillAck,
} from '../account/cross-j-fill-ack';
import { appendCrossJurisdictionTargetProgressAfterAdmission } from '../../tx/j-events-htlc/cross-j-outputs';
import { isSelfBoardAuthorityTransitionFrame } from '../proposal/policy';
import { getBoardHandoverFrameConfig } from '../authority/board-handover';
import { admitOrderbookAccountTxBatch } from '../account/orderbook-account-admission';
import { scheduleChangedAccountBoardReseals } from '../../scheduler/board-reseal-hook';
import { captureAccountBoardResealEvidence } from '../../tx/state-effects/board-rotation-reseal';
import {
  collectTouchedAccountIds,
  copyProposableAccounts,
  dirtyAccountIdsFromState,
} from '../account/touched-accounts';
import {
  createCanonicalAccountWorklist,
  markProposableAccount,
  setProposableAccountForce,
  type ProposableAccountMap,
} from '../account/canonical-worklist';
import { preparedHtlcBindingKey } from '../../../types/entity/htlc-infra-context';
import { EntityCandidateMap } from '../../state/candidate-map';

const recordFrameAccountChange = (
  storageChanges: RuntimeOverlayRecord[],
  entityId: string,
  counterpartyId: string,
): void => {
  storageChanges.push({ family: 'account', entityId, counterpartyId });
};

const recordFrameBookChange = (storageChanges: RuntimeOverlayRecord[], entityId: string, pairId: string): void => {
  storageChanges.push({ family: 'book', entityId, pairId });
};

const applyRuntimeOutput = async (
  context: ApplyEntityTxsInOrderContext,
  currentEntityState: EntityState,
  tx: Extract<EntityTx, { type: 'runtimeOutput' }>,
): Promise<EntityState> => {
  if (tx.data.protocol !== 'cross-j') throw new Error(`RUNTIME_OUTPUT_PROTOCOL_INVALID:${tx.data.protocol}`);
  assertRuntimeOutputAuthorization(
    tx.data.sourceEntityId,
    tx.data.targetEntityId,
    tx.data.entityTxs,
    currentEntityState,
  );
  return applyEntityTxsInOrder({
    ...context,
    entityTxs: tx.data.entityTxs,
    currentEntityState,
    authorizedRuntimeOutput: true,
  });
};

const applyCertifiedConsensusOutput = async (
  context: ApplyEntityTxsInOrderContext,
  currentEntityState: EntityState,
  tx: Extract<EntityTx, { type: 'consensusOutput' }>,
): Promise<EntityState> => {
  const verified = context.verifiedCertifiedOutputs.get(tx) ??
    await verifyCertifiedEntityOutput(context.env, currentEntityState, tx);
  const { origin, targetEntityId, entityTxs, outputHash } = verified;

  const identity = buildConsumptionOutputIdentity(origin, targetEntityId, outputHash, tx.data.outputHanko);
  const consumption = applyConsumptionOutput(
    currentEntityState.consumptionAccumulator ?? createEmptyConsumptionAccumulator(),
    identity,
    tx.data.consumptionProof,
  );
  if (consumption.status === 'idempotent') {
    return currentEntityState;
  }
  if (consumption.status === 'stale') {
    return currentEntityState;
  }
  if (consumption.status === 'gap') {
    throw new Error(
      `CONSENSUS_OUTPUT_SEQUENCE_GAP:source=${origin.sourceEntityId}:lane=${origin.lane}:` +
        `received=${origin.sequence}`,
    );
  }
  for (const { hash, node } of consumption.newNodes) {
    context.consumptionNewNodes.set(hash, node);
    context.consumptionReplacedNodeHashes.delete(hash);
  }
  for (const hash of consumption.replacedNodeHashes) {
    if (!context.consumptionNewNodes.delete(hash)) {
      context.consumptionReplacedNodeHashes.add(hash);
    }
  }
  if (consumption.status === 'quarantined') {
    if (consumption.newNodes.length > 0) {
      logError('FRAME_CONSENSUS', 'Certified output relationship quarantined after current-sequence equivocation', {
        sourceEntityId: origin.sourceEntityId,
        targetEntityId,
        lane: origin.lane,
        sequence: origin.sequence.toString(),
        acceptedRoot: currentEntityState.consumptionAccumulator?.root ?? 'empty',
        quarantineRoot: consumption.state.root,
      });
      return { ...currentEntityState, consumptionAccumulator: consumption.state };
    }
    throw new Error(
      `CONSENSUS_OUTPUT_RELATIONSHIP_QUARANTINED:${origin.sourceEntityId}:${targetEntityId}:${origin.lane}`,
    );
  }

  const applied = await applyEntityTxsInOrder({
    ...context,
    entityTxs,
    currentEntityState,
    // The outer source certificate authorizes generic cross-Entity effects.
    authorizedCertifiedOutput: true,
  });
  return { ...applied, consumptionAccumulator: consumption.state };
};

const applyNestedEntityTx = async (
  context: ApplyEntityTxsInOrderContext,
  state: EntityState,
  tx: EntityTx,
): Promise<{ handled: boolean; state: EntityState }> => {
  if (tx.type === 'runtimeOutput') {
    return { handled: true, state: await applyRuntimeOutput(context, state, tx) };
  }
  if (tx.type === 'consensusOutput') {
    return { handled: true, state: await applyCertifiedConsensusOutput(context, state, tx) };
  }
  if (tx.type !== 'entityCommand') return { handled: false, state };

  const command = assertSignedEntityCommand(context.env, state, tx.data);
  if (getEntityCommandDisposition(state, command) !== 'next') {
    // Exact retries and cancelled slots (not-next nonce) both advance nothing;
    // a cancelled command's nested txs must not execute against the standing
    // committed slot.
    return { handled: true, state };
  }
  const applied = await applyEntityTxsInOrder({
    ...context,
    entityTxs: command.txs,
    currentEntityState: state,
    authorizedCommand: true,
  });
  return {
    handled: true,
    state: advanceEntityCommandNonce(applied, command),
  };
};

const assertEntityTxAuthorization = (
  context: ApplyEntityTxsInOrderContext,
  tx: EntityTx,
): void => {
  if (isEntityCommandForbiddenTx(tx)) return;
  // Salvage is derived from certified source-dispute evidence and mirrored by
  // Runtime inside one WAL candidate. A signed user/board command is not an
  // equivalent lane: it could update one sibling or start a target dispute
  // without the source J event that authorizes the pull reveal.
  if (tx.type === 'crossJurisdictionSalvage' && !context.authorizedRuntimeOutput) {
    throw haltRuntimeFailure("CROSS_J_SALVAGE_RUNTIME_OUTPUT_REQUIRED", 'CROSS_J_SALVAGE_RUNTIME_OUTPUT_REQUIRED');
  }
  if (context.authorizedCommand && !isIndividualEntityCommandTx(tx)) {
    throw new Error(`ENTITY_COMMAND_COLLECTIVE_ACTION_REQUIRES_PROPOSAL:${tx.type}`);
  }
  if (context.authorizedCollective && !isCollectiveEntityActionTx(tx)) {
    throw new Error(`ENTITY_COLLECTIVE_ACTION_TX_FORBIDDEN:${tx.type}`);
  }
  if (
    !context.authorizedCommand &&
    !context.authorizedCollective &&
    !context.authorizedCertifiedOutput &&
    !context.authorizedRuntimeOutput
  ) {
    throw new Error(`ENTITY_COMMAND_REQUIRED:${tx.type}`);
  }
};

const collectEntityTxResult = (
  context: ApplyEntityTxsInOrderContext,
  result: ApplyEntityTxResult,
): void => {
  context.storageChanges.push(...result.storageChanges);
  context.candidateEffects.push(...result.candidateEffects);
  for (const { hash, node } of result.accountJClaimNodeChanges?.newNodes ?? []) {
    context.accountJClaimNewNodes.set(hash, node);
    context.accountJClaimReplacedNodeHashes.delete(hash);
  }
  for (const hash of result.accountJClaimNodeChanges?.replacedNodeHashes ?? []) {
    if (!context.accountJClaimNewNodes.delete(hash)) {
      context.accountJClaimReplacedNodeHashes.add(hash);
    }
  }
  if (result.accountInputWork) {
    const accountId = result.accountInputWork.accountId.toLowerCase();
    // This is Channel.ts's one flushable lane with an explicit force bit.
    // A later pure ACK sets false and therefore cannot trigger an ACK loop.
    setProposableAccountForce(
      context.proposableAccounts,
      accountId,
      result.accountInputWork.force,
    );
    const account = result.newState.accounts.get(accountId);
    if (!account) throw new Error(`ACCOUNT_INPUT_WORK_ACCOUNT_MISSING:${accountId}`);
    if (result.accountInputWork.force) {
      traceAccountFlushHop(
        'entity-response-required',
        result.newState.entityId,
        accountId,
        account,
        undefined,
      );
    }
  }
  context.allOutputs.push(...filterEntityFrameBroadcastContinuations(
    context.allOutputs,
    result.outputs,
    result.newState.entityId,
    context.entityTxs.some(tx => tx.type === 'j_broadcast'),
    result.newState.jBatchState?.sentBatch !== undefined,
  ));
  if (result.jOutputs) context.allJOutputs.push(...result.jOutputs);
  if (result.hashesToSign?.length) {
    for (const hashInfo of result.hashesToSign) {
      const existing = context.collectedHashManifest.get(hashInfo.hash);
      if (existing?.type === hashInfo.type && existing.context === hashInfo.context) {
        // At-least-once transport may place several
        // certified copies of one already-committed frame in the same Entity
        // candidate. The final response map already emits one response per
        // bilateral lane; request its exact witness once as well. A same hash
        // under any other type/context is retained and rejected later by the
        // manifest collision guard.
        countOp('entity.hash.exactDuplicateCollapsed');
        continue;
      }
      context.collectedHashes.push(hashInfo);
      if (!existing) {
        context.collectedHashManifest.set(hashInfo.hash, {
          type: hashInfo.type,
          context: hashInfo.context,
        });
      }
    }
  }
};

const applyRegularEntityTx = async (
  context: ApplyEntityTxsInOrderContext,
  state: EntityState,
  tx: EntityTx,
  manualBroadcastInInput: boolean,
): Promise<EntityState> => {
  assertEntityTxAuthorization(context, tx);
  const txProfileStartMs = getPerfMs();
  const result = await applyEntityTx(context.env, state, tx, {
    infraContext: context.entityContext,
    preparedHtlcEntriesByBinding: context.preparedHtlcEntriesByBinding,
    mutableFrameState: true,
    manualBroadcastInInput,
    accountJClaimNodeStore: context.accountJClaimNodeStore,
    accountConsensusContext: context.accountConsensusContext,
    ...(context.authorizedBoardHandoverConfig
      ? { authorizedBoardHandoverConfig: context.authorizedBoardHandoverConfig }
      : {}),
  });
  if (result.skippedError) {
    throw new MalformedEntityFrameInputError(String(tx.type), result.skippedError);
  }

  let nextState = result.newState;
  collectEntityTxResult(context, result);
  if (result.approvedEntityTxs?.length) {
    nextState = await applyEntityTxsInOrder({
      ...context,
      entityTxs: result.approvedEntityTxs,
      currentEntityState: nextState,
      authorizedCommand: undefined,
      authorizedCollective: true,
      authorizedCertifiedOutput: undefined,
      authorizedRuntimeOutput: undefined,
    });
  }
  await applyEntityTxReturnedEffects(context, nextState, tx, txProfileStartMs, {
    ...(result.accountTxs ? { accountTxs: result.accountTxs } : {}),
    ...(result.swapOffersCreated ? { swapOffersCreated: result.swapOffersCreated } : {}),
    ...(result.swapCancelRequests ? { swapCancelRequests: result.swapCancelRequests } : {}),
    ...(result.swapOffersCancelled ? { swapOffersCancelled: result.swapOffersCancelled } : {}),
  });
  return nextState;
};

export const assertEntityJBroadcastOrder = (entityTxs: readonly EntityTx[]): boolean => {
  const broadcastIndex = entityTxs.findIndex(tx => tx.type === 'j_broadcast');
  const manualBroadcastInInput = broadcastIndex >= 0;
  if (manualBroadcastInInput) {
    const broadcastCount = entityTxs.filter(tx => tx.type === 'j_broadcast').length;
    if (broadcastCount !== 1) {
      throw new MalformedEntityFrameInputError('j_broadcast', 'ENTITY_J_BROADCAST_DUPLICATE');
    }
    if (broadcastIndex !== entityTxs.length - 1) {
      throw new MalformedEntityFrameInputError('j_broadcast', 'ENTITY_J_BROADCAST_MUST_BE_LAST');
    }
  }
  return manualBroadcastInInput;
};

async function applyEntityTxsInOrder(context: ApplyEntityTxsInOrderContext): Promise<EntityState> {
  let currentEntityState = context.currentEntityState;
  const manualBroadcastInInput = assertEntityJBroadcastOrder(context.entityTxs);

  // Preserve WAL transaction order exactly during live processing and replay.
  // Reordering batched txs can change bilateral account state transitions
  // (e.g., openAccount + accountInput ACK in same frame).
  for (const entityTx of context.entityTxs) {
    try {
      const nested = await applyNestedEntityTx(context, currentEntityState, entityTx);
      if (nested.handled) {
        currentEntityState = nested.state;
        continue;
      }
      currentEntityState = await applyRegularEntityTx(
        context,
        currentEntityState,
        entityTx,
        manualBroadcastInInput,
      );
    } catch (error) {
      // Bind the rejection to the outermost frame tx (a certified wrapper's
      // inner failure names the wrapper) so a mempool proposer can evict it.
      if (error instanceof MalformedEntityFrameInputError && error.frameTx === undefined) {
        error.frameTx = entityTx;
      }
      throw error;
    }
  }
  return currentEntityState;
}

const materializeSettlementContinuation = async (
  context: ApplyEntityTxsInOrderContext,
  state: EntityState,
): Promise<EntityState> => {
  const disposition = selectSettlementContinuation(state);
  if (disposition.kind === 'none' || disposition.kind === 'wait') return state;
  if (disposition.kind === 'discard') {
    state.settlementContinuations?.delete(disposition.counterpartyId);
    addMessages(state, [
      `Settlement continuation cleared: ${disposition.reason.replaceAll('_', ' ')}`,
    ]);
    return state;
  }
  const nextState = await applyEntityTxsInOrder({
    ...context,
    entityTxs: disposition.txs,
    currentEntityState: state,
    authorizedCommand: undefined,
    authorizedCollective: true,
    authorizedCertifiedOutput: undefined,
    authorizedRuntimeOutput: undefined,
  });
  // Delete only after every derived transaction succeeded. Multi-signer
  // candidates discard the touched-state overlay on failure; single-signer
  // Runtimes halt and reload their pre-frame WAL truth.
  nextState.settlementContinuations?.delete(disposition.counterpartyId);
  return nextState;
};

type ProposePendingAccountFramesContext = {
  env: EntityRuntimeContext;
  accountConsensusContext: AccountConsensusContext;
  currentEntityState: EntityState;
  proposableAccounts: ProposableAccountMap;
  allOutputs: EntityOutput[];
  collectedHashes: Array<{ hash: string; type: HashType; context: string }>;
  accountJClaimNodeStore: AccountJClaimNodeStore;
  storageChanges: RuntimeOverlayRecord[];
};

async function materializeDeferredSettlementApprovals(
  env: EntityRuntimeContext,
  accountConsensusContext: AccountConsensusContext,
  state: EntityState,
  proposableAccounts: ProposableAccountMap,
  collectedHashes: Array<{ hash: string; type: HashType; context: string }>,
  storageChanges: RuntimeOverlayRecord[],
): Promise<void> {
  const deferred = state.deferredAccountProposals;
  if (!deferred || deferred.size === 0) return;
  for (const [accountId, approvedHash] of [...deferred.entries()].sort(([left], [right]) =>
    compareStableText(left, right),
  )) {
    const visible = state.accounts.get(accountId);
    if (!visible) throw new Error(`SETTLEMENT_DEFERRED_ACCOUNT_MISSING:${accountId}`);
    if (visible.pendingFrame || hasPendingSettlementTransition(visible)) continue;
    const workspace = visible.state.settlementWorkspace;
    const currentHash = workspace ? assertCanonicalSettlementWorkspace(visible.state, workspace) : undefined;
    if (!workspace || currentHash !== approvedHash) {
      deferred.delete(accountId);
      entityLog.warn('settlement.approval_invalidated', {
        account: shortId(accountId),
        approvedHash: shortHash(approvedHash),
        currentHash: currentHash ? shortHash(currentHash) : 'missing',
      });
      addMessages(state, [`⚠️ Settlement approval expired because the workspace changed`]);
      continue;
    }
    const peerSealPinsAccountState = Boolean(
      workspace.settlementHash || workspace.leftHanko || workspace.rightHanko || workspace.postSettlementDisputeProof,
    );
    // An unsigned workspace must wait for ordinary Account work to drain: that
    // work can change the post-settlement proof we are about to sign. Once a
    // peer seal pins the proof, however, ordinary financial txs are frozen and
    // cannot drain. Waiting for an empty mempool then deadlocks the only exact
    // counter-seal that can finalize the settlement. Keep those txs queued;
    // proposeAccountFrame skips them and applies the counter-seal unchanged.
    if (visible.mempool.length > 0 && !peerSealPinsAccountState) continue;
    const account = getEntityAccountForWrite(state.accounts, accountId);
    if (!account) throw new Error(`SETTLEMENT_DEFERRED_ACCOUNT_MISSING:${accountId}`);
    const draft = buildSettlementSealDraft(account, state, accountId, env);
    const admission = await applyAccountInput(
      accountConsensusContext,
      account,
      { kind: 'enqueue', txs: [draft.tx] },
    );
    if (!admission.ok || admission.admittedAccountTxCount !== 1) {
      throw new Error(`SETTLEMENT_DEFERRED_SEAL_NOT_ADMITTED:${accountId}`);
    }
    recordFrameAccountChange(storageChanges, state.entityId, accountId);
    collectedHashes.push(...draft.hashesToSign);
    markProposableAccount(proposableAccounts, accountId);
    deferred.delete(accountId);
  }
}

type SettlementTransitionTx = Extract<AccountTx, { type: 'settle_transition' }>;
type SettlementSealTx = Omit<SettlementTransitionTx, 'data'> & {
  data: Extract<SettlementTransitionTx['data'], { kind: 'seal' }>;
};

const isStaleUncommittedSettlementSeal = (
  tx: AccountTx,
  revision: number,
  workspaceHash: string,
  expectedNonce: number,
): tx is SettlementSealTx =>
  tx.type === 'settle_transition'
  && tx.data.kind === 'seal'
  && tx.data.revision === revision
  && tx.data.workspaceHash.toLowerCase() === workspaceHash
  && tx.data.settlementNonce !== expectedNonce;

function refreshStaleUncommittedSettlementSeals(state: EntityState, storageChanges: RuntimeOverlayRecord[]): void {
  for (const accountId of [...getQueuedAccountIds(state)].sort(compareStableText)) {
    const visible = state.accounts.get(accountId);
    if (!visible) throw new Error(`QUEUED_ACCOUNT_INDEX_STALE:${accountId}`);
    const workspace = visible.state.settlementWorkspace;
    if (!workspace || workspace.nonceAtSign !== undefined || visible.pendingFrame) continue;
    const workspaceHash = assertCanonicalSettlementWorkspace(visible.state, workspace);
    const expectedNonce = getNextSettlementNonce(visible);
    if (!visible.mempool.some(tx => isStaleUncommittedSettlementSeal(tx, workspace.revision, workspaceHash, expectedNonce))) {
      continue;
    }

    // A same-height Account tiebreaker can restore our uncommitted seal after
    // the winning peer frame has advanced the exact proof frontier. Never
    // mutate or tolerate that signed seal: discard only the local intent and
    // deterministically request a fresh Entity-quorum witness for this exact
    // workspace at the new nonce. Filter by seal fields, not object identity:
    // getForWrite clones mempool txs.
    const account = getEntityAccountForWrite(state.accounts, accountId);
    if (!account) throw new Error(`QUEUED_ACCOUNT_INDEX_STALE:${accountId}`);
    const staleNonces: number[] = [];
    account.mempool = account.mempool.filter(tx => {
      if (!isStaleUncommittedSettlementSeal(tx, workspace.revision, workspaceHash, expectedNonce)) return true;
      staleNonces.push(tx.data.settlementNonce);
      return false;
    });
    recordFrameAccountChange(storageChanges, state.entityId, accountId);
    state.deferredAccountProposals ??= new Map();
    const existing = state.deferredAccountProposals.get(accountId);
    if (existing && existing !== workspaceHash) {
      throw new Error(`SETTLEMENT_REFRESH_DEFERRED_CONFLICT:${accountId}:${existing}:${workspaceHash}`);
    }
    state.deferredAccountProposals.set(accountId, workspaceHash);
    entityLog.info('settlement.stale_seal_refreshed', {
      account: shortId(accountId),
      expectedNonce,
      staleNonces: staleNonces.sort((left, right) => left - right),
    });
  }
}

type AccountFrameProposal = Awaited<ReturnType<typeof proposeAccountFrame>>;

const proposeAccountFrameCandidate = async (
  context: ProposePendingAccountFramesContext,
  accountKey: string,
  account: AccountReplica,
  crossJOpeningProposalTxs: AccountTx[] | undefined,
  scheduleAccount: (accountId: string) => void,
): Promise<AccountFrameProposal | undefined> => {
  const { env, currentEntityState: state, collectedHashes, proposableAccounts, storageChanges } = context;
  if (!accountHasProposableMempool(account, state)) return undefined;
  const proposal = await proposeAccountFrame(
    context.accountConsensusContext,
    account,
    state.timestamp,
    state.lastFinalizedJHeight,
    crossJOpeningProposalTxs,
  );
  if ('accountChanged' in proposal && proposal.accountChanged) {
    recordFrameAccountChange(storageChanges, state.entityId, accountKey);
  }
  if (isProposedAccountFrame(proposal) && proposal.swapOffersCancelled?.length) {
    const cancels = proposal.swapOffersCancelled.map(({ offerId }) => ({ accountId: accountKey, offerId }));
    applyCommittedSwapCancelsToOrderbook(env, state, cancels, storageChanges);
  }
  if (isProposedAccountFrame(proposal) && proposal.hashesToSign) {
    collectedHashes.push(...proposal.hashesToSign);
  }
  for (const { hashlock, reason } of ('failedHtlcLocks' in proposal ? proposal.failedHtlcLocks : undefined) ?? []) {
    const route = state.htlcRoutes.get(hashlock);
    if (!route) continue;
    if (route.outboundLockId) state.lockBook.delete(route.outboundLockId);
    if (hasInboundHtlcRoute(route)) {
      const inboundAccount = getEntityAccountForWrite(state.accounts, route.inboundEntity);
      if (inboundAccount) {
        const admission = await applyAccountInput(
          context.accountConsensusContext,
          inboundAccount,
          { kind: 'enqueue', txs: [{
          type: 'htlc_resolve',
          data: {
            lockId: route.inboundLockId,
            outcome: 'error',
            reason: `forward_failed:${reason}`,
          },
          }] },
        );
        if (!admission.ok || admission.admittedAccountTxCount === 0) continue;
        recordFrameAccountChange(storageChanges, state.entityId, route.inboundEntity);
        markProposableAccount(proposableAccounts, route.inboundEntity);
        scheduleAccount(route.inboundEntity);
      }
    }
    terminateHtlcRoute(state, hashlock, state.timestamp);
  }
  return proposal;
};

const liveOutboundAck = (
  account: AccountReplica,
  accountKey: string,
): Extract<AccountPeerInput, { kind: 'ack' }> | undefined => {
  const saved = account.lastOutboundFrameAck;
  if (!saved) return undefined;
  if (saved.counterpartyEntityId.toLowerCase() !== accountKey.toLowerCase()) {
    throw new Error(`ACCOUNT_FORCED_ACK_COUNTERPARTY_MISMATCH:${accountKey}`);
  }
  if (Number(saved.height) !== Number(account.currentHeight)) {
    throw new Error(
      `ACCOUNT_FORCED_ACK_HEIGHT_MISMATCH:${accountKey}:${saved.height}:${account.currentHeight}`,
    );
  }
  const ack = accountInputAck(saved.response);
  if (!ack || Number(ack.height) !== Number(saved.height)) {
    throw new Error(`ACCOUNT_FORCED_ACK_BYTES_INVALID:${accountKey}:${saved.height}`);
  }
  if (ack.frameHash.toLowerCase() !== account.currentFrame.stateHash.toLowerCase()) {
    throw new Error(`ACCOUNT_FORCED_ACK_HASH_MISMATCH:${accountKey}:${saved.height}`);
  }
  return structuredClone(saved.response);
};

/**
 * Channel.ts flushes from live channel state, never from a second response
 * cache. XLN does the same, retaining only exact Hanko-bearing proposal/ACK
 * bytes in the AccountReplica so a flush cannot invent new bytes.
 */
const resolveForcedAccountInput = (
  account: AccountReplica,
  accountKey: string,
): AccountPeerInput | undefined => {
  const ack = liveOutboundAck(account, accountKey);
  if (!account.pendingFrame) {
    if (!ack) throw new Error(`ACCOUNT_FORCED_RESPONSE_MISSING:${accountKey}:${account.currentHeight}`);
    return ack;
  }

  // A proposal leaves exactly once with the Runtime frame that created it.
  // While it is pending, a forced flush may add a newly available ACK but may
  // never reconstruct or re-carry the old proposal from Account state.
  return ack;
};

const assertForcedAccountInputPreserved = (
  accountKey: string,
  required: AccountPeerInput,
  final: AccountPeerInput,
): void => {
  const requiredAck = accountInputAck(required);
  const requiredProposal = accountInputProposal(required);
  const finalAck = accountInputAck(final);
  const finalProposal = accountInputProposal(final);
  if (requiredAck && (!finalAck || safeStringify(finalAck) !== safeStringify(requiredAck))) {
    throw new Error(`ACCOUNT_FORCED_ACK_NOT_BUNDLED:${accountKey}:${requiredAck.height}`);
  }
  if (requiredProposal && (!finalProposal || safeStringify(finalProposal) !== safeStringify(requiredProposal))) {
    throw new Error(`ACCOUNT_FORCED_PROPOSAL_NOT_PRESERVED:${accountKey}:${requiredProposal.frame.height}`);
  }
};

const routeFinalAccountInput = (
  context: ProposePendingAccountFramesContext,
  accountKey: string,
  counterpartyId: string,
  input: AccountPeerInput,
  proposal: AccountFrameProposal | undefined,
): void => {
  const { env, currentEntityState: state, allOutputs } = context;
  const sourceEntityId = state.entityId.trim().toLowerCase();
  const inputSourceEntityId = input.fromEntityId.trim().toLowerCase();
  if (inputSourceEntityId !== sourceEntityId) {
    throw haltRuntimeFailure(
      'ACCOUNT_OUTPUT_SOURCE_ENTITY_MISMATCH',
      `ACCOUNT_OUTPUT_SOURCE_ENTITY_MISMATCH:${safeStringify({
        sourceEntityId,
        inputSourceEntityId,
        targetEntityId: input.toEntityId,
        accountKey,
        input,
      })}`,
    );
  }
  // Entity consensus commits the destination Entity and exact Account payload.
  // It deliberately does not choose a validator replica: validator topology,
  // local keys and recovery hints belong to the parent Runtime. Runtime binds
  // this output to an exact signer before committing its own frame.
  allOutputs.push({
    entityId: input.toEntityId,
    entityTxs: [{ type: 'accountInput', data: input }],
  });
  if (!proposal) return;
  addMessages(state, proposal.events);
  emitScopedEvents(
    env,
    'account',
    `E/A/${state.entityId.slice(-4)}:${counterpartyId.slice(-4)}/propose`,
    proposal.events,
    {
      entityId: state.entityId,
      counterpartyId,
      frameHeight: accountInputReferenceHeight(input),
      accountKey,
    },
    state.entityId,
  );
};

async function proposePendingAccountFrames(context: ProposePendingAccountFramesContext): Promise<number> {
  const {
    env,
    currentEntityState,
    proposableAccounts,
  } = context;
  const worklist = createCanonicalAccountWorklist(proposableAccounts);
  let proposedFrames = 0;

  while (true) {
    const work = worklist.take();
    if (!work) break;
    const { accountId: accountKey, force } = work;
    const account = getEntityAccountForWrite(currentEntityState.accounts, accountKey);
    const { counterparty: cpId } = account
      ? getAccountPerspective(account.state, currentEntityState.entityId)
      : { counterparty: 'unknown' };
    if (!account) {
      throw new Error(`ACCOUNT_FLUSH_ACCOUNT_MISSING:${accountKey}`);
    }

    const crossJOpeningProposalTxs = selectCrossJOpeningAccountProposalTxs(env, currentEntityState, account);
    if (crossJOpeningProposalTxs === null && !force) {
      entityLog.debug('account.cross_j_opening_cohort_wait', {
        account: shortId(accountKey),
        entity: shortId(currentEntityState.entityId),
      });
      continue;
    }

    const requiredResponse = force
      ? resolveForcedAccountInput(account, accountKey)
      : undefined;
    traceAccountFlushHop(
      'entity-flush-start',
      currentEntityState.entityId,
      accountKey,
      account,
      requiredResponse,
      { proposable: accountHasProposableMempool(account, currentEntityState) },
    );

    const proposal = crossJOpeningProposalTxs === null
      ? undefined
      : await proposeAccountFrameCandidate(
          context,
          accountKey,
          account,
          crossJOpeningProposalTxs,
          accountId => { worklist.add(accountId); },
        );
    // Idle/rejected Account attempts are not frames. Counting either result as
    // committed work keeps an otherwise empty Entity preview alive, advances
    // Entity height, and immediately schedules the same impossible attempt
    // again. Only an actual Account proposal is causal work worth certifying.
    if (proposal && isProposedAccountFrame(proposal)) {
      proposedFrames += 1;
    }

    const finalAccountInput = proposal && isProposedAccountFrame(proposal)
      ? proposal.accountInput
      : requiredResponse;
    traceAccountFlushHop(
      'entity-flush-done',
      currentEntityState.entityId,
      accountKey,
      account,
      requiredResponse,
      {
        proposalDisposition: proposal === undefined
          ? 'none'
          : isProposedAccountFrame(proposal)
            ? 'proposed'
            : 'rejected',
        finalInputKind: finalAccountInput?.kind ?? null,
      },
    );
    if (!finalAccountInput) {
      continue;
    }
    if (requiredResponse) {
      assertForcedAccountInputPreserved(accountKey, requiredResponse, finalAccountInput);
    }
    routeFinalAccountInput(
      context,
      accountKey,
      cpId,
      finalAccountInput,
      proposal,
    );
  }

  return proposedFrames;
}

type ApplyOrderbookMatchingContext = {
  env: EntityRuntimeContext;
  accountConsensusContext: AccountConsensusContext;
  currentEntityState: EntityState;
  allSwapOffersCreated: SwapOfferEvent[];
  allOutputs: EntityOutput[];
  proposableAccounts: ProposableAccountMap;
  candidateEffects: EntityCandidateEffect[];
  storageChanges: RuntimeOverlayRecord[];
};

type OrderbookFrameStats = {
  hasPersistedCrossJurisdictionBook: boolean;
  orderbookMatched: boolean;
  orderbookMempoolOps: number;
  orderbookBookUpdates: number;
  orderbookCrossFills: number;
};

const emptyOrderbookFrameStats = (): OrderbookFrameStats => ({
  hasPersistedCrossJurisdictionBook: false,
  orderbookMatched: false,
  orderbookMempoolOps: 0,
  orderbookBookUpdates: 0,
  orderbookCrossFills: 0,
});

const collectOffersForMatching = (
  env: EntityRuntimeContext,
  state: EntityState,
  created: SwapOfferEvent[],
): WorkingOrderbookOffer[] => {
  const hubEntity = normalizeEntityRef(state.entityId);
  const enriched = created.map(offer => {
    const fromEntity = normalizeEntityRef(offer.fromEntity);
    const toEntity = normalizeEntityRef(offer.toEntity);
    return normalizeSwapOfferForOrderbook(
      offer,
      fromEntity === hubEntity ? toEntity : fromEntity,
    );
  });
  const seen = new Set<string>();
  const admitted: WorkingOrderbookOffer[] = [];
  for (const offer of enriched) {
    const key = swapKey(offer.accountId, offer.offerId);
    if (seen.has(key)) continue;
    seen.add(key);
    // Same-j Account frames are committed by both endpoints, but an offer is
    // listed only by its counterparty matcher. A maker that also operates an
    // orderbook must not duplicate its own offer in a second canonical book.
    const makerEntityId = offer.makerIsLeft ? offer.fromEntity : offer.toEntity;
    if (!offer.crossJurisdiction && makerEntityId === hubEntity) {
      entityLog.debug('orderbook.skip_local_maker', {
        offer: shortOrder(offer.offerId, 8),
        entity: shortId(state.entityId, 8),
      });
      continue;
    }
    if (
      offer.crossJurisdiction &&
      crossJurisdictionBookOwnerRef(offer.crossJurisdiction) !== hubEntity
    ) {
      entityLog.debug('crossj.orderbook.skip_non_owner', {
        offer: shortOrder(offer.offerId, 8),
        owner: shortId(crossJurisdictionBookOwnerRef(offer.crossJurisdiction), 8),
        current: shortId(state.entityId, 8),
      });
      continue;
    }
    const candidate = admitOrderbookOfferForMatching(env, state, offer);
    if (candidate) admitted.push(candidate);
  }
  entityLog.debug('orderbook.offers_enriched', { local: enriched.length, admitted: admitted.length });
  return admitted;
};

type OrderbookMatchResult = ReturnType<typeof processOrderbookSwaps>;

const applyOrderbookAccountTxs = async (
  context: ApplyOrderbookMatchingContext,
  result: OrderbookMatchResult,
): Promise<void> => {
  const {
    env,
    accountConsensusContext,
    currentEntityState: state,
    allOutputs,
    proposableAccounts,
    storageChanges,
  } = context;
  const localBatches = new Map<string, { account: AccountReplica; txs: AccountTx[] }>();
  for (const { accountId, tx } of result.accountTxs) {
    const visible = state.accounts.get(accountId);
    if (tx.type === 'swap_resolve') {
      const offer = visible?.state.swapOffers?.get(tx.data.offerId);
      if (offer?.crossJurisdiction) {
        entityLog.warn('crossj.block_plain_swap_resolve', {
          offer: shortOrder(tx.data.offerId, 8),
          account: shortId(accountId, 8),
        });
        continue;
      }
      if (!visible?.state.swapOffers?.has(tx.data.offerId)) {
        throw haltRuntimeFailure("ORDERBOOK_SWAP_OWNER_NOT_LOCAL", `ORDERBOOK_SWAP_OWNER_NOT_LOCAL: account=${accountId} offer=${tx.data.offerId} entity=${state.entityId}`);
      }
    } else if (tx.type === 'cross_swap_fill_ack' && !visible?.state.swapOffers?.has(tx.data.offerId)) {
      const routed = buildCrossJurisdictionFillNoticeOutput(state, accountId, tx);
      if (routed) {
        allOutputs.push(routed);
        entityLog.info('crossj.sibling_fill_notice_routed', {
          owner: shortId(routed.entityId, 8),
          account: shortId(accountId, 8),
          offer: shortOrder(tx.data.offerId, 8),
        });
        continue;
      }
      if (ownsSourceHubRouteForFillAck(state, tx)) {
        stashPendingCrossJurisdictionFillAck(
          env,
          state,
          accountId,
          tx,
          visible ? 'source_offer_not_committed' : 'source_account_not_committed',
        );
        continue;
      }
      throw haltRuntimeFailure("CROSS_J_FILL_ACK_OWNER_MISSING", `CROSS_J_FILL_ACK_OWNER_MISSING: account=${accountId} offer=${tx.data.offerId} current=${state.entityId}`);
    }
    if (!visible) {
      throw haltRuntimeFailure('ORDERBOOK_ACCOUNT_TX_ACCOUNT_MISSING', `ORDERBOOK_ACCOUNT_TX_ACCOUNT_MISSING: account=${accountId} entity=${state.entityId} tx=${tx.type}`);
    }
    const account = getEntityAccountForWrite(state.accounts, accountId);
    if (!account) {
      throw haltRuntimeFailure('ORDERBOOK_ACCOUNT_TX_ACCOUNT_MISSING', `ORDERBOOK_ACCOUNT_TX_ACCOUNT_MISSING: account=${accountId} entity=${state.entityId} tx=${tx.type}`);
    }
    const batch = localBatches.get(accountId);
    if (batch) batch.txs.push(tx);
    else localBatches.set(accountId, { account, txs: [tx] });
  }
  for (const [accountId, { account, txs }] of localBatches) {
    await admitOrderbookAccountTxBatch(accountConsensusContext, account, txs);
    for (const tx of txs) {
      if (tx.type === 'cross_swap_fill_ack') {
        appendCrossJurisdictionTargetProgressAfterAdmission(state, tx, allOutputs);
      }
    }
    markProposableAccount(proposableAccounts, accountId);
    recordFrameAccountChange(storageChanges, state.entityId, accountId);
    entityLog.debug('orderbook.account_txs_queued', {
      account: shortId(accountId, 8),
      count: txs.length,
    });
  }
};

const commitOrderbookMatchResult = (
  context: ApplyOrderbookMatchingContext,
  result: OrderbookMatchResult,
): void => {
  const { env, currentEntityState: state, storageChanges, candidateEffects } = context;
  if (result.debugProjectionRejects.length > 0) {
    const detail = result.debugProjectionRejects
      .map(({ accountId, offerId, reason }) => `${accountId.slice(-8)}:${offerId.slice(-8)}:${reason}`)
      .join(', ');
    throw haltRuntimeFailure("ORDERBOOK_LIVE_PROJECTION_REJECT", `ORDERBOOK_LIVE_PROJECTION_REJECT: ${detail}`);
  }
  if (result.crossJurisdictionFills.length > 0) {
    entityLog.info('crossj.firm_fills_recorded', { count: result.crossJurisdictionFills.length });
    for (const fill of result.crossJurisdictionFills) {
      if (fill.cancelRemainder) {
        markCrossJurisdictionBookAdmissionResolving(
          state,
          fill.route,
          deterministicEntityTimestamp(state, env),
        );
      }
    }
  }
  const ext = state.orderbookExt as OrderbookExtState;
  const previousTradeCounts = new Map<string, number>();
  let matchedSwaps = 0;
  for (const { pairId, book } of result.bookUpdates) {
    const previousTradeCount = previousTradeCounts.get(pairId) ?? ext.books.get(pairId)?.tradeCount ?? 0;
    if (book.tradeCount < previousTradeCount) {
      throw new Error(
        `ORDERBOOK_TRADE_COUNT_REGRESSION:pair=${pairId}:previous=${previousTradeCount}:next=${book.tradeCount}`,
      );
    }
    matchedSwaps += book.tradeCount - previousTradeCount;
    previousTradeCounts.set(pairId, book.tradeCount);
    replaceOrderbookPair(ext, pairId, book);
    recordFrameBookChange(storageChanges, state.entityId, pairId);
  }
  if (matchedSwaps > 0) {
    candidateEffects.push({
      kind: 'runtimeEvent',
      eventName: 'SwapMatched',
      data: { entityId: state.entityId, count: matchedSwaps },
    });
  }
};

async function applyOrderbookMatching(
  context: ApplyOrderbookMatchingContext,
): Promise<OrderbookFrameStats> {
  const { env, currentEntityState, allSwapOffersCreated } = context;
  const stats = emptyOrderbookFrameStats();
  const books = currentEntityState.orderbookExt?.books;
  stats.hasPersistedCrossJurisdictionBook = Boolean(
    books instanceof EntityCandidateMap
      ? books.someKey(pairId => pairId.startsWith('cross:'))
      : books && Array.from(books.keys()).some(pairId => pairId.startsWith('cross:')),
  );
  // Account offer commits are bilateral, so both endpoint Entities observe
  // them. Only the endpoint that explicitly owns orderbookExt is a matcher;
  // the user endpoint commits Account state and intentionally does no book
  // work. This is an ownership boundary, not an alternate settlement path.
  if (!currentEntityState.orderbookExt) return stats;
  if (allSwapOffersCreated.length === 0 && !stats.hasPersistedCrossJurisdictionBook) {
    return stats;
  }

  entityLog.debug('orderbook.matching', {
    offers: allSwapOffersCreated.length,
    hasPersistedCrossJurisdictionBook: stats.hasPersistedCrossJurisdictionBook,
  });

  const offersToMatch = collectOffersForMatching(env, currentEntityState, allSwapOffersCreated);
  const matchResult = processOrderbookSwaps(currentEntityState, offersToMatch, {
    candidateEffects: context.candidateEffects,
  });
  stats.orderbookMatched = true;
  stats.orderbookMempoolOps = matchResult.accountTxs.length;
  stats.orderbookBookUpdates = matchResult.bookUpdates.length;
  stats.orderbookCrossFills = matchResult.crossJurisdictionFills.length;

  // Matching is pure; only these two stages mutate the isolated Entity frame.
  await applyOrderbookAccountTxs(context, matchResult);
  commitOrderbookMatchResult(context, matchResult);
  return stats;
}

type ApplySwapCancelRequestsContext = {
  env: EntityRuntimeContext;
  accountConsensusContext: AccountConsensusContext;
  currentEntityState: EntityState;
  allSwapCancelRequests: SwapCancelRequestEvent[];
  proposableAccounts: ProposableAccountMap;
  allOutputs: EntityOutput[];
  storageChanges: RuntimeOverlayRecord[];
};

async function applySwapCancelRequests(
  context: ApplySwapCancelRequestsContext,
): Promise<void> {
  const {
    env,
    accountConsensusContext,
    currentEntityState,
    allSwapCancelRequests,
    proposableAccounts,
    allOutputs,
    storageChanges,
  } = context;
  if (allSwapCancelRequests.length === 0) return;

  const routedCancels = routeRemoteCrossJurisdictionBookCancels(env, currentEntityState, allSwapCancelRequests);
  allOutputs.push(...routedCancels.outputs);
  for (const { accountId, tx } of routedCancels.accountTxs) {
    if (tx.type !== 'cross_swap_fill_ack') {
      throw haltRuntimeFailure("CROSS_J_CANCEL_ACK_TX_INVALID", `CROSS_J_CANCEL_ACK_TX_INVALID:account=${accountId}:type=${tx.type}`);
    }
    const account = getEntityAccountForWrite(currentEntityState.accounts, accountId);
    if (!account) {
      throw haltRuntimeFailure("CROSS_J_CANCEL_ACK_ACCOUNT_MISSING", `CROSS_J_CANCEL_ACK_ACCOUNT_MISSING:account=${accountId}:offer=${tx.data.offerId}`);
    }
    const admission = await applyAccountInput(
      accountConsensusContext,
      account,
      { kind: 'enqueue', txs: [tx] },
    );
    if (!admission.ok || admission.admittedAccountTxCount === 0) continue;
    appendCrossJurisdictionTargetProgressAfterAdmission(currentEntityState, tx, allOutputs);
    markProposableAccount(proposableAccounts, accountId);
    recordFrameAccountChange(storageChanges, currentEntityState.entityId, accountId);
  }

  const localBookCancels = routedCancels.localBookCancels;
  if (localBookCancels.length === 0) return;
  // The same bilateral cancel event is visible to the user and matcher. Only
  // the matcher owns the canonical book and may enqueue its swap_resolve.
  // A non-matcher substitute must never be synthesized here.
  if (!currentEntityState.orderbookExt) return;

  const cancelResult = processOrderbookCancels(currentEntityState, localBookCancels);
  for (const { accountId, tx } of cancelResult.accountTxs) {
    const account = getEntityAccountForWrite(currentEntityState.accounts, accountId);
    if (!account) continue;
    const admission = await applyAccountInput(
      accountConsensusContext,
      account,
      { kind: 'enqueue', txs: [tx] },
    );
    if (!admission.ok || admission.admittedAccountTxCount === 0) continue;
    if (tx.type === 'cross_swap_fill_ack') {
      appendCrossJurisdictionTargetProgressAfterAdmission(currentEntityState, tx, allOutputs);
    }
    markProposableAccount(proposableAccounts, accountId);
    recordFrameAccountChange(storageChanges, currentEntityState.entityId, accountId);
  }

  const ext = currentEntityState.orderbookExt as OrderbookExtState;
  for (const { pairId, book } of cancelResult.bookUpdates) {
    replaceOrderbookPair(ext, pairId, book);
    recordFrameBookChange(storageChanges, currentEntityState.entityId, pairId);
  }
}

type EntityFrameResult = {
  newState: EntityState;
  outputs: EntityOutput[];
  jOutputs: JInput[];
  candidateEffects: EntityCandidateEffect[];
  storageChanges: RuntimeOverlayRecord[];
  proposableAccounts: string[];
  accountsToProposeFramesCount: number;
  events: EntityFrameEvent[];
  collectedHashes?: Array<{ hash: string; type: HashType; context: string }>;
  consumptionNodeChanges?: ConsumptionNodeChanges;
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
};

type EntityFrameWorkingSet = {
  authorityTransitionOnly: boolean;
  crossJSetupPhase: boolean;
  currentEntityState: EntityState;
  context: ApplyEntityTxsInOrderContext;
  frameProfileStartMs: number;
  frameProfileMarks: Record<string, number>;
  markFrameProfile: (label: string) => void;
};

const verifyCertifiedFrameInputs = async (
  env: EntityRuntimeContext,
  state: EntityState,
  txs: readonly EntityTx[],
): Promise<ApplyEntityTxsInOrderContext['verifiedCertifiedOutputs']> => {
  const verified: ApplyEntityTxsInOrderContext['verifiedCertifiedOutputs'] =
    new Map();
  for (const tx of txs) {
    if (tx.type !== 'consensusOutput') continue;
    try {
      verified.set(tx, await verifyCertifiedEntityOutput(env, state, tx));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof FailureDispositionError) || error.disposition !== 'reject') throw error;
      throw new MalformedEntityFrameInputError(tx.type, message);
    }
  }
  return verified;
};

const initializeEntityFrameState = (
  env: EntityRuntimeContext,
  normalized: EntityState,
  isolateState: boolean,
  frameTimestamp: number | undefined,
): EntityState => {
  const state = isolateState
    ? createEntityFrameCandidateState(normalized)
    : normalized;
  clearEntityFrameEvents(state);
  state.crontabState ??= initCrontab();
  const timestamp = frameTimestamp ?? env.state.timestamp;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`ENTITY_FRAME_TIMESTAMP_INVALID:${String(timestamp)}`);
  }
  if (timestamp < state.timestamp) {
    throw new Error(
      `ENTITY_FRAME_TIMESTAMP_REGRESSION:previous=${state.timestamp}:` +
        `proposed=${timestamp}`,
    );
  }
  state.timestamp = timestamp;
  return state;
};

const createEntityFrameApplyContext = (
  env: EntityRuntimeContext,
  entityContext: import('../../../types/entity/infra-context').EntityInfraContext,
  entityTxs: EntityTx[],
  currentEntityState: EntityState,
  verifiedCertifiedOutputs: ApplyEntityTxsInOrderContext['verifiedCertifiedOutputs'],
  authorizedBoardHandoverConfig: EntityState['config'] | undefined,
): ApplyEntityTxsInOrderContext => {
  const accountJClaimNewNodes = new Map<string, AccountJClaimNode>();
  const committedClaimNodes = getAccountJClaimNodeStore(env);
  const accountJClaimNodeStore: AccountJClaimNodeStore = {
    get: hash => accountJClaimNewNodes.get(hash) ?? committedClaimNodes.get(hash),
  };
  return {
    env,
    entityContext,
    // `validateEntityInfraContext` proves canonical ordering and uniqueness.
    // Build this once per Entity frame: rebuilding it for every committed
    // Account HTLC made a 500-entry batch quadratic.
    preparedHtlcEntriesByBinding: new Map(entityContext.htlc.entries.map(entry => [
      preparedHtlcBindingKey(entry.binding),
      entry,
    ])),
    accountConsensusContext: createAccountConsensusContext(env, accountJClaimNodeStore, currentEntityState),
    entityTxs,
    currentEntityState,
    allOutputs: [],
    allJOutputs: [],
    collectedHashes: [],
    collectedHashManifest: new Map(),
    proposableAccounts: new Map(),
    allSwapOffersCreated: [],
    allSwapCancelRequests: [],
    allSwapOffersCancelled: [],
    frameProfileTxTotals: new Map(),
    consumptionNewNodes: new Map(),
    consumptionReplacedNodeHashes: new Set(),
    accountJClaimNewNodes,
    accountJClaimReplacedNodeHashes: new Set(),
    accountJClaimNodeStore,
    candidateEffects: [],
    storageChanges: [],
    verifiedCertifiedOutputs,
    ...(authorizedBoardHandoverConfig ? { authorizedBoardHandoverConfig } : {}),
  };
};

const primeEntityFrameAccountWork = async (
  context: ApplyEntityTxsInOrderContext,
): Promise<void> => {
  const state = context.currentEntityState;
  await drainPendingCrossJurisdictionFillAcks(
    context.env,
    context.accountConsensusContext,
    state,
    context.proposableAccounts,
    context.storageChanges,
    context.candidateEffects,
    context.allOutputs,
  );
  await drainCommittedCrossJurisdictionCancelAcks(
    context.accountConsensusContext,
    state,
    context.proposableAccounts,
    context.storageChanges,
    context.allOutputs,
  );
  for (const accountId of getProposableAccountIds(state)) {
    markProposableAccount(context.proposableAccounts, accountId);
  }
};

const prepareEntityFrameWorkingSet = async (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityContext: import('../../../types/entity/infra-context').EntityInfraContext,
  entityTxs: EntityTx[],
  frameTimestamp: number | undefined,
  isolateState: boolean,
): Promise<EntityFrameWorkingSet> => {
  const expectedEntityId = entityState.entityId.trim().toLowerCase();
  const expectedParentFrameHash = entityState.height === 0 ? 'genesis' : String(entityState.prevFrameHash || '');
  if (
    entityContext.entityId !== expectedEntityId ||
    entityContext.proposerReplicaId !== `${expectedEntityId}:${entityContext.proposerSignerId}` ||
    entityContext.parentFrameHash !== expectedParentFrameHash ||
    entityContext.height !== entityState.height + 1
  ) {
    throw new Error(
      `ENTITY_INFRA_CONTEXT_BINDING_MISMATCH:${safeStringify({
        actual: {
          entityId: entityContext.entityId,
          height: entityContext.height,
          parentFrameHash: entityContext.parentFrameHash,
          proposerReplicaId: entityContext.proposerReplicaId,
          proposerSignerId: entityContext.proposerSignerId,
        },
        expected: {
          entityId: expectedEntityId,
          height: entityState.height + 1,
          parentFrameHash: expectedParentFrameHash,
          proposerReplicaId: `${expectedEntityId}:${entityContext.proposerSignerId}`,
        },
      })}`,
    );
  }
  assertEntityFrameTxByteBudget(entityTxs);
  assertEntityFrameJRangeBudget(entityTxs);
  assertScheduledWakeFrameOrder(entityTxs);
  const crossJSetupPhase = entityTxs.some(entityTxContainsCrossJSetup);
  if (crossJSetupPhase && entityTxs.some(entityTxContainsAccountTransition)) {
    throw haltRuntimeFailure("CROSS_J_SETUP_ACCOUNT_TRANSITION_MIXED", 'CROSS_J_SETUP_ACCOUNT_TRANSITION_MIXED');
  }
  const normalized = normalizeEntityProposalBoard(
    env,
    normalizeEntityCommandNonceBoard(env, entityState),
  );
  // Certified output bytes are adversarial transport input. Verify them before
  // touching the Runtime-owned single-signer State, then reuse the proof during
  // execution. Invalid Hanko therefore drops only this input in production;
  // reducer/storage faults still halt and reload durable WAL truth.
  const verifiedCertifiedOutputs = await verifyCertifiedFrameInputs(
    env,
    normalized,
    entityTxs,
  );
  const authorizedBoardHandoverConfig = getBoardHandoverFrameConfig(
    env,
    normalized,
    entityTxs,
  );
  const authorityTransitionOnly = authorizedBoardHandoverConfig !== null ||
    await isSelfBoardAuthorityTransitionFrame(env, normalized, entityTxs);
  const frameProfileStartMs = getPerfMs();
  const frameProfileMarks: Record<string, number> = {};
  const markFrameProfile = (label: string): void => {
    frameProfileMarks[label] = Math.round(getPerfMs() - frameProfileStartMs);
  };
  entityLog.debug('frame.apply', { txs: entityTxs.map(tx => tx.type) });
  const currentEntityState = initializeEntityFrameState(
    env,
    normalized,
    isolateState,
    frameTimestamp,
  );
  markFrameProfile('clone');
  const context = createEntityFrameApplyContext(
    env,
    entityContext,
    entityTxs,
    currentEntityState,
    verifiedCertifiedOutputs,
    authorizedBoardHandoverConfig ?? undefined,
  );
  if (!authorityTransitionOnly) {
    await primeEntityFrameAccountWork(context);
  }
  return {
    authorityTransitionOnly,
    crossJSetupPhase,
    currentEntityState,
    context,
    frameProfileStartMs,
    frameProfileMarks,
    markFrameProfile,
  };
};

const buildEntityFrameResult = (
  currentEntityState: EntityState,
  context: ApplyEntityTxsInOrderContext,
  accountsToProposeFramesCount = 0,
): EntityFrameResult => ({
  newState: currentEntityState,
  outputs: context.allOutputs,
  jOutputs: context.allJOutputs,
  candidateEffects: context.candidateEffects,
  storageChanges: mergeStorageOverlayRecords(undefined, context.storageChanges),
  proposableAccounts: copyProposableAccounts(context.proposableAccounts.keys()),
  accountsToProposeFramesCount,
  events: readEntityFrameEvents(currentEntityState),
  collectedHashes: context.collectedHashes,
  ...(context.consumptionNewNodes.size > 0 ||
  context.consumptionReplacedNodeHashes.size > 0
    ? {
        consumptionNodeChanges: {
          newNodes: Array.from(context.consumptionNewNodes, ([hash, node]) => ({ hash, node })),
          replacedNodeHashes: Array.from(context.consumptionReplacedNodeHashes).sort(),
        },
      }
    : {}),
  ...(context.accountJClaimNewNodes.size > 0 ||
  context.accountJClaimReplacedNodeHashes.size > 0
    ? {
        accountJClaimNodeChanges: {
          newNodes: Array.from(context.accountJClaimNewNodes, ([hash, node]) => ({ hash, node })),
          replacedNodeHashes: Array.from(context.accountJClaimReplacedNodeHashes).sort(),
        },
      }
    : {}),
});

type PostEntityTxPhases = {
  currentEntityState: EntityState;
  orderbookStats: OrderbookFrameStats;
  accountsToProposeFramesCount: number;
};

const refreshChangedAccountCommitments = (
  state: EntityState,
  context: ApplyEntityTxsInOrderContext,
): void => {
  const changedAccountIds = new Set(collectTouchedAccountIds(
    state.entityId,
    context.proposableAccounts.keys(),
    context.storageChanges,
    dirtyAccountIdsFromState(state),
  ));
  // Every Account mutation contributes a leaf to the signed Entity root.
  // `proposableAccounts` covers proposal-envelope changes, while
  // `storageChanges` also covers transactions such as openAccount that create
  // or mutate a leaf without proposing it until a later Entity frame.
  for (const accountId of changedAccountIds) {
    invalidateEntityAccountCommitment(state, accountId);
  }
  scheduleChangedAccountBoardReseals(
    state,
    captureAccountBoardResealEvidence(state, changedAccountIds),
    changedAccountIds,
  );
};

const applyPostEntityTxPhases = async (
  working: EntityFrameWorkingSet,
): Promise<PostEntityTxPhases> => {
  const { context, crossJSetupPhase, markFrameProfile } = working;
  let currentEntityState = working.currentEntityState;
  if (context.allSwapOffersCancelled.length > 0) {
    applyCommittedSwapCancelsToOrderbook(
      context.env,
      currentEntityState,
      context.allSwapOffersCancelled,
      context.storageChanges,
    );
  }
  await applySwapCancelRequests({
    env: context.env,
    accountConsensusContext: context.accountConsensusContext,
    currentEntityState,
    allSwapCancelRequests: context.allSwapCancelRequests,
    proposableAccounts: context.proposableAccounts,
    allOutputs: context.allOutputs,
    storageChanges: context.storageChanges,
  });
  markFrameProfile('cancels');
  const orderbookStats = await applyOrderbookMatching({
    env: context.env,
    accountConsensusContext: context.accountConsensusContext,
    currentEntityState,
    allSwapOffersCreated: context.allSwapOffersCreated,
    allOutputs: context.allOutputs,
    proposableAccounts: context.proposableAccounts,
    candidateEffects: context.candidateEffects,
    storageChanges: context.storageChanges,
  });
  markFrameProfile('orderbook');
  await drainPendingCrossJurisdictionFillAcks(
    context.env,
    context.accountConsensusContext,
    currentEntityState,
    context.proposableAccounts,
    context.storageChanges,
    context.candidateEffects,
    context.allOutputs,
  );
  await drainCommittedCrossJurisdictionCancelAcks(
    context.accountConsensusContext,
    currentEntityState,
    context.proposableAccounts,
    context.storageChanges,
    context.allOutputs,
  );
  refreshStaleUncommittedSettlementSeals(currentEntityState, context.storageChanges);
  await materializeDeferredSettlementApprovals(
    context.env,
    context.accountConsensusContext,
    currentEntityState,
    context.proposableAccounts,
    context.collectedHashes,
    context.storageChanges,
  );
  const accountsToProposeFramesCount = crossJSetupPhase
    ? 0
    : await proposePendingAccountFrames({
        env: context.env,
        accountConsensusContext: context.accountConsensusContext,
        currentEntityState,
        proposableAccounts: context.proposableAccounts,
        allOutputs: context.allOutputs,
        collectedHashes: context.collectedHashes,
        accountJClaimNodeStore: context.accountJClaimNodeStore,
        storageChanges: context.storageChanges,
      });
  markFrameProfile('accountProposals');
  // Account proposal construction mutates the Account replica envelope
  // (pending frame and Hanko state). Refresh each dirty leaf only
  // after that final mutation. Doing it earlier would preserve a valid-looking
  // but stale incremental Entity root.
  refreshChangedAccountCommitments(
    currentEntityState,
    context,
  );
  currentEntityState = assignCertifiedOutputIdentities(
    currentEntityState,
    context.allOutputs,
  );
  assertOriginatedHtlcRoutesHaveLiveLocks(currentEntityState);
  return {
    currentEntityState,
    orderbookStats,
    accountsToProposeFramesCount,
  };
};

const logEntityFrameProfile = (
  working: EntityFrameWorkingSet,
  entityTxs: EntityTx[],
  post: PostEntityTxPhases,
): void => {
  const { context, frameProfileStartMs, frameProfileMarks } = working;
  const elapsedMs = Math.round(getPerfMs() - frameProfileStartMs);
  if (!entityFrameProfileEnabled() && elapsedMs < entityFrameSlowMs()) return;
  entityLog.info('frame.profile', {
    entity: String(post.currentEntityState.entityId || '').slice(-8),
    elapsedMs,
    txs: entityTxs.length,
    txTypes: Array.from(new Set(entityTxs.map(tx => tx.type))).slice(0, 16),
    accountsToPropose: post.accountsToProposeFramesCount,
    outputs: context.allOutputs.length,
    jOutputs: context.allJOutputs.length,
    collectedHashes: context.collectedHashes.length,
    swapOffersCreated: context.allSwapOffersCreated.length,
    swapCancels:
      context.allSwapCancelRequests.length + context.allSwapOffersCancelled.length,
    hasOrderbookExt: Boolean(post.currentEntityState.orderbookExt),
    ...post.orderbookStats,
    phases: cumulativeMarksToPhases(frameProfileMarks, elapsedMs),
    txTypeTotals: Array.from(context.frameProfileTxTotals.entries())
      .map(([type, value]) => ({ type, ...value }))
      .sort((left, right) => right.elapsedMs - left.elapsedMs)
      .slice(0, 16),
  });
};

const applyEntityFrameWithIsolation = async (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityContext: import('../../../types/entity/infra-context').EntityInfraContext,
  entityTxs: EntityTx[],
  frameTimestamp: number | undefined,
  isolateState: boolean,
  inProcessInfraValidated = false,
): Promise<EntityFrameResult> => {
  // Live proposal already ran validateEntityInfraContext in materialize.
  // Do not stamp that object — Entity frame/state hashing rejects symbol keys
  // (100b: ENTITY_STATE_ROOT_SYMBOL_KEY at hub mesh). Live WAL write uses the
  // same flag. Network/replay apply and WAL recovery keep the full parse.
  if (!inProcessInfraValidated) {
    entityContext = validateEntityInfraContext(entityContext);
  }
  const profileHashStartedAt = getPerfMs();
  const previousProfileHash = computeEntityProfileHash(entityState);
  const previousProfileHashMs = Math.round(getPerfMs() - profileHashStartedAt);
  const working = await prepareEntityFrameWorkingSet(
    env,
    entityState,
    entityContext,
    entityTxs,
    frameTimestamp,
    isolateState,
  );
  working.currentEntityState = await applyEntityTxsInOrder(working.context);
  working.currentEntityState = await materializeSettlementContinuation(
    working.context,
    working.currentEntityState,
  );
  working.markFrameProfile('entityTxLoop');
  const appendFinalProfileHash = (state: EntityState): void => {
    const finalProfileHashStartedAt = getPerfMs();
    const changed = buildChangedEntityProfileHashToSign(
      state,
      entityState.height === 0 ? null : previousProfileHash,
    );
    const finalProfileHashMs = Math.round(getPerfMs() - finalProfileHashStartedAt);
    if (changed) working.context.collectedHashes.push(changed);
    const totalProfileHashMs = previousProfileHashMs + finalProfileHashMs;
    if (entityFrameProfileEnabled() || totalProfileHashMs >= entityFrameSlowMs()) {
      entityLog.info('frame.profile_descriptor', {
        entity: shortId(entityState.entityId, 8),
        accounts: entityState.accounts.size,
        changed: Boolean(changed),
        previousProfileHashMs,
        finalProfileHashMs,
        totalProfileHashMs,
      });
    }
  };
  if (working.authorityTransitionOnly) {
    working.currentEntityState = assignCertifiedOutputIdentities(
      working.currentEntityState,
      working.context.allOutputs,
    );
    entityLog.info('frame.board_authority_transition_only', {
      entity: shortId(working.currentEntityState.entityId),
      txs: entityTxs.length,
      finalizedJHeight: working.currentEntityState.lastFinalizedJHeight,
    });
    // A board handover must re-certify the current public profile even when
    // its descriptor bytes did not change. The hash-keyed witness slot may
    // otherwise retain the retired board's Hanko and fail current-board-only
    // profile authentication immediately after the transition.
    const profileHash = computeEntityProfileHash(working.currentEntityState);
    working.context.collectedHashes.push({
      hash: profileHash,
      type: 'profile',
      context: `profile:${profileHash}`,
    });
    return buildEntityFrameResult(
      working.currentEntityState,
      working.context,
    );
  }
  const post = await applyPostEntityTxPhases(working);
  appendFinalProfileHash(post.currentEntityState);
  logEntityFrameProfile(working, entityTxs, post);
  return buildEntityFrameResult(
    post.currentEntityState,
    working.context,
    post.accountsToProposeFramesCount,
  );
};

/**
 * Execute against an isolated touched-state candidate.
 *
 * Multi-signer validators must retain the certified Entity State while a frame
 * waits for quorum Hanko. Standalone reducer tests also use this pure boundary.
 */
export const applyEntityFrame = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityContext: import('../../../types/entity/infra-context').EntityInfraContext,
  entityTxs: EntityTx[],
  frameTimestamp?: number,
  inProcessInfraValidated = false,
): Promise<EntityFrameResult> =>
  applyEntityFrameWithIsolation(
    env,
    entityState,
    entityContext,
    entityTxs,
    frameTimestamp,
    true,
    inProcessInfraValidated,
  );

/**
 * Execute a single-signer frame through the same dirty-path candidate boundary.
 * Runtime ownership does not authorize mutation of the certified Entity root:
 * rejection and WAL failure must be able to discard the candidate in O(dirty).
 */
export const applyRuntimeOwnedEntityFrame = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityContext: import('../../../types/entity/infra-context').EntityInfraContext,
  entityTxs: EntityTx[],
  frameTimestamp?: number,
  inProcessInfraValidated = false,
): Promise<EntityFrameResult> =>
  applyEntityFrameWithIsolation(
    env,
    entityState,
    entityContext,
    entityTxs,
    frameTimestamp,
    true,
    inProcessInfraValidated,
  );
