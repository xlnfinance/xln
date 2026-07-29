/**
 * Entity consensus: validator replicas agree on entity frames, then route
 * committed account/J-layer side effects back into the runtime.
 */

import { accountInputAck, accountInputProposal, accountInputReferenceHeight } from '../../account/consensus/flush';
import { proposeAccountFrame } from '../../account/consensus/propose';
import { resolveCertifiedAccountCounterpartyProposer } from '../../account/counterparty-route';
import { getAccountJClaimNodeStore } from '../../account/j-claim-store';
import {
  assertCanonicalSettlementWorkspace,
  hasPendingSettlementTransition,
} from '../../account/tx/handlers/settle-transition';
import { markCrossJurisdictionBookAdmissionResolving } from '../../extensions/cross-j/orderbook';
import { logError, shortHash, shortId, shortOrder } from '../../infra/logger';
import { cumulativeMarksToPhases } from '../../infra/perf-profile';
import { assertEntityFrameJRangeBudget } from '../../jurisdiction/range-budget';
import { replaceOrderbookPair, type OrderbookExtState } from '../../orderbook';
import {
  applyCommittedSwapCancelsToOrderbook,
  crossJurisdictionBookOwnerRef,
  deterministicEntityTimestamp,
  normalizeEntityRef,
} from '../../orderbook/cross-j-orderbook';
import { swapKey, type WorkingOrderbookOffer } from '../../orderbook/swap-execution';
import { computeHtlcEnvelopeContextHash } from '../../protocol/htlc/envelope';
import { validateMultiRecipientCiphertext } from '../../protocol/htlc/multi-recipient';
import { encryptedHtlcLayer } from '../../protocol/htlc/onion-advance';
import { mergeStorageOverlayRecords } from '../../protocol/overlay';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import { getNextSettlementNonce } from '../../protocol/settlement/operations';
import { assertScheduledWakeFrameOrder } from '../scheduled-wake-validation';
import { cloneEntityState } from '../state-clone';
import { getAccountPerspective } from '../../account/perspective';
import { emitScopedEvents } from '../../infra/scoped-events';
import { resolveEntityProposerId } from '../../runtime/entity-output-signer';
import { addMessages, clearEntityFrameEvents, readEntityFrameEvents } from '../frame-events';
import type {
  AccountPeerInput,
  AccountState,
  AccountTx,
  EntityCandidateEffect,
  EntityFrameEvent,
  EntityInput,
  EntityState,
  EntityTx,
  RuntimeState,
  HashType,
  JInput,
  RuntimeOverlayRecord,
} from '../../types';
import type { AccountJClaimNode, AccountJClaimNodeChanges, AccountJClaimNodeStore } from '../../types/account-j-claims';
import { getPerfMs } from '../../utils';
import {
  assertRuntimeOutputAuthorization,
  isCollectiveEntityActionTx,
  isIndividualEntityCommandTx,
} from '../authorization';
import {
  advanceEntityCommandNonce,
  assertSignedEntityCommand,
  getEntityCommandDisposition,
  normalizeEntityCommandNonceBoard,
} from '../command';
import { isEntityCommandForbiddenTx } from '../command-codec';
import {
  applyConsumptionOutput,
  createEmptyConsumptionAccumulator,
} from '../consumption-accumulator';
import { type ConsumptionNodeChanges } from '../consumption-store';
import {
  entityTxContainsAccountTransition,
  entityTxContainsCrossJSetup,
  selectCrossJOpeningAccountProposalTxs,
} from '../cross-j-proposer-materialization';
import { initCrontab } from '../scheduler';
import { applyEntityTx, type ApplyEntityTxResult } from '../tx';
import {
  processOrderbookCancels,
  processOrderbookSwaps,
  routeRemoteCrossJurisdictionBookCancels,
  type SwapCancelRequestEvent,
  type SwapOfferEvent,
} from '../tx/handlers/account';
import { normalizeSwapOfferForOrderbook } from '../../orderbook/swap-execution';
import { buildCurrentEntityProfileHashToSign } from '../tx/handlers/profile-certification';
import { buildSettlementSealDraft } from '../tx/handlers/settle';
import { pruneSettledOriginatedHtlcRoutes, terminateHtlcRoute } from '../tx/htlc-route-lifecycle';
import { MalformedEntityFrameInputError } from '../tx/invariant-errors';
import { normalizeEntityProposalBoard } from '../tx/proposals';
import { accountHasProposableMempool } from './account-mempool-eligibility';
import {
  getProposableAccountIds,
  getQueuedAccountIds,
  refreshAccountWorkIndex,
} from './account-work-index';
import { applyAccountInput } from '../../account/consensus';
import { createLocalAccountInput } from '../../account/input';
import { assertEntityFrameTxByteBudget } from './frame';
import { assignCertifiedOutputIdentities, verifyCertifiedEntityOutput } from './output-certification';
import { invalidateEntityAccountCommitment } from './state-root';
import type { ApplyEntityTxsInOrderContext } from './frame-application-types';
import { applyEntityTxReturnedEffects } from './frame-tx-effects';

import {
  admitOrderbookOfferForMatching,
  buildConsumptionOutputIdentity,
  buildCrossJurisdictionFillNoticeOutput,
  drainCommittedCrossJurisdictionCancelAcks,
  drainPendingCrossJurisdictionFillAcks,
  entityFrameProfileEnabled,
  entityFrameSlowMs,
  entityLog,
  isSelfBoardAuthorityTransitionFrame,
  ownsSourceHubRouteForFillAck,
  stashPendingCrossJurisdictionFillAck,
} from './shared';

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
  const { origin, targetEntityId, entityTxs, outputHash } = await verifyCertifiedEntityOutput(
    context.env,
    currentEntityState,
    tx,
  );

  const identity = buildConsumptionOutputIdentity(origin, targetEntityId, outputHash, tx.data.outputHanko);
  const consumption = applyConsumptionOutput(
    currentEntityState.consumptionAccumulator ?? createEmptyConsumptionAccumulator(),
    identity,
    tx.data.consumptionProof,
  );
  if (consumption.status === 'idempotent' || consumption.status === 'stale') return currentEntityState;
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
    // The exact nested transaction bytes were already bound to outputHash and
    // verified against the source Entity board Hanko above. Requiring a target
    // user's EntityCommand as well would let the target rewrite or block an
    // already-certified cross-Entity effect.
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
  if (getEntityCommandDisposition(state, command) === 'retry') {
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
  if (result.requiredAccountResponse) {
    const accountId = result.requiredAccountResponse.toEntityId.toLowerCase();
    context.proposableAccounts.add(accountId);
    // Later authenticated inputs supersede earlier responses for the same
    // bilateral lane because only the final Account state may be flushed.
    context.requiredAccountResponses.set(
      accountId,
      structuredClone(result.requiredAccountResponse),
    );
  }
  context.allOutputs.push(...result.outputs);
  if (result.jOutputs) context.allJOutputs.push(...result.jOutputs);
  if (result.hashesToSign?.length) {
    context.collectedHashes.push(...result.hashesToSign);
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
    mutableFrameState: true,
    manualBroadcastInInput,
    accountJClaimNodeStore: context.accountJClaimNodeStore,
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

async function applyEntityTxsInOrder(context: ApplyEntityTxsInOrderContext): Promise<EntityState> {
  let currentEntityState = context.currentEntityState;
  const manualBroadcastInInput = context.entityTxs.some(tx => tx.type === 'j_broadcast');

  // Preserve WAL transaction order exactly during live processing and replay.
  // Reordering batched txs can change bilateral account state transitions
  // (e.g., openAccount + accountInput ACK in same frame).
  for (const entityTx of context.entityTxs) {
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
  }
  return currentEntityState;
}

type ProposePendingAccountFramesContext = {
  env: RuntimeState;
  currentEntityState: EntityState;
  proposableAccounts: Set<string>;
  requiredAccountResponses: Map<string, AccountPeerInput>;
  allOutputs: EntityInput[];
  collectedHashes: Array<{ hash: string; type: HashType; context: string }>;
  accountJClaimNodeStore: AccountJClaimNodeStore;
  storageChanges: RuntimeOverlayRecord[];
};

const certifiedAccountOutputSignerHint = (targetEntityId: string, input: AccountPeerInput): string | null => {
  const proposal = accountInputProposal(input);
  if (!proposal) return null;
  const target = targetEntityId.toLowerCase();
  const signerIds = new Set<string>();
  for (const tx of proposal.frame.accountTxs) {
    if (tx.type !== 'htlc_lock') continue;
    const encryptedLayer = encryptedHtlcLayer(tx.data.envelope);
    if (!encryptedLayer) continue;
    const expectedContextHash = computeHtlcEnvelopeContextHash({
      entityId: target,
      lockId: tx.data.lockId,
      hashlock: tx.data.hashlock,
      tokenId: tx.data.tokenId,
      amount: tx.data.amount,
      timelock: tx.data.timelock,
      revealBeforeHeight: tx.data.revealBeforeHeight,
    });
    const canonicalLayer = validateMultiRecipientCiphertext(encryptedLayer, target, expectedContextHash);
    const signerId = String(canonicalLayer.recipients[0]?.signerId || '')
      .trim()
      .toLowerCase();
    if (!signerId) throw new Error(`ACCOUNT_OUTPUT_CERTIFIED_SIGNER_MISSING:${tx.data.lockId}`);
    signerIds.add(signerId);
  }
  if (signerIds.size > 1) {
    throw new Error(`ACCOUNT_OUTPUT_CERTIFIED_SIGNER_CONFLICT:${target}:${[...signerIds].sort().join(',')}`);
  }
  return signerIds.values().next().value ?? null;
};

async function materializeDeferredSettlementApprovals(
  env: RuntimeState,
  state: EntityState,
  proposableAccounts: Set<string>,
  collectedHashes: Array<{ hash: string; type: HashType; context: string }>,
  storageChanges: RuntimeOverlayRecord[],
): Promise<void> {
  const deferred = state.deferredAccountProposals;
  if (!deferred || deferred.size === 0) return;
  for (const [accountId, approvedHash] of [...deferred.entries()].sort(([left], [right]) =>
    compareStableText(left, right),
  )) {
    const account = state.accounts.get(accountId);
    if (!account) throw new Error(`SETTLEMENT_DEFERRED_ACCOUNT_MISSING:${accountId}`);
    if (account.pendingFrame || hasPendingSettlementTransition(account)) continue;
    const workspace = account.settlementWorkspace;
    const currentHash = workspace ? assertCanonicalSettlementWorkspace(account, workspace) : undefined;
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
    if (account.mempool.length > 0 && !peerSealPinsAccountState) continue;
    const draft = buildSettlementSealDraft(account, state, accountId, env);
    const admission = await applyAccountInput(
      env,
      account,
      createLocalAccountInput(account, state.entityId, [draft.tx]),
    );
    if (admission.admittedAccountTxCount !== 1) {
      throw new Error(`SETTLEMENT_DEFERRED_SEAL_NOT_ADMITTED:${accountId}`);
    }
    recordFrameAccountChange(storageChanges, state.entityId, accountId);
    collectedHashes.push(...draft.hashesToSign);
    proposableAccounts.add(accountId);
    deferred.delete(accountId);
  }
}

type SettlementTransitionTx = Extract<AccountTx, { type: 'settle_transition' }>;
type SettlementSealTx = Omit<SettlementTransitionTx, 'data'> & {
  data: Extract<SettlementTransitionTx['data'], { kind: 'seal' }>;
};

function refreshStaleUncommittedSettlementSeals(state: EntityState, storageChanges: RuntimeOverlayRecord[]): void {
  for (const accountId of [...getQueuedAccountIds(state)].sort(compareStableText)) {
    const account = state.accounts.get(accountId);
    if (!account) throw new Error(`QUEUED_ACCOUNT_INDEX_STALE:${accountId}`);
    const workspace = account.settlementWorkspace;
    if (!workspace || workspace.nonceAtSign !== undefined || account.pendingFrame) continue;
    const workspaceHash = assertCanonicalSettlementWorkspace(account, workspace);
    const expectedNonce = getNextSettlementNonce(account);
    const staleSeals = account.mempool.filter(
      (tx): tx is SettlementSealTx =>
        tx.type === 'settle_transition' &&
        tx.data.kind === 'seal' &&
        tx.data.revision === workspace.revision &&
        tx.data.workspaceHash.toLowerCase() === workspaceHash &&
        tx.data.settlementNonce !== expectedNonce,
    );
    if (staleSeals.length === 0) continue;

    // A same-height Account tiebreaker can restore our uncommitted seal after
    // the winning peer frame has advanced the exact proof frontier. Never
    // mutate or tolerate that signed seal: discard only the local intent and
    // deterministically request a fresh Entity-quorum witness for this exact
    // workspace at the new nonce.
    const staleSet = new Set<AccountTx>(staleSeals);
    account.mempool = account.mempool.filter(tx => !staleSet.has(tx));
    recordFrameAccountChange(storageChanges, state.entityId, accountId);
    state.deferredAccountProposals ??= new Map();
    const existing = state.deferredAccountProposals.get(accountId);
    if (existing && existing !== workspaceHash) {
      throw new Error(`SETTLEMENT_REFRESH_DEFERRED_CONFLICT:${accountId}:${existing}:${workspaceHash}`);
    }
    state.deferredAccountProposals.set(accountId, workspaceHash);
    // This is the expected deterministic recovery path after a same-height
    // tiebreaker, not degraded operation. Keep the evidence without surfacing
    // a false browser warning that would imply operator action is required.
    entityLog.info('settlement.stale_seal_refreshed', {
      account: shortId(accountId),
      expectedNonce,
      staleNonces: staleSeals.map(tx => tx.data.settlementNonce).sort((left, right) => left - right),
    });
  }
}

type AccountFrameProposal = Awaited<ReturnType<typeof proposeAccountFrame>>;

const proposeAccountFrameCandidate = async (
  context: ProposePendingAccountFramesContext,
  accountKey: string,
  account: AccountState,
  crossJOpeningProposalTxs: AccountTx[] | undefined,
): Promise<AccountFrameProposal | undefined> => {
  const { env, currentEntityState: state, collectedHashes, proposableAccounts, storageChanges } = context;
  if (!accountHasProposableMempool(account, state)) return undefined;
  const proposal = await proposeAccountFrame(
    env,
    account,
    state.timestamp,
    state.lastFinalizedJHeight,
    context.accountJClaimNodeStore,
    crossJOpeningProposalTxs,
  );
  if (proposal.accountChanged) recordFrameAccountChange(storageChanges, state.entityId, accountKey);
  if (proposal.swapOffersCancelled?.length) {
    const cancels = proposal.swapOffersCancelled.map(({ offerId }) => ({ accountId: accountKey, offerId }));
    applyCommittedSwapCancelsToOrderbook(env, state, cancels, storageChanges);
  }
  if (proposal.hashesToSign) collectedHashes.push(...proposal.hashesToSign);
  for (const { hashlock, reason } of proposal.failedHtlcLocks ?? []) {
    const route = state.htlcRoutes.get(hashlock);
    if (!route) continue;
    if (route.outboundLockId) state.lockBook.delete(route.outboundLockId);
    if (route.inboundEntity && route.inboundLockId) {
      const inboundAccount = state.accounts.get(route.inboundEntity);
      if (inboundAccount) {
        const admission = await applyAccountInput(
          env,
          inboundAccount,
          createLocalAccountInput(inboundAccount, state.entityId, [{
          type: 'htlc_resolve',
          data: {
            lockId: route.inboundLockId,
            outcome: 'error',
            reason: `forward_failed:${reason}`,
          },
          }]),
        );
        if (admission.admittedAccountTxCount === 0) continue;
        recordFrameAccountChange(storageChanges, state.entityId, route.inboundEntity);
        proposableAccounts.add(route.inboundEntity);
      }
    }
    terminateHtlcRoute(state, hashlock, state.timestamp);
  }
  return proposal;
};

const assertRequiredAccountResponsePreserved = (
  accountKey: string,
  required: AccountPeerInput | undefined,
  final: AccountPeerInput,
): void => {
  if (!required) return;
  const requiredAck = accountInputAck(required);
  const requiredProposal = accountInputProposal(required);
  const finalAck = accountInputAck(final);
  const finalProposal = accountInputProposal(final);
  if (requiredAck && (!finalAck || safeStringify(finalAck) !== safeStringify(requiredAck))) {
    throw new Error(`ACCOUNT_REQUIRED_ACK_NOT_BUNDLED:${accountKey}:${requiredAck.height}`);
  }
  if (requiredProposal && (!finalProposal || safeStringify(finalProposal) !== safeStringify(requiredProposal))) {
    throw new Error(`ACCOUNT_REQUIRED_PROPOSAL_NOT_PRESERVED:${accountKey}:${requiredProposal.frame.height}`);
  }
};

const routeFinalAccountInput = async (
  context: ProposePendingAccountFramesContext,
  accountKey: string,
  account: AccountState,
  counterpartyId: string,
  input: AccountPeerInput,
  proposal: AccountFrameProposal | undefined,
): Promise<void> => {
  const { env, currentEntityState: state, allOutputs } = context;
  const encryptedSigner = certifiedAccountOutputSignerHint(input.toEntityId, input);
  const certifiedSigner = await resolveCertifiedAccountCounterpartyProposer(env, account, input.toEntityId);
  if (encryptedSigner && certifiedSigner && encryptedSigner !== certifiedSigner) {
    throw new Error(
      `ACCOUNT_OUTPUT_SIGNER_HINT_CONFLICT:${input.toEntityId}:${encryptedSigner}:${certifiedSigner}`,
    );
  }
  const signerId = encryptedSigner ?? certifiedSigner ?? resolveEntityProposerId(
    env,
    input.toEntityId,
    `account flush output ${state.entityId}->${input.toEntityId}`,
  );
  // Delivery metadata is validator-local and excluded from Entity roots.
  if (accountInputProposal(input)) account.pendingAccountInputSignerId = signerId;
  allOutputs.push({
    entityId: input.toEntityId,
    signerId,
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
    requiredAccountResponses,
  } = context;
  const processedAccounts = new Set<string>();
  let proposedFrames = 0;

  while (true) {
    const accountKey = [...proposableAccounts]
      .filter(candidate => !processedAccounts.has(candidate))
      .sort(compareStableText)[0];
    if (!accountKey) break;
    processedAccounts.add(accountKey);
    const account = currentEntityState.accounts.get(accountKey);
    const { counterparty: cpId } = account
      ? getAccountPerspective(account, currentEntityState.entityId)
      : { counterparty: 'unknown' };
    if (!account) {
      throw new Error(`ACCOUNT_FLUSH_ACCOUNT_MISSING:${accountKey}`);
    }

    const crossJOpeningProposalTxs = selectCrossJOpeningAccountProposalTxs(env, currentEntityState, account);
    if (crossJOpeningProposalTxs === null) {
      entityLog.debug('account.cross_j_opening_cohort_wait', {
        account: shortId(accountKey),
        entity: shortId(currentEntityState.entityId),
      });
      continue;
    }

    const requiredResponse = requiredAccountResponses.get(accountKey.toLowerCase());

    const proposal = await proposeAccountFrameCandidate(
      context,
      accountKey,
      account,
      crossJOpeningProposalTxs,
    );
    if (proposal) proposedFrames += 1;

    const finalAccountInput = proposal?.success && proposal.accountInput ? proposal.accountInput : requiredResponse;
    if (!finalAccountInput) continue;
    assertRequiredAccountResponsePreserved(accountKey, requiredResponse, finalAccountInput);
    await routeFinalAccountInput(
      context,
      accountKey,
      account,
      cpId,
      finalAccountInput,
      proposal,
    );
  }

  return proposedFrames;
}

type ApplyOrderbookMatchingContext = {
  env: RuntimeState;
  currentEntityState: EntityState;
  allSwapOffersCreated: SwapOfferEvent[];
  allOutputs: EntityInput[];
  proposableAccounts: Set<string>;
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
  env: RuntimeState,
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
  const { env, currentEntityState: state, allOutputs, proposableAccounts, storageChanges } = context;
  for (const { accountId, tx } of result.accountTxs) {
    const account = state.accounts.get(accountId);
    if (tx.type === 'swap_resolve') {
      const offer = account?.swapOffers?.get(tx.data.offerId);
      if (offer?.crossJurisdiction) {
        entityLog.warn('crossj.block_plain_swap_resolve', {
          offer: shortOrder(tx.data.offerId, 8),
          account: shortId(accountId, 8),
        });
        continue;
      }
      if (!account?.swapOffers?.has(tx.data.offerId)) {
        throw new Error(
          `ORDERBOOK_SWAP_OWNER_NOT_LOCAL: account=${accountId} offer=${tx.data.offerId} entity=${state.entityId}`,
        );
      }
    } else if (tx.type === 'cross_swap_fill_ack' && !account?.swapOffers?.has(tx.data.offerId)) {
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
          account ? 'source_offer_not_committed' : 'source_account_not_committed',
        );
        continue;
      }
      throw new Error(
        `CROSS_J_FILL_ACK_OWNER_MISSING: account=${accountId} offer=${tx.data.offerId} current=${state.entityId}`,
      );
    }
    if (!account) continue;
    const admission = await applyAccountInput(
      env,
      account,
      createLocalAccountInput(account, state.entityId, [tx]),
    );
    if (admission.admittedAccountTxCount === 0) continue;
    proposableAccounts.add(accountId);
    recordFrameAccountChange(storageChanges, state.entityId, accountId);
    entityLog.debug('orderbook.account_tx_queued', { account: shortId(accountId, 8), tx: tx.type });
  }
};

const commitOrderbookMatchResult = (
  context: ApplyOrderbookMatchingContext,
  result: OrderbookMatchResult,
): void => {
  const { env, currentEntityState: state, storageChanges } = context;
  if (result.debugProjectionRejects.length > 0) {
    const detail = result.debugProjectionRejects
      .map(({ accountId, offerId, reason }) => `${accountId.slice(-8)}:${offerId.slice(-8)}:${reason}`)
      .join(', ');
    throw new Error(`ORDERBOOK_LIVE_PROJECTION_REJECT: ${detail}`);
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
  for (const { pairId, book } of result.bookUpdates) {
    replaceOrderbookPair(ext, pairId, book);
    recordFrameBookChange(storageChanges, state.entityId, pairId);
  }
};

async function applyOrderbookMatching(
  context: ApplyOrderbookMatchingContext,
): Promise<OrderbookFrameStats> {
  const { env, currentEntityState, allSwapOffersCreated } = context;
  const stats = emptyOrderbookFrameStats();
  stats.hasPersistedCrossJurisdictionBook = Boolean(
    currentEntityState.orderbookExt &&
    Array.from(currentEntityState.orderbookExt.books?.keys?.() || []).some(pairId =>
      String(pairId).startsWith('cross:'),
    ),
  );
  if (
    (allSwapOffersCreated.length === 0 && !stats.hasPersistedCrossJurisdictionBook) ||
    !currentEntityState.orderbookExt
  ) {
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
  env: RuntimeState;
  currentEntityState: EntityState;
  allSwapCancelRequests: SwapCancelRequestEvent[];
  proposableAccounts: Set<string>;
  allOutputs: EntityInput[];
  storageChanges: RuntimeOverlayRecord[];
};

async function applySwapCancelRequests(
  context: ApplySwapCancelRequestsContext,
): Promise<void> {
  const { env, currentEntityState, allSwapCancelRequests, proposableAccounts, allOutputs, storageChanges } = context;
  if (allSwapCancelRequests.length === 0) return;

  const routedCancels = routeRemoteCrossJurisdictionBookCancels(env, currentEntityState, allSwapCancelRequests);
  allOutputs.push(...routedCancels.outputs);
  for (const { accountId, tx } of routedCancels.accountTxs) {
    if (tx.type !== 'cross_swap_fill_ack') {
      throw new Error(`CROSS_J_CANCEL_ACK_TX_INVALID:account=${accountId}:type=${tx.type}`);
    }
    const account = currentEntityState.accounts.get(accountId);
    if (!account) {
      throw new Error(`CROSS_J_CANCEL_ACK_ACCOUNT_MISSING:account=${accountId}:offer=${tx.data.offerId}`);
    }
    const admission = await applyAccountInput(
      env,
      account,
      createLocalAccountInput(account, currentEntityState.entityId, [tx]),
    );
    if (admission.admittedAccountTxCount === 0) continue;
    proposableAccounts.add(accountId);
    recordFrameAccountChange(storageChanges, currentEntityState.entityId, accountId);
  }

  const localBookCancels = routedCancels.localBookCancels;
  if (localBookCancels.length === 0) return;

  if (currentEntityState.orderbookExt) {
    const cancelResult = processOrderbookCancels(currentEntityState, localBookCancels);

    for (const { accountId, tx } of cancelResult.accountTxs) {
      const account = currentEntityState.accounts.get(accountId);
      if (!account) continue;
      const admission = await applyAccountInput(
        env,
        account,
        createLocalAccountInput(account, currentEntityState.entityId, [tx]),
      );
      if (admission.admittedAccountTxCount === 0) {
        continue;
      }
      proposableAccounts.add(accountId);
      recordFrameAccountChange(storageChanges, currentEntityState.entityId, accountId);
    }

    const ext = currentEntityState.orderbookExt as OrderbookExtState;
    for (const { pairId, book } of cancelResult.bookUpdates) {
      replaceOrderbookPair(ext, pairId, book);
      recordFrameBookChange(storageChanges, currentEntityState.entityId, pairId);
    }
    return;
  }

  // Fallback: counterparty resolves cancel directly when no orderbook extension is configured.
  for (const { accountId, offerId } of localBookCancels) {
    const account = currentEntityState.accounts.get(accountId);
    if (!account?.swapOffers?.has(offerId)) continue;
    const offer = account.swapOffers.get(offerId);
    if (offer?.crossJurisdiction) {
      throw new Error(
        `CROSS_J_ORDERBOOK_EXT_REQUIRED: cancel for ${offerId.slice(-8)} cannot use fallback swap_resolve`,
      );
    }
    // Fallback cancel resolution is synthesized by the orchestrator itself.
    // It must land in the same working-state mempool so the later account
    // proposal step sees it in this frame.
    const admission = await applyAccountInput(
      env,
      account,
      createLocalAccountInput(account, currentEntityState.entityId, [{
        type: 'swap_resolve',
        data: { offerId, fillRatio: 0, cancelRemainder: true },
      }]),
    );
    if (admission.admittedAccountTxCount === 0) {
      continue;
    }
    proposableAccounts.add(accountId);
    recordFrameAccountChange(storageChanges, currentEntityState.entityId, accountId);
  }
}

type EntityFrameResult = {
  newState: EntityState;
  outputs: EntityInput[];
  jOutputs: JInput[];
  candidateEffects: EntityCandidateEffect[];
  storageChanges: RuntimeOverlayRecord[];
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

const prepareEntityFrameWorkingSet = async (
  env: RuntimeState,
  entityState: EntityState,
  entityTxs: EntityTx[],
  frameTimestamp: number | undefined,
): Promise<EntityFrameWorkingSet> => {
  assertEntityFrameTxByteBudget(entityTxs);
  assertEntityFrameJRangeBudget(entityTxs);
  assertScheduledWakeFrameOrder(entityTxs);
  const crossJSetupPhase = entityTxs.some(entityTxContainsCrossJSetup);
  if (crossJSetupPhase && entityTxs.some(entityTxContainsAccountTransition)) {
    throw new Error('CROSS_J_SETUP_ACCOUNT_TRANSITION_MIXED');
  }
  const authorityTransitionOnly = await isSelfBoardAuthorityTransitionFrame(
    env,
    entityState,
    entityTxs,
  );
  const frameProfileStartMs = getPerfMs();
  const frameProfileMarks: Record<string, number> = {};
  const markFrameProfile = (label: string): void => {
    frameProfileMarks[label] = Math.round(getPerfMs() - frameProfileStartMs);
  };
  entityLog.debug('frame.apply', { txs: entityTxs.map(tx => tx.type) });
  const normalized = normalizeEntityProposalBoard(
    env,
    normalizeEntityCommandNonceBoard(env, entityState),
  );
  const currentEntityState = cloneEntityState(normalized);
  clearEntityFrameEvents(currentEntityState);
  currentEntityState.crontabState ??= initCrontab();
  markFrameProfile('clone');
  const effectiveTimestamp = frameTimestamp ?? env.timestamp;
  if (!Number.isSafeInteger(effectiveTimestamp) || effectiveTimestamp < 0) {
    throw new Error(`ENTITY_FRAME_TIMESTAMP_INVALID:${String(effectiveTimestamp)}`);
  }
  if (effectiveTimestamp < currentEntityState.timestamp) {
    throw new Error(
      `ENTITY_FRAME_TIMESTAMP_REGRESSION:previous=${currentEntityState.timestamp}:` +
      `proposed=${effectiveTimestamp}`,
    );
  }
  currentEntityState.timestamp = effectiveTimestamp;
  const accountJClaimNewNodes = new Map<string, AccountJClaimNode>();
  const committedClaimNodes = getAccountJClaimNodeStore(env);
  const context: ApplyEntityTxsInOrderContext = {
    env,
    entityTxs,
    currentEntityState,
    allOutputs: [],
    allJOutputs: [],
    collectedHashes: [],
    proposableAccounts: new Set(),
    requiredAccountResponses: new Map(),
    allSwapOffersCreated: [],
    allSwapCancelRequests: [],
    allSwapOffersCancelled: [],
    frameProfileTxTotals: new Map(),
    consumptionNewNodes: new Map(),
    consumptionReplacedNodeHashes: new Set(),
    accountJClaimNewNodes,
    accountJClaimReplacedNodeHashes: new Set(),
    accountJClaimNodeStore: {
      get: hash => accountJClaimNewNodes.get(hash) ?? committedClaimNodes.get(hash),
    },
    candidateEffects: [],
    storageChanges: [],
  };
  if (!authorityTransitionOnly) {
    await drainPendingCrossJurisdictionFillAcks(
      env,
      currentEntityState,
      context.proposableAccounts,
      context.storageChanges,
      context.candidateEffects,
    );
    await drainCommittedCrossJurisdictionCancelAcks(
      context.env,
      currentEntityState,
      context.proposableAccounts,
      context.storageChanges,
    );
    for (const accountId of getProposableAccountIds(currentEntityState)) {
      context.proposableAccounts.add(accountId);
    }
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
): EntityFrameResult => ({
  newState: currentEntityState,
  outputs: context.allOutputs,
  jOutputs: context.allJOutputs,
  candidateEffects: context.candidateEffects,
  storageChanges: mergeStorageOverlayRecords(undefined, context.storageChanges),
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
  prunedOriginatedHtlcRoutes: number;
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
    currentEntityState,
    allSwapCancelRequests: context.allSwapCancelRequests,
    proposableAccounts: context.proposableAccounts,
    allOutputs: context.allOutputs,
    storageChanges: context.storageChanges,
  });
  markFrameProfile('cancels');
  const orderbookStats = await applyOrderbookMatching({
    env: context.env,
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
    currentEntityState,
    context.proposableAccounts,
    context.storageChanges,
    context.candidateEffects,
  );
  await drainCommittedCrossJurisdictionCancelAcks(
    context.env,
    currentEntityState,
    context.proposableAccounts,
    context.storageChanges,
  );
  refreshStaleUncommittedSettlementSeals(currentEntityState, context.storageChanges);
  await materializeDeferredSettlementApprovals(
    context.env,
    currentEntityState,
    context.proposableAccounts,
    context.collectedHashes,
    context.storageChanges,
  );
  const accountsToProposeFramesCount = crossJSetupPhase
    ? 0
    : await proposePendingAccountFrames({
        env: context.env,
        currentEntityState,
        proposableAccounts: context.proposableAccounts,
        requiredAccountResponses: context.requiredAccountResponses,
        allOutputs: context.allOutputs,
        collectedHashes: context.collectedHashes,
        accountJClaimNodeStore: context.accountJClaimNodeStore,
        storageChanges: context.storageChanges,
      });
  markFrameProfile('accountProposals');
  // Account proposal construction mutates the Account replica envelope
  // (pending frame, Hanko and resend state). Refresh each dirty leaf only
  // after that final mutation. Doing it earlier would preserve a valid-looking
  // but stale incremental Entity root.
  for (const accountId of context.proposableAccounts) {
    invalidateEntityAccountCommitment(currentEntityState, accountId);
    refreshAccountWorkIndex(currentEntityState, accountId);
  }
  currentEntityState = assignCertifiedOutputIdentities(
    currentEntityState,
    context.allOutputs,
  );
  const prunedOriginatedHtlcRoutes = pruneSettledOriginatedHtlcRoutes(
    currentEntityState,
    currentEntityState.timestamp,
  );
  return {
    currentEntityState,
    orderbookStats,
    accountsToProposeFramesCount,
    prunedOriginatedHtlcRoutes,
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
    prunedOriginatedHtlcRoutes: post.prunedOriginatedHtlcRoutes,
    phases: cumulativeMarksToPhases(frameProfileMarks, elapsedMs),
    txTypeTotals: Array.from(context.frameProfileTxTotals.entries())
      .map(([type, value]) => ({ type, ...value }))
      .sort((left, right) => right.elapsedMs - left.elapsedMs)
      .slice(0, 16),
  });
};

export const applyEntityFrame = async (
  env: RuntimeState,
  entityState: EntityState,
  entityTxs: EntityTx[],
  frameTimestamp?: number,
): Promise<EntityFrameResult> => {
  const working = await prepareEntityFrameWorkingSet(
    env,
    entityState,
    entityTxs,
    frameTimestamp,
  );
  working.currentEntityState = await applyEntityTxsInOrder(working.context);
  working.markFrameProfile('entityTxLoop');
  const profileHash = buildCurrentEntityProfileHashToSign(working.currentEntityState);
  if (profileHash) working.context.collectedHashes.push(profileHash);
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
    return buildEntityFrameResult(
      working.currentEntityState,
      working.context,
    );
  }
  const post = await applyPostEntityTxPhases(working);
  logEntityFrameProfile(working, entityTxs, post);
  return buildEntityFrameResult(
    post.currentEntityState,
    working.context,
  );
};

// === HELPER FUNCTIONS ===

/**
 * Calculate quorum power based on validator shares
 */
