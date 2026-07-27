/**
 * Entity consensus: validator replicas agree on entity frames, then route
 * committed account/J-layer side effects back into the runtime.
 */

import { accountInputAck, accountInputProposal, accountInputReferenceHeight } from '../../account/consensus/flush';
import { proposeAccountFrame } from '../../account/consensus/propose';
import { resolveCertifiedAccountCounterpartyProposer } from '../../account/counterparty-route';
import { getAccountJClaimNodeStore } from '../../account/j-claim-store';
import { appendAccountMempoolTx } from '../../account/mempool';
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
import { compareStableText, safeStringify } from '../../protocol/serialization';
import { getNextSettlementNonce } from '../../protocol/settlement/operations';
import { assertScheduledWakeFrameOrder } from '../../runtime/scheduled-wake';
import {
  addMessages,
  cloneEntityState,
  emitScopedEvents,
  getAccountPerspective,
  resolveEntityProposerId,
} from '../../state-helpers';
import { mergeStorageOverlayRecords } from '../../storage/overlay';
import type {
  AccountInput,
  AccountTx,
  EntityCandidateEffect,
  EntityInput,
  EntityState,
  EntityTx,
  Env,
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
  type ConsumptionNode,
} from '../consumption-accumulator';
import { type ConsumptionNodeChanges } from '../consumption-store';
import {
  entityTxContainsAccountTransition,
  entityTxContainsCrossJSetup,
  selectCrossJOpeningAccountProposalTxs,
} from '../cross-j-proposer-materialization';
import { cancelHook, initCrontab, scheduleHook } from '../scheduler';
import { applyEntityTx } from '../tx';
import {
  normalizeSwapOfferForOrderbook,
  processOrderbookCancels,
  processOrderbookSwaps,
  routeRemoteCrossJurisdictionBookCancels,
  type SwapCancelEvent,
  type SwapCancelRequestEvent,
  type SwapOfferEvent,
} from '../tx/handlers/account';
import { buildCurrentEntityProfileHashToSign } from '../tx/handlers/profile-certification';
import { buildSettlementSealDraft } from '../tx/handlers/settle';
import { pruneSettledOriginatedHtlcRoutes, terminateHtlcRoute } from '../tx/htlc-route-lifecycle';
import { MalformedEntityFrameInputError } from '../tx/invariant-errors';
import { normalizeEntityProposalBoard } from '../tx/proposals';
import { accountHasProposableMempool } from './account-mempool-eligibility';
import { queueAccountMempoolTx } from './account-mempool-queue';
import { assertEntityFrameTxByteBudget } from './frame';
import { assignCertifiedOutputIdentities, verifyCertifiedEntityOutput } from './output-certification';
import { invalidateEntityAccountCommitment } from './state-root';

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

type ApplyEntityTxsInOrderContext = {
  env: Env;
  entityTxs: EntityTx[];
  currentEntityState: EntityState;
  allOutputs: EntityInput[];
  allJOutputs: JInput[];
  collectedHashes: Array<{ hash: string; type: HashType; context: string }>;
  proposableAccounts: Set<string>;
  requiredAccountResponses: Map<string, AccountInput>;
  allSwapOffersCreated: SwapOfferEvent[];
  allSwapCancelRequests: SwapCancelRequestEvent[];
  allSwapOffersCancelled: SwapCancelEvent[];
  frameProfileTxTotals: Map<string, { count: number; elapsedMs: number }>;
  consumptionNewNodes: Map<string, ConsumptionNode>;
  consumptionReplacedNodeHashes: Set<string>;
  accountJClaimNewNodes: Map<string, AccountJClaimNode>;
  accountJClaimReplacedNodeHashes: Set<string>;
  accountJClaimNodeStore: AccountJClaimNodeStore;
  candidateEffects: EntityCandidateEffect[];
  storageChanges: RuntimeOverlayRecord[];
  /** Set only after the enclosing SignedEntityCommand has been fully verified. */
  authorizedCommand?: true | undefined;
  /** Set only when a signed proposal has reached real weighted board quorum. */
  authorizedCollective?: true | undefined;
  /** Exact source-board Hanko lane for cross-Entity certified outputs. */
  authorizedCertifiedOutput?: true | undefined;
  /** Runtime-local proposer trust lane for cross-j sibling effects. */
  authorizedRuntimeOutput?: true | undefined;
};

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

async function applyEntityTxsInOrder(context: ApplyEntityTxsInOrderContext): Promise<EntityState> {
  const {
    env,
    entityTxs,
    allOutputs,
    allJOutputs,
    collectedHashes,
    proposableAccounts,
    requiredAccountResponses,
    allSwapOffersCreated,
    allSwapCancelRequests,
    allSwapOffersCancelled,
    frameProfileTxTotals,
  } = context;
  let currentEntityState = context.currentEntityState;
  const manualBroadcastInInput = entityTxs.some(tx => tx.type === 'j_broadcast');

  // Preserve WAL transaction order exactly during live processing and replay.
  // Reordering batched txs can change bilateral account state transitions
  // (e.g., openAccount + accountInput ACK in same frame).
  for (const entityTx of entityTxs) {
    if (entityTx.type === 'runtimeOutput') {
      currentEntityState = await applyRuntimeOutput(context, currentEntityState, entityTx);
      continue;
    }
    if (entityTx.type === 'consensusOutput') {
      currentEntityState = await applyCertifiedConsensusOutput(context, currentEntityState, entityTx);
      continue;
    }
    if (entityTx.type === 'entityCommand') {
      const command = assertSignedEntityCommand(env, currentEntityState, entityTx.data);
      if (getEntityCommandDisposition(currentEntityState, command) === 'retry') continue;
      const applied = await applyEntityTxsInOrder({
        ...context,
        entityTxs: command.txs,
        currentEntityState,
        authorizedCommand: true,
      });
      currentEntityState = advanceEntityCommandNonce(applied, command);
      continue;
    }
    if (!isEntityCommandForbiddenTx(entityTx)) {
      if (context.authorizedCommand && !isIndividualEntityCommandTx(entityTx)) {
        throw new Error(`ENTITY_COMMAND_COLLECTIVE_ACTION_REQUIRES_PROPOSAL:${entityTx.type}`);
      }
      if (context.authorizedCollective && !isCollectiveEntityActionTx(entityTx)) {
        throw new Error(`ENTITY_COLLECTIVE_ACTION_TX_FORBIDDEN:${entityTx.type}`);
      }
      if (
        !context.authorizedCommand &&
        !context.authorizedCollective &&
        !context.authorizedCertifiedOutput &&
        !context.authorizedRuntimeOutput
      ) {
        throw new Error(`ENTITY_COMMAND_REQUIRED:${entityTx.type}`);
      }
    }
    const txProfileStartMs = getPerfMs();
    const {
      newState,
      outputs,
      jOutputs,
      hashesToSign,
      mempoolOps,
      storageChanges,
      candidateEffects,
      requiredAccountResponse,
      swapOffersCreated,
      swapCancelRequests,
      swapOffersCancelled,
      accountJClaimNodeChanges,
      approvedEntityTxs,
      skippedError,
    } = await applyEntityTx(env, currentEntityState, entityTx, {
      mutableFrameState: true,
      manualBroadcastInInput,
      accountJClaimNodeStore: context.accountJClaimNodeStore,
    });
    if (skippedError) {
      throw new MalformedEntityFrameInputError(String(entityTx.type), skippedError);
    }
    currentEntityState = newState;
    context.storageChanges.push(...storageChanges);
    context.candidateEffects.push(...candidateEffects);
    if (accountJClaimNodeChanges) {
      for (const { hash, node } of accountJClaimNodeChanges.newNodes) {
        context.accountJClaimNewNodes.set(hash, node);
        context.accountJClaimReplacedNodeHashes.delete(hash);
      }
      for (const hash of accountJClaimNodeChanges.replacedNodeHashes) {
        if (!context.accountJClaimNewNodes.delete(hash)) context.accountJClaimReplacedNodeHashes.add(hash);
      }
    }
    if (approvedEntityTxs && approvedEntityTxs.length > 0) {
      currentEntityState = await applyEntityTxsInOrder({
        ...context,
        entityTxs: approvedEntityTxs,
        currentEntityState,
        authorizedCommand: undefined,
        authorizedCollective: true,
        authorizedCertifiedOutput: undefined,
        authorizedRuntimeOutput: undefined,
      });
    }
    if (requiredAccountResponse) {
      const accountId = requiredAccountResponse.toEntityId.toLowerCase();
      proposableAccounts.add(accountId);
      // Multiple authenticated AccountInputs for one bilateral lane can arrive
      // in one Runtime wave. Each response is derived after applying every
      // earlier input, so the last validated response is the only one that can
      // represent the final Account state. The Entity flush below emits it once
      // (or bundles its ACK into the successor proposal).
      requiredAccountResponses.set(accountId, structuredClone(requiredAccountResponse));
    }
    allOutputs.push(...outputs);
    if (jOutputs) allJOutputs.push(...jOutputs);
    if (hashesToSign && hashesToSign.length > 0) {
      collectedHashes.push(...hashesToSign);
    }

    // Entity handlers return mempoolOps; this orchestrator is the only place
    // that mutates account.mempool during entity-frame application.
    if (mempoolOps && mempoolOps.length > 0) {
      for (const { accountId, tx } of mempoolOps) {
        const account = currentEntityState.accounts.get(accountId);
        if (tx.type === 'cross_swap_fill_ack' && !account?.swapOffers?.has(tx.data.offerId)) {
          const routed = buildCrossJurisdictionFillNoticeOutput(currentEntityState, accountId, tx);
          if (!routed) {
            if (ownsSourceHubRouteForFillAck(currentEntityState, tx)) {
              stashPendingCrossJurisdictionFillAck(
                env,
                currentEntityState,
                accountId,
                tx,
                account ? 'source_offer_not_committed' : 'source_account_not_committed',
              );
              continue;
            }
            throw new Error(
              `CROSS_J_FILL_ACK_ACCOUNT_OFFER_MISSING: account=${accountId} offer=${tx.data.offerId} ` +
                `entity=${currentEntityState.entityId}`,
            );
          }
          allOutputs.push(routed);
          entityLog.info('crossj.sibling_fill_notice_routed', {
            owner: shortId(routed.entityId, 8),
            account: shortId(accountId, 8),
            offer: shortOrder(tx.data.offerId, 8),
          });
          continue;
        }
        if (account) {
          if (!queueAccountMempoolTx(account, tx)) {
            continue;
          }
          proposableAccounts.add(accountId);
          recordFrameAccountChange(context.storageChanges, currentEntityState.entityId, accountId);

          if (tx.type === 'htlc_lock' && tx.data?.timelock && tx.data?.lockId) {
            if (currentEntityState.crontabState) {
              scheduleHook(currentEntityState.crontabState, {
                id: `htlc-timeout:${tx.data.lockId}`,
                triggerAt: Number(tx.data.timelock),
                type: 'htlc_timeout',
                data: { accountId, lockId: tx.data.lockId },
              });
            }
          }

          if (tx.type === 'htlc_resolve' && tx.data?.lockId) {
            if (currentEntityState.crontabState) {
              cancelHook(currentEntityState.crontabState, `htlc-timeout:${tx.data.lockId}`);
            }
          }
        } else if (tx.type === 'cross_swap_fill_ack') {
          throw new Error(
            `CROSS_J_FILL_ACK_ACCOUNT_MISSING: account=${accountId} offer=${tx.data.offerId} entity=${currentEntityState.entityId}`,
          );
        } else {
          entityLog.warn('mempool_op.account_missing', { account: shortId(accountId, 8), tx: tx.type });
        }
      }
    }

    if (swapOffersCreated) {
      for (const offer of swapOffersCreated) {
        // Every cross-j offer still passes through the canonical admission gate
        // in applyOrderbookMatching: non-owners are ignored and incomplete
        // source/target receipts remain pending. Do not filter by the outer
        // EntityTx type here. When the canonical source hub commits its Account
        // pull, the second receipt and swap_offer can become authoritative in
        // this accountInput itself; dropping that pure event leaves an admitted
        // route permanently absent from the shared book.
        allSwapOffersCreated.push(offer);
      }
    }
    if (swapCancelRequests) {
      for (const cancel of swapCancelRequests) {
        const offer = currentEntityState.accounts.get(cancel.accountId)?.swapOffers?.get(cancel.offerId);
        if (
          offer?.crossJurisdiction &&
          normalizeEntityRef(currentEntityState.entityId) !==
            normalizeEntityRef(offer.crossJurisdiction.source.counterpartyEntityId)
        ) {
          // Both Account replicas observe the committed request, but only the
          // source hub owns the order lifecycle. The source user must not run a
          // local orderbook fallback or send a diagonal Entity message.
          continue;
        }
        allSwapCancelRequests.push(cancel);
      }
    }
    if (swapOffersCancelled) allSwapOffersCancelled.push(...swapOffersCancelled);

    if (entityTx.type === 'accountInput' && entityTx.data) {
      const fromEntity = entityTx.data.fromEntityId;
      const accountMachine = currentEntityState.accounts.get(fromEntity);

      if (accountMachine) {
        if (accountHasProposableMempool(accountMachine, currentEntityState)) {
          proposableAccounts.add(fromEntity);
        }
      }
    } else if (entityTx.type === 'directPayment' && entityTx.data) {
      for (const [counterpartyId, accountMachine] of currentEntityState.accounts) {
        if (accountHasProposableMempool(accountMachine, currentEntityState)) {
          proposableAccounts.add(counterpartyId);
        }
      }
    } else if (entityTx.type === 'openAccount' && entityTx.data) {
      const targetEntity = entityTx.data.targetEntityId;
      const accountMachine = currentEntityState.accounts.get(targetEntity);
      if (accountMachine) {
        if (accountHasProposableMempool(accountMachine, currentEntityState)) {
          proposableAccounts.add(targetEntity);
        }
      }
    } else if (entityTx.type === 'extendCredit' && entityTx.data) {
      const counterpartyId = entityTx.data.counterpartyEntityId;
      const accountMachine = currentEntityState.accounts.get(counterpartyId);
      if (accountMachine && accountHasProposableMempool(accountMachine, currentEntityState)) {
        proposableAccounts.add(counterpartyId);
      }
    }
    drainPendingCrossJurisdictionFillAcks(env, currentEntityState, proposableAccounts, context.storageChanges);
    drainCommittedCrossJurisdictionCancelAcks(currentEntityState, proposableAccounts, context.storageChanges);
    const txElapsedMs = Math.round(getPerfMs() - txProfileStartMs);
    const txProfile = frameProfileTxTotals.get(entityTx.type) ?? { count: 0, elapsedMs: 0 };
    txProfile.count += 1;
    txProfile.elapsedMs += txElapsedMs;
    frameProfileTxTotals.set(entityTx.type, txProfile);
  }

  return currentEntityState;
}

type ProposePendingAccountFramesContext = {
  env: Env;
  currentEntityState: EntityState;
  proposableAccounts: Set<string>;
  requiredAccountResponses: Map<string, AccountInput>;
  allOutputs: EntityInput[];
  collectedHashes: Array<{ hash: string; type: HashType; context: string }>;
  accountJClaimNodeStore: AccountJClaimNodeStore;
  storageChanges: RuntimeOverlayRecord[];
};

const certifiedAccountOutputSignerHint = (targetEntityId: string, input: AccountInput): string | null => {
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

function materializeDeferredSettlementApprovals(
  env: Env,
  state: EntityState,
  proposableAccounts: Set<string>,
  collectedHashes: Array<{ hash: string; type: HashType; context: string }>,
  storageChanges: RuntimeOverlayRecord[],
): void {
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
    appendAccountMempoolTx(account, draft.tx, `entityConsensus:settlementSeal:${accountId}`);
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
  for (const [accountId, account] of [...state.accounts.entries()].sort(([left], [right]) =>
    compareStableText(left, right),
  )) {
    const workspace = account.settlementWorkspace;
    if (!workspace || workspace.nonceAtSign !== undefined || account.pendingFrame) continue;
    const workspaceHash = assertCanonicalSettlementWorkspace(account, workspace);
    const expectedNonce = getNextSettlementNonce(account);
    const staleSeals = account.mempool.filter(
      (tx): tx is SettlementSealTx =>
        tx.type === 'settle_transition' &&
        tx.data.kind === 'seal' &&
        tx.data.version === workspace.version &&
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

async function proposePendingAccountFrames(context: ProposePendingAccountFramesContext): Promise<number> {
  const {
    env,
    currentEntityState,
    proposableAccounts,
    requiredAccountResponses,
    allOutputs,
    collectedHashes,
    accountJClaimNodeStore,
    storageChanges,
  } = context;
  const processedAccounts = new Set<string>();
  let proposedFrames = 0;

  while (true) {
    const accountKey = [...proposableAccounts]
      .filter(candidate => !processedAccounts.has(candidate))
      .sort(compareStableText)[0];
    if (!accountKey) break;
    processedAccounts.add(accountKey);
    const accountMachine = currentEntityState.accounts.get(accountKey);
    const { counterparty: cpId } = accountMachine
      ? getAccountPerspective(accountMachine, currentEntityState.entityId)
      : { counterparty: 'unknown' };
    if (!accountMachine) {
      throw new Error(`ACCOUNT_FLUSH_ACCOUNT_MISSING:${accountKey}`);
    }

    const crossJOpeningProposalTxs = selectCrossJOpeningAccountProposalTxs(env, currentEntityState, accountMachine);
    if (crossJOpeningProposalTxs === null) {
      entityLog.debug('account.cross_j_opening_cohort_wait', {
        account: shortId(accountKey),
        entity: shortId(currentEntityState.entityId),
      });
      continue;
    }

    const requiredResponse = requiredAccountResponses.get(accountKey.toLowerCase());

    let proposal: Awaited<ReturnType<typeof proposeAccountFrame>> | undefined;
    if (accountHasProposableMempool(accountMachine, currentEntityState)) {
      proposal = await proposeAccountFrame(
        env,
        accountMachine,
        currentEntityState.timestamp,
        currentEntityState.lastFinalizedJHeight,
        accountJClaimNodeStore,
        crossJOpeningProposalTxs,
      );
      if (proposal.accountChanged) {
        storageChanges.push({
          family: 'account',
          entityId: currentEntityState.entityId,
          counterpartyId: accountKey,
        });
      }
      proposedFrames += 1;
      if (proposal.swapOffersCancelled && proposal.swapOffersCancelled.length > 0) {
        const normalizedCancels = proposal.swapOffersCancelled.map(({ offerId }) => ({
          accountId: accountKey,
          offerId,
        }));
        applyCommittedSwapCancelsToOrderbook(env, currentEntityState, normalizedCancels, storageChanges);
      }
      if (proposal.hashesToSign) collectedHashes.push(...proposal.hashesToSign);

      if (proposal.failedHtlcLocks && proposal.failedHtlcLocks.length > 0) {
        for (const { hashlock, reason } of proposal.failedHtlcLocks) {
          const route = currentEntityState.htlcRoutes.get(hashlock);
          if (!route) continue;
          if (route.outboundLockId) currentEntityState.lockBook.delete(route.outboundLockId);
          if (route.inboundEntity && route.inboundLockId) {
            const inboundAccount = currentEntityState.accounts.get(route.inboundEntity);
            if (inboundAccount) {
              appendAccountMempoolTx(
                inboundAccount,
                {
                  type: 'htlc_resolve',
                  data: {
                    lockId: route.inboundLockId,
                    outcome: 'error' as const,
                    reason: `forward_failed:${reason}`,
                  },
                },
                `entityConsensus:failedHtlc:${route.inboundEntity}`,
              );
              recordFrameAccountChange(storageChanges, currentEntityState.entityId, route.inboundEntity);
              proposableAccounts.add(route.inboundEntity);
            }
          }
          terminateHtlcRoute(currentEntityState, hashlock, currentEntityState.timestamp);
        }
      }
    }

    const finalAccountInput = proposal?.success && proposal.accountInput ? proposal.accountInput : requiredResponse;
    if (!finalAccountInput) continue;
    if (requiredResponse) {
      const requiredAck = accountInputAck(requiredResponse);
      const requiredProposal = accountInputProposal(requiredResponse);
      const finalAck = accountInputAck(finalAccountInput);
      const finalProposal = accountInputProposal(finalAccountInput);
      if (requiredAck && (!finalAck || safeStringify(finalAck) !== safeStringify(requiredAck))) {
        throw new Error(`ACCOUNT_REQUIRED_ACK_NOT_BUNDLED:${accountKey}:${requiredAck.height}`);
      }
      if (requiredProposal && (!finalProposal || safeStringify(finalProposal) !== safeStringify(requiredProposal))) {
        throw new Error(`ACCOUNT_REQUIRED_PROPOSAL_NOT_PRESERVED:${accountKey}:${requiredProposal.frame.height}`);
      }
    }

    {
      const encryptedTargetSignerId = certifiedAccountOutputSignerHint(finalAccountInput.toEntityId, finalAccountInput);
      const certifiedTargetSignerId = await resolveCertifiedAccountCounterpartyProposer(
        env,
        accountMachine,
        finalAccountInput.toEntityId,
      );
      if (encryptedTargetSignerId && certifiedTargetSignerId && encryptedTargetSignerId !== certifiedTargetSignerId) {
        throw new Error(
          `ACCOUNT_OUTPUT_SIGNER_HINT_CONFLICT:${finalAccountInput.toEntityId}:` +
            `${encryptedTargetSignerId}:${certifiedTargetSignerId}`,
        );
      }
      const targetSignerId =
        encryptedTargetSignerId ??
        certifiedTargetSignerId ??
        resolveEntityProposerId(
          env,
          finalAccountInput.toEntityId,
          `account flush output ${currentEntityState.entityId}->${finalAccountInput.toEntityId}`,
        );
      // Persist validator-local delivery metadata beside the cached input so a
      // post-checkpoint resend does not require gossip to be online first.
      // The field is intentionally excluded from Entity consensus roots.
      if (accountInputProposal(finalAccountInput)) {
        accountMachine.pendingAccountInputSignerId = targetSignerId;
      }
      const outputEntityInput: EntityInput = {
        entityId: finalAccountInput.toEntityId,
        signerId: targetSignerId,
        entityTxs: [
          {
            type: 'accountInput' as const,
            data: finalAccountInput,
          },
        ],
      };
      allOutputs.push(outputEntityInput);

      if (proposal) {
        addMessages(currentEntityState, proposal.events);
        emitScopedEvents(
          env,
          'account',
          `E/A/${currentEntityState.entityId.slice(-4)}:${cpId.slice(-4)}/propose`,
          proposal.events,
          {
            entityId: currentEntityState.entityId,
            counterpartyId: cpId,
            frameHeight: accountInputReferenceHeight(finalAccountInput),
            accountKey,
          },
          currentEntityState.entityId,
        );
      }
    }
  }

  return proposedFrames;
}

type ApplyOrderbookMatchingContext = {
  env: Env;
  currentEntityState: EntityState;
  allSwapOffersCreated: SwapOfferEvent[];
  allOutputs: EntityInput[];
  proposableAccounts: Set<string>;
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

function applyOrderbookMatching(context: ApplyOrderbookMatchingContext): OrderbookFrameStats {
  const { env, currentEntityState, allSwapOffersCreated, allOutputs, proposableAccounts, storageChanges } = context;
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

  const enrichedOffers = allSwapOffersCreated.map(offer => {
    // The hub's account map is keyed by counterparty. The maker side can be
    // either left or right, so derive accountId from the side opposite hub.
    const hubId = currentEntityState.entityId;
    const hubEntity = normalizeEntityRef(hubId);
    const fromEntity = normalizeEntityRef(offer.fromEntity);
    const toEntity = normalizeEntityRef(offer.toEntity);
    const counterparty = fromEntity === hubEntity ? toEntity : fromEntity;
    return normalizeSwapOfferForOrderbook(offer, counterparty);
  });
  const seenOfferKeys = new Set<string>();
  const offersToMatch: WorkingOrderbookOffer[] = [];
  for (const offer of enrichedOffers) {
    const key = swapKey(offer.accountId, offer.offerId);
    if (seenOfferKeys.has(key)) continue;
    seenOfferKeys.add(key);
    if (
      offer.crossJurisdiction &&
      crossJurisdictionBookOwnerRef(offer.crossJurisdiction) !== normalizeEntityRef(currentEntityState.entityId)
    ) {
      entityLog.debug('crossj.orderbook.skip_non_owner', {
        offer: shortOrder(offer.offerId, 8),
        owner: shortId(crossJurisdictionBookOwnerRef(offer.crossJurisdiction), 8),
        current: shortId(currentEntityState.entityId, 8),
      });
      continue;
    }
    const admittedOffer = admitOrderbookOfferForMatching(env, currentEntityState, offer);
    if (admittedOffer) offersToMatch.push(admittedOffer);
  }
  entityLog.debug('orderbook.offers_enriched', {
    local: enrichedOffers.length,
    admitted: offersToMatch.length,
  });

  const matchResult = processOrderbookSwaps(currentEntityState, offersToMatch, { runtimeEnv: env });
  stats.orderbookMatched = true;
  stats.orderbookMempoolOps = matchResult.mempoolOps.length;
  stats.orderbookBookUpdates = matchResult.bookUpdates.length;
  stats.orderbookCrossFills = matchResult.crossJurisdictionFills.length;

  // Orderbook matching returns pure mempoolOps/book updates. Applying the
  // returned account txs here is still orchestrator-owned mutation of the
  // cloned working state, not handler-side in-place state injection.
  for (const { accountId, tx } of matchResult.mempoolOps) {
    const account = currentEntityState.accounts.get(accountId);

    if (tx.type === 'swap_resolve') {
      const localOwnsOffer = Boolean(account?.swapOffers?.has(tx.data.offerId));
      const localOffer = account?.swapOffers?.get(tx.data.offerId);
      if (localOffer?.crossJurisdiction) {
        entityLog.warn('crossj.block_plain_swap_resolve', {
          offer: shortOrder(tx.data.offerId, 8),
          account: shortId(accountId, 8),
        });
        continue;
      }
      if (account && localOwnsOffer) {
        if (!queueAccountMempoolTx(account, tx)) {
          continue;
        }
        proposableAccounts.add(accountId);
        recordFrameAccountChange(storageChanges, currentEntityState.entityId, accountId);
        entityLog.debug('orderbook.account_tx_queued', { account: shortId(accountId, 8), tx: tx.type });
      } else {
        throw new Error(
          `ORDERBOOK_SWAP_OWNER_NOT_LOCAL: account=${accountId} offer=${tx.data.offerId} ` +
            `entity=${currentEntityState.entityId}`,
        );
      }
      continue;
    }

    if (tx.type === 'cross_swap_fill_ack') {
      const localOwnsOffer = Boolean(account?.swapOffers?.has(tx.data.offerId));
      if (account && localOwnsOffer) {
        if (!queueAccountMempoolTx(account, tx)) {
          continue;
        }
        proposableAccounts.add(accountId);
        recordFrameAccountChange(storageChanges, currentEntityState.entityId, accountId);
        entityLog.debug('crossj.local_fill_ack_queued', {
          account: shortId(accountId, 8),
          offer: shortOrder(tx.data.offerId, 8),
          ratio: tx.data.cumulativeFillRatio,
          cancel: tx.data.cancelRemainder,
        });
        entityLog.debug('orderbook.account_tx_queued', { account: shortId(accountId, 8), tx: tx.type });
        continue;
      }

      const routed = buildCrossJurisdictionFillNoticeOutput(currentEntityState, accountId, tx);
      if (!routed) {
        if (ownsSourceHubRouteForFillAck(currentEntityState, tx)) {
          stashPendingCrossJurisdictionFillAck(
            env,
            currentEntityState,
            accountId,
            tx,
            account ? 'source_offer_not_committed' : 'source_account_not_committed',
          );
          continue;
        }
        throw new Error(
          `CROSS_J_FILL_ACK_OWNER_MISSING: account=${accountId} offer=${tx.data.offerId} current=${currentEntityState.entityId}`,
        );
      }
      allOutputs.push(routed);
      entityLog.info('crossj.sibling_fill_notice_routed', {
        owner: shortId(routed.entityId, 8),
        account: shortId(accountId, 8),
        offer: shortOrder(tx.data.offerId, 8),
      });
      continue;
    }

    if (account) {
      if (!queueAccountMempoolTx(account, tx)) {
        continue;
      }
      proposableAccounts.add(accountId);
      recordFrameAccountChange(storageChanges, currentEntityState.entityId, accountId);
      entityLog.debug('orderbook.account_tx_queued', { account: shortId(accountId, 8), tx: tx.type });
    }
  }

  if (matchResult.debugProjectionRejects.length > 0) {
    const detail = matchResult.debugProjectionRejects
      .map(({ accountId, offerId, reason }) => `${accountId.slice(-8)}:${offerId.slice(-8)}:${reason}`)
      .join(', ');
    throw new Error(`ORDERBOOK_LIVE_PROJECTION_REJECT: ${detail}`);
  }

  if (matchResult.crossJurisdictionFills.length > 0) {
    entityLog.info('crossj.firm_fills_recorded', { count: matchResult.crossJurisdictionFills.length });
    for (const fill of matchResult.crossJurisdictionFills) {
      // Partial cross-j fills keep the original book row alive and matchable.
      // Only a terminal fill/cancel removes the row and moves admission into
      // resolving so the clear flow can claim/release the hash-ledger pulls.
      if (fill.cancelRemainder) {
        markCrossJurisdictionBookAdmissionResolving(
          currentEntityState,
          fill.route,
          deterministicEntityTimestamp(currentEntityState, env),
        );
      }
    }
  }

  const ext = currentEntityState.orderbookExt as OrderbookExtState;
  for (const { pairId, book } of matchResult.bookUpdates) {
    replaceOrderbookPair(ext, pairId, book);
    recordFrameBookChange(storageChanges, currentEntityState.entityId, pairId);
  }

  return stats;
}

type ApplySwapCancelRequestsContext = {
  env: Env;
  currentEntityState: EntityState;
  allSwapCancelRequests: SwapCancelRequestEvent[];
  proposableAccounts: Set<string>;
  allOutputs: EntityInput[];
  storageChanges: RuntimeOverlayRecord[];
};

function applySwapCancelRequests(context: ApplySwapCancelRequestsContext): void {
  const { env, currentEntityState, allSwapCancelRequests, proposableAccounts, allOutputs, storageChanges } = context;
  if (allSwapCancelRequests.length === 0) return;

  const routedCancels = routeRemoteCrossJurisdictionBookCancels(env, currentEntityState, allSwapCancelRequests);
  allOutputs.push(...routedCancels.outputs);
  for (const { accountId, tx } of routedCancels.mempoolOps) {
    if (tx.type !== 'cross_swap_fill_ack') {
      throw new Error(`CROSS_J_CANCEL_ACK_TX_INVALID:account=${accountId}:type=${tx.type}`);
    }
    const account = currentEntityState.accounts.get(accountId);
    if (!account) {
      throw new Error(`CROSS_J_CANCEL_ACK_ACCOUNT_MISSING:account=${accountId}:offer=${tx.data.offerId}`);
    }
    if (!queueAccountMempoolTx(account, tx)) continue;
    proposableAccounts.add(accountId);
    recordFrameAccountChange(storageChanges, currentEntityState.entityId, accountId);
  }

  const localBookCancels = routedCancels.localBookCancels;
  if (localBookCancels.length === 0) return;

  if (currentEntityState.orderbookExt) {
    const cancelResult = processOrderbookCancels(currentEntityState, localBookCancels);

    for (const { accountId, tx } of cancelResult.mempoolOps) {
      const account = currentEntityState.accounts.get(accountId);
      if (!account) continue;
      if (!queueAccountMempoolTx(account, tx)) {
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
    if (
      !queueAccountMempoolTx(account, {
        type: 'swap_resolve',
        data: { offerId, fillRatio: 0, cancelRemainder: true },
      })
    ) {
      continue;
    }
    proposableAccounts.add(accountId);
    recordFrameAccountChange(storageChanges, currentEntityState.entityId, accountId);
  }
}

export const applyEntityFrame = async (
  env: Env,
  entityState: EntityState,
  entityTxs: EntityTx[],
  // DETERMINISM: Validators pass proposedFrame.timestamp to match proposer's lockIds/timelocks.
  // Proposers pass env.timestamp (their local time when creating the frame).
  frameTimestamp?: number,
): Promise<{
  newState: EntityState;
  // State snapshot BEFORE account proposals (deterministic across proposer + validators)
  // Proposer must hash from this state to match validator verification
  deterministicState: EntityState;
  outputs: EntityInput[];
  jOutputs: JInput[];
  candidateEffects: EntityCandidateEffect[];
  storageChanges: RuntimeOverlayRecord[];
  // Hashes emitted during frame processing that need entity-quorum signing
  collectedHashes?: Array<{
    hash: string;
    type: HashType;
    context: string;
  }>;
  consumptionNodeChanges?: ConsumptionNodeChanges;
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
}> => {
  assertEntityFrameTxByteBudget(entityTxs);
  assertEntityFrameJRangeBudget(entityTxs);
  assertScheduledWakeFrameOrder(entityTxs);
  const crossJSetupPhase = entityTxs.some(entityTxContainsCrossJSetup);
  if (crossJSetupPhase && entityTxs.some(entityTxContainsAccountTransition)) {
    throw new Error('CROSS_J_SETUP_ACCOUNT_TRANSITION_MIXED');
  }
  const authorityTransitionOnly = await isSelfBoardAuthorityTransitionFrame(env, entityState, entityTxs);
  const frameProfileStartMs = getPerfMs();
  const frameProfileMarks: Record<string, number> = {};
  const frameProfileTxTotals = new Map<string, { count: number; elapsedMs: number }>();
  const markFrameProfile = (label: string): void => {
    frameProfileMarks[label] = Math.round(getPerfMs() - frameProfileStartMs);
  };
  entityLog.debug('frame.apply', { txs: entityTxs.map(tx => tx.type) });

  // Work on a clone so failed frame construction cannot leak mutations.
  const authorityNormalizedState = normalizeEntityProposalBoard(
    env,
    normalizeEntityCommandNonceBoard(env, entityState),
  );
  let currentEntityState = cloneEntityState(authorityNormalizedState);
  // Legacy/manual states may omit the scheduler. Its deterministic default is
  // consensus state, so initialize it only inside the proposed frame replay.
  // Mutating one replica before a frame commits creates a same-height fork.
  if (!currentEntityState.crontabState) currentEntityState.crontabState = initCrontab();
  markFrameProfile('clone');

  // Validators receive the proposer's frame timestamp; proposers use env.timestamp.
  // HTLC timelocks and lockIds must see this before handlers run.
  const effectiveFrameTimestamp = frameTimestamp ?? env.timestamp;
  if (!Number.isSafeInteger(effectiveFrameTimestamp) || effectiveFrameTimestamp < 0) {
    throw new Error(`ENTITY_FRAME_TIMESTAMP_INVALID:${String(effectiveFrameTimestamp)}`);
  }
  if (effectiveFrameTimestamp < currentEntityState.timestamp) {
    throw new Error(
      `ENTITY_FRAME_TIMESTAMP_REGRESSION:previous=${currentEntityState.timestamp}:proposed=${effectiveFrameTimestamp}`,
    );
  }
  currentEntityState.timestamp = effectiveFrameTimestamp;
  const allOutputs: EntityInput[] = [];
  const allJOutputs: JInput[] = [];
  const collectedHashes: Array<{
    hash: string;
    type: HashType;
    context: string;
  }> = [];
  const consumptionNewNodes = new Map<string, ConsumptionNode>();
  const consumptionReplacedNodeHashes = new Set<string>();
  const accountJClaimNewNodes = new Map<string, AccountJClaimNode>();
  const accountJClaimReplacedNodeHashes = new Set<string>();
  const storageChanges: RuntimeOverlayRecord[] = [];
  const candidateEffects: EntityCandidateEffect[] = [];
  const committedAccountJClaimNodes = getAccountJClaimNodeStore(env);
  const accountJClaimNodeStore: AccountJClaimNodeStore = {
    get: hash => accountJClaimNewNodes.get(hash) ?? committedAccountJClaimNodes.get(hash),
  };

  const proposableAccounts = new Set<string>();
  const requiredAccountResponses = new Map<string, AccountInput>();
  if (!authorityTransitionOnly) {
    drainPendingCrossJurisdictionFillAcks(env, currentEntityState, proposableAccounts, storageChanges);
    drainCommittedCrossJurisdictionCancelAcks(currentEntityState, proposableAccounts, storageChanges);
    for (const [accountId, accountMachine] of currentEntityState.accounts) {
      if (accountHasProposableMempool(accountMachine, currentEntityState)) {
        proposableAccounts.add(accountId);
      }
    }
  }

  const allSwapOffersCreated: SwapOfferEvent[] = [];
  const allSwapCancelRequests: SwapCancelRequestEvent[] = [];
  const allSwapOffersCancelled: SwapCancelEvent[] = [];

  currentEntityState = await applyEntityTxsInOrder({
    env,
    entityTxs,
    currentEntityState,
    allOutputs,
    allJOutputs,
    collectedHashes,
    proposableAccounts,
    requiredAccountResponses,
    allSwapOffersCreated,
    allSwapCancelRequests,
    allSwapOffersCancelled,
    frameProfileTxTotals,
    consumptionNewNodes,
    consumptionReplacedNodeHashes,
    accountJClaimNewNodes,
    accountJClaimReplacedNodeHashes,
    accountJClaimNodeStore,
    candidateEffects,
    storageChanges,
  });
  markFrameProfile('entityTxLoop');

  // A certified manifest makes the current public routing descriptor part of
  // every Entity frame's unified Hanko map. Derive it only after the complete
  // transaction list has applied: a certifyProfile followed by accountInput
  // must sign the final Account capacities, never an intermediate descriptor.
  const currentProfileHash = buildCurrentEntityProfileHashToSign(currentEntityState);
  if (currentProfileHash) collectedHashes.push(currentProfileHash);

  if (authorityTransitionOnly) {
    currentEntityState = assignCertifiedOutputIdentities(currentEntityState, allOutputs);
    entityLog.info('frame.board_authority_transition_only', {
      entity: shortId(currentEntityState.entityId),
      txs: entityTxs.length,
      finalizedJHeight: currentEntityState.lastFinalizedJHeight,
    });
    return {
      newState: currentEntityState,
      deterministicState: cloneEntityState(currentEntityState),
      outputs: allOutputs,
      jOutputs: allJOutputs,
      candidateEffects,
      storageChanges: mergeStorageOverlayRecords(undefined, storageChanges),
      collectedHashes,
      ...(consumptionNewNodes.size > 0 || consumptionReplacedNodeHashes.size > 0
        ? {
            consumptionNodeChanges: {
              newNodes: Array.from(consumptionNewNodes, ([hash, node]) => ({ hash, node })),
              replacedNodeHashes: Array.from(consumptionReplacedNodeHashes).sort(),
            },
          }
        : {}),
      ...(accountJClaimNewNodes.size > 0 || accountJClaimReplacedNodeHashes.size > 0
        ? {
            accountJClaimNodeChanges: {
              newNodes: Array.from(accountJClaimNewNodes, ([hash, node]) => ({ hash, node })),
              replacedNodeHashes: Array.from(accountJClaimReplacedNodeHashes).sort(),
            },
          }
        : {}),
    };
  }

  // === APPLY AGGREGATED PURE EVENTS ===

  // 1. MempoolOps now applied inline (see above in the loop) to fix simultaneous payment bug
  // This section removed - mempoolOps are applied immediately after each applyEntityTx

  // Committed account-level cancels must be reflected in the persisted book
  // before the next matching pass. Otherwise a restored book can still expose
  // an order that the account frame has already removed.
  if (allSwapOffersCancelled.length > 0) {
    applyCommittedSwapCancelsToOrderbook(env, currentEntityState, allSwapOffersCancelled, storageChanges);
  }

  // A committed cancel has priority over every offer created in the same
  // Entity frame. Matching first permits a taker to fill liquidity after the
  // maker's bilateral Account has already committed its cancellation.
  applySwapCancelRequests({
    env,
    currentEntityState,
    allSwapCancelRequests,
    proposableAccounts,
    allOutputs,
    storageChanges,
  });
  markFrameProfile('cancels');

  const orderbookStats = applyOrderbookMatching({
    env,
    currentEntityState,
    allSwapOffersCreated,
    allOutputs,
    proposableAccounts,
    storageChanges,
  });
  markFrameProfile('orderbook');

  // Hash before account proposals so proposer and validators commit to the same
  // deterministic entity state.
  drainPendingCrossJurisdictionFillAcks(env, currentEntityState, proposableAccounts, storageChanges);
  drainCommittedCrossJurisdictionCancelAcks(currentEntityState, proposableAccounts, storageChanges);
  refreshStaleUncommittedSettlementSeals(currentEntityState, storageChanges);
  materializeDeferredSettlementApprovals(env, currentEntityState, proposableAccounts, collectedHashes, storageChanges);
  for (const accountId of proposableAccounts) {
    invalidateEntityAccountCommitment(currentEntityState, accountId);
  }
  const deterministicState = cloneEntityState(currentEntityState);
  markFrameProfile('deterministicClone');

  // Runtime-local source/target registrations are sibling effects of one
  // materialization frame. Flushing an Account proposal while only the first
  // sibling Entity frame has committed exposes a one-legged proposal. Keep the
  // Account mempool durable; the next ordinary wake observes both committed
  // sibling registrations and flushes the exact matched cohort.
  const accountsToProposeFramesCount = crossJSetupPhase
    ? 0
    : await proposePendingAccountFrames({
        env,
        currentEntityState,
        proposableAccounts,
        requiredAccountResponses,
        allOutputs,
        collectedHashes,
        accountJClaimNodeStore,
        storageChanges,
      });
  markFrameProfile('accountProposals');
  currentEntityState = assignCertifiedOutputIdentities(currentEntityState, allOutputs);

  const prunedOriginatedHtlcRoutes = pruneSettledOriginatedHtlcRoutes(currentEntityState, currentEntityState.timestamp);

  const frameElapsedMs = Math.round(getPerfMs() - frameProfileStartMs);
  if (entityFrameProfileEnabled() || frameElapsedMs >= entityFrameSlowMs()) {
    entityLog.info('frame.profile', {
      entity: String(currentEntityState.entityId || '').slice(-8),
      elapsedMs: frameElapsedMs,
      txs: entityTxs.length,
      txTypes: Array.from(new Set(entityTxs.map(tx => tx.type))).slice(0, 16),
      accountsToPropose: accountsToProposeFramesCount,
      outputs: allOutputs.length,
      jOutputs: allJOutputs.length,
      collectedHashes: collectedHashes.length,
      swapOffersCreated: allSwapOffersCreated.length,
      swapCancels: allSwapCancelRequests.length + allSwapOffersCancelled.length,
      hasOrderbookExt: Boolean(currentEntityState.orderbookExt),
      hasPersistedCrossJurisdictionBook: orderbookStats.hasPersistedCrossJurisdictionBook,
      orderbookMatched: orderbookStats.orderbookMatched,
      orderbookMempoolOps: orderbookStats.orderbookMempoolOps,
      orderbookBookUpdates: orderbookStats.orderbookBookUpdates,
      orderbookCrossFills: orderbookStats.orderbookCrossFills,
      prunedOriginatedHtlcRoutes,
      phases: cumulativeMarksToPhases(frameProfileMarks, frameElapsedMs),
      txTypeTotals: Array.from(frameProfileTxTotals.entries())
        .map(([type, value]) => ({ type, ...value }))
        .sort((left, right) => right.elapsedMs - left.elapsedMs)
        .slice(0, 16),
    });
  }

  return {
    newState: currentEntityState,
    deterministicState,
    outputs: allOutputs,
    jOutputs: allJOutputs,
    candidateEffects,
    storageChanges: mergeStorageOverlayRecords(undefined, storageChanges),
    collectedHashes,
    ...(consumptionNewNodes.size > 0 || consumptionReplacedNodeHashes.size > 0
      ? {
          consumptionNodeChanges: {
            newNodes: Array.from(consumptionNewNodes, ([hash, node]) => ({ hash, node })),
            replacedNodeHashes: Array.from(consumptionReplacedNodeHashes).sort(),
          },
        }
      : {}),
    ...(accountJClaimNewNodes.size > 0 || accountJClaimReplacedNodeHashes.size > 0
      ? {
          accountJClaimNodeChanges: {
            newNodes: Array.from(accountJClaimNewNodes, ([hash, node]) => ({ hash, node })),
            replacedNodeHashes: Array.from(accountJClaimReplacedNodeHashes).sort(),
          },
        }
      : {}),
  };
};

// === HELPER FUNCTIONS ===

/**
 * Calculate quorum power based on validator shares
 */
