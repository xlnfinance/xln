import { calculateQuorumPower } from '../entity-consensus';
import { requireUsableContractAddress } from '../contract-address';
import { isLeftEntity } from '../entity-id-utils';
import { formatEntityId } from '../utils';
import { normalizeEntityName } from '../networking/gossip';
import {
  applyCommand,
  createOrderbookExtState,
  getBookOrder,
  getOrderbookPairsForOrder,
  replaceOrderbookPair,
  validateSpreadDistribution,
  type OrderbookExtState,
} from '../orderbook';
import type { EntityState, EntityTx, Env, Proposal, Delta, AccountTx, EntityInput, JInput, HashType, CrossJurisdictionSwapRoute } from '../types';
import { DEFAULT_SOFT_LIMIT, DEFAULT_HARD_LIMIT, DEFAULT_MAX_FEE } from '../types';
import { DEBUG, log } from '../utils';
import { safeStringify } from '../serialization-utils';
import { announceLocalEntityProfile } from '../networking/gossip-helper';
import { markStorageAccountDirty, markStorageEntityDirty, recordOrderbookPairUpdate } from '../env-events';
import { upsertSortedStringMapEntry } from '../sorted-index';
// import { addToReserves, subtractFromReserves } from './financial'; // Currently unused
import {
  handleAccountInput,
  type MempoolOp,
  type SwapOfferEvent,
  type SwapCancelEvent,
  type SwapCancelRequestEvent,
} from './handlers/account';
import { handleJEvent } from './j-events';

// Extended return type including pure events from handlers
export interface ApplyEntityTxResult {
  newState: EntityState;
  outputs: EntityInput[];
  jOutputs?: JInput[];
  // Pure events for entity-level orchestration
  mempoolOps?: MempoolOp[];
  swapOffersCreated?: SwapOfferEvent[];
  swapCancelRequests?: SwapCancelRequestEvent[];
  swapOffersCancelled?: SwapCancelEvent[];
  // Multi-signer: Hashes that need entity-quorum signing
  hashesToSign?: Array<{ hash: string; type: HashType; context: string }>;
}
import { executeProposal, generateProposalId } from './proposals';
import { validateMessage } from './validation';
import { cloneEntityState, addMessage } from '../state-helpers';
import { logError } from '../logger';
import { FINANCIAL } from '../constants';
import { normalizeRebalanceMatchingStrategy } from '../rebalance-policy';
import { initJBatch, batchAddSettlement } from '../j-batch';
import { handleR2E } from './handlers/r2e';
import { handleHtlcPayment } from './handlers/htlc-payment';
import { generateLockId, hashHtlcSecret } from '../htlc-utils';
import { getRuntimeJurisdictionHeight, requireRuntimeJurisdictionDisputeDelayMs } from '../j-height';
import {
	buildCrossJurisdictionPullReveal,
	buildPreparedCrossJurisdictionRoute,
	getCrossJurisdictionPrivateSeed,
	isCrossJurisdictionPullExpired,
	isCrossJurisdictionRouteExpired,
	isCrossJurisdictionRouteTransitionAllowed,
	isCrossJurisdictionTerminalStatus,
	rememberCrossJurisdictionPrivateSeed,
	stripCrossJurisdictionPrivateData,
	validateCrossJurisdictionFillProgress,
	withCanonicalCrossJurisdictionRouteHash,
} from '../cross-jurisdiction';
import { decodeHashLadderBinary } from '../hashladder';
import { handleR2C } from './handlers/r2c';
import { handleE2R } from './handlers/e2r';
import { handleR2R } from './handlers/r2r';
import { handleJBroadcast } from './handlers/j-broadcast';
import { handleJRebroadcast } from './handlers/j-rebroadcast';
import { handleJAbortSentBatch } from './handlers/j-abort-sent-batch';
import { handleJClearBatch } from './handlers/j-clear-batch';
import { handleMintReserves } from './handlers/mint-reserves';
import { handleCreateSettlement } from './handlers/create-settlement';
import {
  handleSettleApprove,
  handleSettleExecute,
  handleSettlePropose,
  handleSettleReject,
  handleSettleUpdate,
} from './handlers/settle';
import { handleDisputeFinalize, handleDisputeStart } from './handlers/dispute';
import { buildCrossJurisdictionCancelAck } from '../cross-jurisdiction-orderbook';
import { assertSameJurisdictionAccount } from '../jurisdiction-runtime';

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();
const deterministicEntityTimestamp = (state: EntityState, env: Env): number =>
  Number(state.timestamp || env.timestamp || 0);
const cancelOrderbookOfferIfPresent = (
  env: Env,
  state: EntityState,
  accountId: string,
  offerId: string,
): boolean => {
  const ext = state.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return false;
  const namespacedOrderId = `${accountId}:${offerId}`;
  let removed = false;
  for (const pairId of getOrderbookPairsForOrder(ext, namespacedOrderId)) {
    const book = ext.books.get(pairId);
    if (!book) continue;
    const order = getBookOrder(book, namespacedOrderId);
    if (!order) continue;
    const result = applyCommand(book, {
      kind: 1,
      ownerId: order.ownerId,
      orderId: namespacedOrderId,
    });
    replaceOrderbookPair(ext, pairId, result.state);
    recordOrderbookPairUpdate(env, {
      entityId: state.entityId,
      pairId,
      book: result.state,
    });
    removed = true;
  }
  return removed;
};
const ENTITY_ID_HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
const isEntityId32 = (value: unknown): value is string => typeof value === 'string' && ENTITY_ID_HEX_32_RE.test(value);
const USD_SCALE = 10n ** 18n;
const toUsdWei = (value: number): bigint => BigInt(Math.max(0, Math.floor(value))) * USD_SCALE;
const resolveJurisdictionRebalanceDefaults = (
  entityState: EntityState,
): { r2cRequestSoftLimit: bigint; hardLimit: bigint; maxAcceptableFee: bigint } => {
  const raw = entityState.config?.jurisdiction?.rebalancePolicyUsd;
  if (!raw) {
    return {
      r2cRequestSoftLimit: DEFAULT_SOFT_LIMIT,
      hardLimit: DEFAULT_HARD_LIMIT,
      maxAcceptableFee: DEFAULT_MAX_FEE,
    };
  }
  const r2cRequestSoftLimit = toUsdWei(raw.r2cRequestSoftLimit);
  const hardLimit = toUsdWei(raw.hardLimit);
  const maxAcceptableFee = toUsdWei(raw.maxFee);
  if (r2cRequestSoftLimit <= 0n || hardLimit < r2cRequestSoftLimit) {
    return {
      r2cRequestSoftLimit: DEFAULT_SOFT_LIMIT,
      hardLimit: DEFAULT_HARD_LIMIT,
      maxAcceptableFee: DEFAULT_MAX_FEE,
    };
  }
  return { r2cRequestSoftLimit, hardLimit, maxAcceptableFee };
};

const findAccountKey = (state: EntityState, counterpartyId: string): string | null => {
  const target = normalizeEntityRef(counterpartyId);
  for (const key of state.accounts.keys()) {
    if (normalizeEntityRef(key) === target) return key;
  }
  return null;
};

const findCrossJurisdictionOfferRoute = (
  state: EntityState,
  orderId: string,
): { accountId: string; route: CrossJurisdictionSwapRoute } | null => {
  for (const [accountId, account] of state.accounts.entries()) {
    const route = account.swapOffers?.get(orderId)?.crossJurisdiction;
    if (route) return { accountId, route };
  }
  return null;
};

const mergeCrossJurisdictionRoute = (
  existing: CrossJurisdictionSwapRoute | undefined,
  next: CrossJurisdictionSwapRoute,
): CrossJurisdictionSwapRoute => {
  return {
    ...stripCrossJurisdictionPrivateData(existing ?? next),
    ...stripCrossJurisdictionPrivateData(next),
  };
};

const validateCrossJurisdictionRouteTransition = (
  existing: CrossJurisdictionSwapRoute | undefined,
  next: CrossJurisdictionSwapRoute,
): string | null => {
  if (!existing) return null;
  if (existing.routeHash && next.routeHash && existing.routeHash.toLowerCase() !== next.routeHash.toLowerCase()) {
    return 'route hash mismatch';
  }
  if (isCrossJurisdictionTerminalStatus(existing.status)) {
    return `terminal state ${existing.status}`;
  }
  if (!isCrossJurisdictionRouteTransitionAllowed(existing.status, next.status)) {
    return `invalid transition ${existing.status}->${next.status}`;
  }
  return null;
};

const isCrossJurisdictionRouteParticipant = (
  entityId: string,
  route: CrossJurisdictionSwapRoute,
): boolean => {
  const current = normalizeEntityRef(entityId);
  return [
    route.source.entityId,
    route.source.counterpartyEntityId,
    route.target.entityId,
    route.target.counterpartyEntityId,
    route.bookOwnerEntityId,
    route.hubEntityId,
  ].some(candidate => candidate && normalizeEntityRef(candidate) === current);
};

const accountHasPullResolveQueued = (
  account: EntityState['accounts'] extends Map<string, infer T> ? T : never,
  pullId: string,
): boolean => {
  const isResolve = (tx: AccountTx): boolean =>
    tx.type === 'pull_resolve' && tx.data.pullId === pullId;
  return account.mempool.some(isResolve) ||
    Boolean(account.pendingFrame?.accountTxs?.some(isResolve));
};

const accountHasCrossSwapAckQueued = (
  account: EntityState['accounts'] extends Map<string, infer T> ? T : never,
  offerId: string,
): boolean => {
  const isAck = (tx: AccountTx): boolean =>
    tx.type === 'cross_swap_fill_ack' && tx.data.offerId === offerId;
  return account.mempool.some(isAck) ||
    Boolean(account.pendingFrame?.accountTxs?.some(isAck));
};

export const applyEntityTx = async (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTx,
): Promise<ApplyEntityTxResult> => {
  if (!entityTx) {
    logError('ENTITY_TX', `❌ EntityTx is undefined!`);
    return { newState: entityState, outputs: [] };
  }

  try {
    markStorageEntityDirty(env, entityState.entityId);

    if (entityTx.type === 'chat') {
      const { from, message } = entityTx.data;

      if (!validateMessage(message)) {
        log.error(`❌ Invalid chat message from ${from}`);
        return { newState: entityState, outputs: [] }; // Return unchanged state
      }

      const currentNonce = entityState.nonces.get(from) || 0;
      const expectedNonce = currentNonce + 1;

      const newEntityState = cloneEntityState(entityState);

      newEntityState.nonces.set(from, expectedNonce);
      addMessage(newEntityState, `${from}: ${message}`);

      return { newState: newEntityState, outputs: [] };
    }

    if (entityTx.type === 'chatMessage') {
      // System-generated messages (e.g., from crontab dispute suggestions)
      const { message } = entityTx.data;
      const newEntityState = cloneEntityState(entityState);

      addMessage(newEntityState, message);

      return { newState: newEntityState, outputs: [] };
    }

    if (entityTx.type === 'propose') {
      const { action, proposer } = entityTx.data;
      const proposalId = generateProposalId(action, proposer, entityState);

      if (DEBUG) console.log(`    📝 Creating proposal ${proposalId} by ${proposer}: ${action.data.message}`);

      const proposal: Proposal = {
        id: proposalId,
        proposer,
        action,
        // explicitly type votes map to match Proposal.vote value type
        votes: new Map<string, 'yes' | 'no' | 'abstain' | { choice: 'yes' | 'no' | 'abstain'; comment: string }>([
          [proposer, 'yes'],
        ]),
        status: 'pending',
        created: entityState.timestamp,
      };

      const proposerPower = entityState.config.shares[proposer] || BigInt(0);
      const shouldExecuteImmediately = proposerPower >= entityState.config.threshold;

      let newEntityState = cloneEntityState(entityState);

      if (shouldExecuteImmediately) {
        proposal.status = 'executed';
        newEntityState = executeProposal(newEntityState, proposal);
        if (DEBUG)
          console.log(
            `    ⚡ Proposal executed immediately - proposer has ${proposerPower} >= ${entityState.config.threshold} threshold`,
          );
      } else {
        if (DEBUG)
          console.log(
            `    ⏳ Proposal pending votes - proposer has ${proposerPower} < ${entityState.config.threshold} threshold`,
          );
      }

      newEntityState.proposals.set(proposalId, proposal);
      return { newState: newEntityState, outputs: [] };
    }

    if (entityTx.type === 'vote') {
      console.log(`🗳️ PROCESSING VOTE: entityTx.data=`, entityTx.data);
      const { proposalId, voter, choice, comment } = entityTx.data;
      const proposal = entityState.proposals.get(proposalId);

      console.log(`🗳️ Vote lookup: proposalId=${proposalId}, found=${!!proposal}, status=${proposal?.status}`);
      console.log(`🗳️ Available proposals:`, Array.from(entityState.proposals.keys()));

      if (!proposal || proposal.status !== 'pending') {
        console.log(`    ❌ Vote ignored - proposal ${proposalId.slice(0, 12)}... not found or not pending`);
        return { newState: entityState, outputs: [] };
      }

      console.log(`    🗳️  Vote by ${voter}: ${choice} on proposal ${proposalId.slice(0, 12)}...`);

      const newEntityState = cloneEntityState(entityState);

      const updatedProposal = {
        ...proposal,
        votes: new Map(proposal.votes),
      };
      // Only create the object variant when comment is provided (comment must be string)
      const voteData: 'yes' | 'no' | 'abstain' | { choice: 'yes' | 'no' | 'abstain'; comment: string } =
        comment !== undefined ? ({ choice, comment } as { choice: 'yes' | 'no' | 'abstain'; comment: string }) : choice;
      updatedProposal.votes.set(voter, voteData);

      const yesVoters = Array.from(updatedProposal.votes.entries())
        .filter(([_voter, voteData]) => {
          const vote = typeof voteData === 'object' ? voteData.choice : voteData;
          return vote === 'yes';
        })
        .map(([voter, _voteData]) => voter);

      const totalYesPower = calculateQuorumPower(entityState.config, yesVoters);

      if (DEBUG) {
        const totalShares = Object.values(entityState.config.shares).reduce((sum, val) => sum + val, BigInt(0));
        const percentage = ((Number(totalYesPower) / Number(entityState.config.threshold)) * 100).toFixed(1);
        console.log(
          `    🔍 Proposal votes: ${totalYesPower} / ${totalShares} [${percentage}% threshold${Number(totalYesPower) >= Number(entityState.config.threshold) ? '+' : ''}]`,
        );
      }

      if (totalYesPower >= entityState.config.threshold) {
        updatedProposal.status = 'executed';
        const executedState = executeProposal(newEntityState, updatedProposal);
        executedState.proposals.set(proposalId, updatedProposal);
        return { newState: executedState, outputs: [] };
      }

      newEntityState.proposals.set(proposalId, updatedProposal);
      return { newState: newEntityState, outputs: [] };
    }

    if (entityTx.type === 'profile-update') {
      const profileData = entityTx.data.profile;
      if (!profileData || profileData.entityId !== entityState.entityId) {
        throw new Error(`PROFILE_UPDATE_INVALID_ENTITY: expected=${entityState.entityId} got=${String(profileData?.entityId || '')}`);
      }
      const newState = cloneEntityState(entityState);
      newState.profile = {
        name: normalizeEntityName(profileData.name ?? newState.profile?.name, newState.entityId),
        isHub: newState.profile.isHub,
        avatar: typeof profileData.avatar === 'string' ? profileData.avatar : (newState.profile?.avatar ?? ''),
        bio: typeof profileData.bio === 'string' ? profileData.bio : (newState.profile?.bio ?? ''),
        website: typeof profileData.website === 'string' ? profileData.website : (newState.profile?.website ?? ''),
      };
      newState.timestamp = env.timestamp;

      if (env.gossip) {
        announceLocalEntityProfile(env, newState, env.timestamp);
      }

      return { newState, outputs: [] };
    }

    if (entityTx.type === 'initOrderbookExt') {
      if (entityState.orderbookExt) {
        return { newState: entityState, outputs: [] };
      }

      if (!validateSpreadDistribution(entityTx.data.spreadDistribution)) {
        log.error(`❌ Invalid spread distribution for initOrderbookExt on ${formatEntityId(entityState.entityId)}`);
        return { newState: entityState, outputs: [] };
      }

      const hubProfile = {
        entityId: entityState.entityId,
        name: entityTx.data.name,
        spreadDistribution: entityTx.data.spreadDistribution,
        referenceTokenId: entityTx.data.referenceTokenId,
        minTradeSize: entityTx.data.minTradeSize,
        supportedPairs: [...entityTx.data.supportedPairs],
      };

      const newState = cloneEntityState(entityState);
      newState.orderbookExt = createOrderbookExtState(hubProfile);

      return { newState, outputs: [] };
    }

    if (entityTx.type === 'j_event') {
      const jEventData = entityTx.data as {
        event?: { type?: string };
        events?: Array<{ type?: string }>;
        blockNumber?: number;
        transactionHash?: string;
      };
      const firstEventType =
        jEventData.event?.type ??
        (Array.isArray(jEventData.events) && jEventData.events.length > 0 ? jEventData.events[0]?.type : undefined) ??
        'unknown';
      env.emit('JEventReceived', {
        entityId: entityState.entityId,
        eventType: firstEventType,
        blockNumber: jEventData.blockNumber,
        txHash: jEventData.transactionHash,
      });
      const { newState, mempoolOps, outputs } = await handleJEvent(entityState, entityTx.data, env);
      return { newState, outputs: outputs || [], mempoolOps: mempoolOps || [] };
    }

    if (entityTx.type === 'accountInput') {
      const result = await handleAccountInput(entityState, entityTx.data, env);
      markStorageAccountDirty(env, result.newState.entityId, entityTx.data.fromEntityId);
      return {
        newState: result.newState,
        outputs: result.outputs,
        mempoolOps: result.mempoolOps,
        swapOffersCreated: result.swapOffersCreated,
        swapCancelRequests: result.swapCancelRequests,
        swapOffersCancelled: result.swapOffersCancelled,
        ...(result.hashesToSign && result.hashesToSign.length > 0 && { hashesToSign: result.hashesToSign }),
      };
    }

    if (entityTx.type === 'openAccount') {
      const targetEntityId = entityTx.data.targetEntityId;
      if (!isEntityId32(targetEntityId)) {
        throw new Error(
          `INVALID_ENTITY_ID: openAccount targetEntityId must be bytes32 hex, got "${String(targetEntityId)}"`,
        );
      }
      // Account keyed by counterparty ID (simpler than canonical)
      const counterpartyId = normalizeEntityRef(targetEntityId);
      const isLeft = isLeftEntity(entityState.entityId, targetEntityId);
      assertSameJurisdictionAccount(env, entityState.entityId, entityState.config?.jurisdiction, targetEntityId);

      if (findAccountKey(entityState, counterpartyId)) {
        const error =
          `OPEN_ACCOUNT_ALREADY_EXISTS: entity=${formatEntityId(entityState.entityId)} ` +
          `counterparty=${formatEntityId(counterpartyId)}`;
        console.error(`❌ ${error}`);
        throw new Error(error);
      }

      console.log(
        `💳 OPEN-ACCOUNT: Opening account with ${counterpartyId} (counterparty: ${counterpartyId.slice(-4)})`,
      );

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];

      // Add chat message about account opening
      addMessage(newState, `💳 Opening account with Entity ${formatEntityId(entityTx.data.targetEntityId)}...`);

      // STEP 1: Create local account machine (idempotent across replay/live)
      const existingAccountKey = findAccountKey(newState, counterpartyId);
      const createdLocalAccount = !existingAccountKey;
      const accountKey = existingAccountKey ?? counterpartyId;
      if (createdLocalAccount) {
        env.emit('AccountOpening', {
          entityId: entityState.entityId,
          counterpartyId: targetEntityId,
        });
        console.log(`💳 LOCAL-ACCOUNT: Creating local account with Entity ${formatEntityId(counterpartyId)}...`);

        // CONSENSUS FIX: Start with empty deltas - let all delta creation happen through transactions
        // This ensures both sides have identical delta Maps (matches Channel.ts pattern)
        const initialDeltas = new Map<number, Delta>();

        // CANONICAL: Store leftEntity/rightEntity (sorted) for AccountMachine internals
        const leftEntity = isLeft ? entityState.entityId : counterpartyId;
        const rightEntity = isLeft ? counterpartyId : entityState.entityId;

        upsertSortedStringMapEntry(newState.accounts, accountKey, {
          leftEntity,
          rightEntity,
          status: 'active',
          mempool: [],
          currentFrame: {
            height: 0,
            // Deterministic account genesis: do not depend on mutable entity timestamp.
            // First proposed frame will use env.timestamp via proposeAccountFrame().
            timestamp: 0,
            jHeight: 0,
            accountTxs: [],
            prevFrameHash: '',
            deltas: [],
            stateHash: '',
            byLeft: isLeft,
          },
          deltas: initialDeltas,
          globalCreditLimits: {
            ownLimit: 0n, // Credit starts at 0 - must be explicitly extended via set_credit_limit
            peerLimit: 0n, // Credit starts at 0 - must be explicitly extended via set_credit_limit
          },
          // Frame-based consensus fields
          currentHeight: 0,
          pendingSignatures: [],
          rollbackCount: 0,
          // CHANNEL.TS REFERENCE: Proper message counters (NOT timestamps!)
          // Removed isProposer - use isLeft() function like old_src Channel.ts
          proofHeader: {
            fromEntity: entityState.entityId, // Perspective-dependent for signing
            toEntity: counterpartyId,
            nonce: 1, // Next unified on-chain nonce to use
          },
          proofBody: { tokenIds: [], deltas: [] },
          // Dispute configuration values are encoded in 10-block units.
          // 576 * 10 = 5760 blocks, roughly 24h at 15-second block time.
          disputeConfig: {
            leftDisputeDelay: 576,
            rightDisputeDelay: 576,
          },
          pendingWithdrawals: new Map(),
          requestedRebalance: new Map(),
          requestedRebalanceFeeState: new Map(),
          rebalancePolicy: new Map(),
          locks: new Map(), // HTLC: Initialize empty locks
          swapOffers: new Map(), // Swap: Initialize empty offers
          pulls: new Map(), // Pull: Initialize empty ratio-gated pulls
          swapOrderHistory: new Map(),
          swapClosedOrders: new Map(),
          // Bilateral J-event consensus
          leftJObservations: [],
          rightJObservations: [],
          jEventChain: [],
          lastFinalizedJHeight: 0,
          // On-chain settlement nonce (starts at 0, incremented on settlement success)
          // SYMMETRIC: Both sides increment via workspace status check in j-events.ts
          onChainSettlementNonce: 0,
        });
        markStorageAccountDirty(env, newState.entityId, counterpartyId);
        markStorageEntityDirty(env, newState.entityId);
      }

      // STEP 2: Add setup txs ONLY on LEFT side (Channel.ts pattern)
      // Right side waits for left's frame; otherwise it will re-propose add_delta and stall.
      console.log(`💳 Preparing account setup for ${formatEntityId(entityTx.data.targetEntityId)} (left=${isLeft})`);

      const localAccount = newState.accounts.get(accountKey);
      if (!localAccount) {
        throw new Error(`CRITICAL: Account machine not found after creation`);
      }

      // Token for delta (default: 1 = USDC)
      const tokenId = entityTx.data.tokenId ?? 1;
      const creditAmount = entityTx.data.creditAmount;

      if (createdLocalAccount) {
        // INITIATOR: always emit at least add_delta so the counterparty can
        // materialize the bilateral account via inbound accountInput.
        localAccount.mempool.push({ type: 'add_delta', data: { tokenId } });
        if (creditAmount && creditAmount > 0n) {
          localAccount.mempool.push({ type: 'set_credit_limit', data: { tokenId, amount: creditAmount } });
          console.log(`📝 Initiator queued [add_delta, set_credit_limit] (credit=${creditAmount})`);
        } else {
          console.log(`📝 Initiator queued [add_delta] (no initial credit)`);
        }

        // Seed per-account rebalance policy from openAccount payload when provided.
        // Falls back to runtime defaults for compatibility.
        const requestedPolicy = entityTx.data.rebalancePolicy;
        const jurisdictionPolicyDefaults = resolveJurisdictionRebalanceDefaults(newState);
        let autopilotSoftLimit = requestedPolicy?.r2cRequestSoftLimit ?? jurisdictionPolicyDefaults.r2cRequestSoftLimit;
        let autopilotHardLimit = requestedPolicy?.hardLimit ?? jurisdictionPolicyDefaults.hardLimit;
        let autopilotMaxFee = requestedPolicy?.maxAcceptableFee ?? jurisdictionPolicyDefaults.maxAcceptableFee;
        if (autopilotSoftLimit <= 0n) autopilotSoftLimit = jurisdictionPolicyDefaults.r2cRequestSoftLimit;
        if (autopilotHardLimit < autopilotSoftLimit) autopilotHardLimit = autopilotSoftLimit;
        if (autopilotMaxFee < 0n) autopilotMaxFee = jurisdictionPolicyDefaults.maxAcceptableFee;
        localAccount.rebalancePolicy.set(tokenId, {
          r2cRequestSoftLimit: autopilotSoftLimit,
          hardLimit: autopilotHardLimit,
          maxAcceptableFee: autopilotMaxFee,
        });
        localAccount.mempool.push({
          type: 'set_rebalance_policy',
          data: {
            tokenId,
            r2cRequestSoftLimit: autopilotSoftLimit,
            hardLimit: autopilotHardLimit,
            maxAcceptableFee: autopilotMaxFee,
          },
        });
        console.log(
          `🔄 Autopilot: rebalance policy set for token ${tokenId} ` +
          `(soft=${autopilotSoftLimit}, hard=${autopilotHardLimit}, maxFee=${autopilotMaxFee})`,
        );
      } else {
        throw new Error(
          `OPEN_ACCOUNT_ALREADY_EXISTS_AFTER_CLONE: entity=${formatEntityId(entityState.entityId)} ` +
          `counterparty=${formatEntityId(counterpartyId)}`,
        );
      }

      // Hub entities no longer auto-send faucet (use /api/faucet/offchain instead)

      // Add success message to chat
      addMessage(newState, `✅ Account opening request sent to Entity ${formatEntityId(counterpartyId)}`);

      // Do not mirror openAccount back to counterparty.
      // Counterparty account auto-creation happens on first inbound accountInput frame.
      // Mirroring openAccount creates redundant replay ordering hazards.

      // Broadcast updated profile to gossip layer
      if (env.gossip) {
        const profile = announceLocalEntityProfile(env, newState, env.timestamp);

        console.log(
          `🏗️ Built profile for ${newState.entityId.slice(-4)}: accounts=${profile.accounts.length} name=${profile.name}`,
        );
        console.log(
          `📡 Announcing profile ${newState.entityId.slice(-4)} ts=${profile.lastUpdated} accounts=${profile.accounts.length}`,
        );
      }

      return { newState, outputs };
    }

    if (entityTx.type === 'htlcPayment') {
      return await handleHtlcPayment(entityState, entityTx, env);
    }

    if (entityTx.type === 'hashlockPayment') {
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const {
        targetEntityId,
        tokenId,
        amount,
        hashlock,
        description,
      } = entityTx.data;
      const normalizedTarget = findAccountKey(newState, targetEntityId);
      if (!normalizedTarget) {
        addMessage(newState, `❌ Hashlock payment failed: no account with ${formatEntityId(targetEntityId)}`);
        return { newState, outputs, mempoolOps };
      }
      const amountBig = typeof amount === 'bigint' ? amount : BigInt(String(amount));
      if (amountBig <= 0n) {
        addMessage(newState, '❌ Hashlock payment failed: invalid amount');
        return { newState, outputs, mempoolOps };
      }
      if (!HEX_32_RE.test(hashlock)) {
        addMessage(newState, '❌ Hashlock payment failed: invalid hashlock');
        return { newState, outputs, mempoolOps };
      }

      const accountMachine = newState.accounts.get(normalizedTarget);
      const preparedLockId = typeof entityTx.data.lockId === 'string' ? entityTx.data.lockId : '';
      const explicitLockId = HEX_32_RE.test(preparedLockId);
      let lockNonce = (accountMachine?.currentHeight ?? 0) + (accountMachine?.mempool?.length ?? 0);
      let lockId = explicitLockId
        ? preparedLockId
        : generateLockId(hashlock, newState.height, lockNonce, newState.timestamp);
      while (
        !explicitLockId &&
        (
          accountMachine?.locks?.has(lockId) ||
          (accountMachine?.mempool ?? []).some((tx) => tx.type === 'htlc_lock' && tx.data.lockId === lockId) ||
          (accountMachine?.pendingFrame?.accountTxs ?? []).some((tx) => tx.type === 'htlc_lock' && tx.data.lockId === lockId)
        )
      ) {
        lockNonce += 1;
        lockId = generateLockId(hashlock, newState.height, lockNonce, newState.timestamp);
      }
      const timelock = entityTx.data.timelock !== undefined
        ? BigInt(entityTx.data.timelock)
        : BigInt(newState.timestamp + 120_000);
      const revealBeforeHeight = entityTx.data.revealBeforeHeight !== undefined
        ? Number(entityTx.data.revealBeforeHeight)
        : getRuntimeJurisdictionHeight(env, newState.lastFinalizedJHeight || 0) + 50;
      if (timelock <= BigInt(newState.timestamp) || !Number.isFinite(revealBeforeHeight) || revealBeforeHeight <= newState.lastFinalizedJHeight) {
        addMessage(newState, '❌ Hashlock payment failed: invalid deadline');
        return { newState, outputs, mempoolOps };
      }

      mempoolOps.push({
        accountId: normalizedTarget,
        tx: {
          type: 'htlc_lock',
          data: {
            lockId,
            hashlock,
            timelock,
            revealBeforeHeight,
            amount: amountBig,
            tokenId: Number(tokenId),
          },
        },
      });

      const startedAtMs = typeof entityTx.data.startedAtMs === 'number'
        ? entityTx.data.startedAtMs
        : newState.timestamp;
      newState.htlcRoutes.set(hashlock, {
        hashlock,
        tokenId: Number(tokenId),
        amount: amountBig,
        startedAtMs,
        outboundEntity: normalizedTarget,
        outboundLockId: lockId,
        ...(entityTx.data.crossJurisdictionRelay ? { crossJurisdictionRelay: entityTx.data.crossJurisdictionRelay } : {}),
        createdTimestamp: newState.timestamp,
      });
      newState.lockBook.set(lockId, {
        lockId,
        accountId: normalizedTarget,
        tokenId: Number(tokenId),
        amount: amountBig,
        hashlock,
        timelock,
        direction: 'outgoing',
        createdAt: BigInt(newState.timestamp),
      });
      if (description && typeof description === 'string') {
        if (!(newState.htlcNotes instanceof Map)) newState.htlcNotes = new Map();
        newState.htlcNotes.set(`hashlock:${hashlock}`, description);
        newState.htlcNotes.set(`lock:${lockId}`, description);
      }
      addMessage(newState, `🔒 Hashlock payment locked ${amountBig} token ${tokenId} to ${formatEntityId(normalizedTarget)}`);

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'resolveHtlcLock') {
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, lockId, secret } = entityTx.data;
      const normalizedCounterparty = findAccountKey(newState, counterpartyEntityId);
      if (!normalizedCounterparty) {
        addMessage(newState, `❌ HTLC resolve failed: no account with ${formatEntityId(counterpartyEntityId)}`);
        return { newState, outputs, mempoolOps };
      }
      if (!HEX_32_RE.test(lockId)) {
        addMessage(newState, '❌ HTLC resolve failed: invalid lock id');
        return { newState, outputs, mempoolOps };
      }
      let expectedHashlock: string | null = null;
      try {
        expectedHashlock = hashHtlcSecret(secret);
      } catch {
        addMessage(newState, '❌ HTLC resolve failed: invalid secret');
        return { newState, outputs, mempoolOps };
      }
      const account = newState.accounts.get(normalizedCounterparty);
      const lock = account?.locks?.get(lockId);
      if (lock && lock.hashlock !== expectedHashlock) {
        addMessage(newState, '❌ HTLC resolve failed: secret/hashlock mismatch');
        return { newState, outputs, mempoolOps };
      }
      mempoolOps.push({
        accountId: normalizedCounterparty,
        tx: {
          type: 'htlc_resolve',
          data: {
            lockId,
            outcome: 'secret',
            secret,
          },
        },
      });
      addMessage(newState, `🔓 HTLC resolve queued for ${formatEntityId(normalizedCounterparty)}`);
      const firstValidator = entityState.config.validators[0];
      if (firstValidator) outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'processHtlcTimeouts') {
      console.log(`⏰ PROCESS-HTLC-TIMEOUTS: Processing ${entityTx.data.expiredLocks?.length || 0} expired locks`);

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];

      // Convert expired locks to htlc_resolve(error:timeout)
      for (const { accountId, lockId } of entityTx.data.expiredLocks || []) {
        mempoolOps.push({
          accountId,
          tx: {
            type: 'htlc_resolve',
            data: { lockId, outcome: 'error' as const, reason: 'timeout' },
          },
        });
        console.log(`⏰   Queued timeout for lock ${lockId.slice(0, 16)}... on account ${accountId.slice(-4)}`);
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'rollbackTimedOutFrames') {
      console.log(
        `⏰ ROLLBACK-TIMED-OUT-FRAMES: Processing ${entityTx.data.timedOutAccounts.length} timed-out accounts`,
      );

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];

      for (const { counterpartyId, frameHeight } of entityTx.data.timedOutAccounts) {
        const accountMachine = newState.accounts.get(counterpartyId);
        if (!accountMachine?.pendingFrame) {
          console.log(`⏰   Account ${counterpartyId.slice(-4)}: no pendingFrame (already resolved)`);
          continue;
        }

        // Verify the frame height matches (avoid stale rollback)
        if (accountMachine.pendingFrame.height !== frameHeight) {
          console.log(
            `⏰   Account ${counterpartyId.slice(-4)}: frame height mismatch (pending=${accountMachine.pendingFrame.height}, expected=${frameHeight})`,
          );
          continue;
        }

        console.log(`⏰   Rolling back pendingFrame h${frameHeight} for account ${counterpartyId.slice(-4)}`);

        // Scan pending frame for HTLC locks that need backward cancellation
        for (const tx of accountMachine.pendingFrame.accountTxs) {
          if (tx.type === 'htlc_lock') {
            const hashlock = tx.data.hashlock;
            // Look up htlcRoute for backward cancellation
            const route = newState.htlcRoutes.get(hashlock);
            if (route && route.inboundEntity && route.inboundLockId) {
              mempoolOps.push({
                accountId: route.inboundEntity,
                tx: {
                  type: 'htlc_resolve',
                  data: {
                    lockId: route.inboundLockId,
                    outcome: 'error' as const,
                    reason: 'ack_timeout',
                  },
                },
              });
              console.log(
                `⬅️   HTLC cancel backward: hashlock=${hashlock.slice(0, 12)}... → inbound ${route.inboundEntity.slice(-4)}`,
              );
              newState.htlcRoutes.delete(hashlock);
            }
            // Don't re-add htlc_lock to mempool (it's being cancelled)
          } else {
            // Rollback path: these txs were already part of the failed pending
            // account frame. Restoring them to the same account mempool is the
            // inverse of that failed proposal, not a new handler-originated
            // mutation.
            accountMachine.mempool.push(tx);
            console.log(`📥   Restored ${tx.type} to mempool`);
          }
        }

        // Clear pending state (same as rollback in account-consensus.ts)
        delete accountMachine.pendingFrame;
        delete accountMachine.pendingAccountInput;
        delete accountMachine.clonedForValidation;
        console.log(
          `⏰   Account ${counterpartyId.slice(-4)}: pendingFrame cleared, mempool=${accountMachine.mempool.length}`,
        );
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'manualHtlcLock') {
      console.log(`🔒 MANUAL-HTLC-LOCK: Creating lock without envelope (timeout test)`);

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];

      const { counterpartyId, lockId, hashlock } = entityTx.data;
      // Type coercion: page.evaluate passes strings, htlc_lock needs bigint/number
      const timelock = BigInt(entityTx.data.timelock);
      const revealBeforeHeight = Number(entityTx.data.revealBeforeHeight);
      const amount = BigInt(entityTx.data.amount);
      const tokenId = Number(entityTx.data.tokenId);

      mempoolOps.push({
        accountId: counterpartyId,
        tx: {
          type: 'htlc_lock',
          data: {
            lockId,
            hashlock,
            timelock,
            revealBeforeHeight,
            amount,
            tokenId,
            // NO envelope - for timeout testing
          },
        },
      });

      console.log(
        `🔒   Queued htlc_lock for ${counterpartyId.slice(-4)}, lockId=${lockId.slice(0, 16)}..., amount=${amount}, timelock=${timelock}`,
      );

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'directPayment') {
      const verbose = env.quietRuntimeLogs !== true;
      env.emit('HtlcInitiated', {
        fromEntity: entityState.entityId,
        toEntity: entityTx.data.targetEntityId,
        tokenId: entityTx.data.tokenId,
        amount: entityTx.data.amount.toString(),
        route: entityTx.data.route,
      });
      if (verbose) {
        console.log(`💸 ═════════════════════════════════════════════════════════════`);
        console.log(
          `💸 DIRECT-PAYMENT HANDLER: ${entityState.entityId.slice(-4)} → ${entityTx.data.targetEntityId.slice(-4)}`,
        );
        console.log(`💸 Amount: ${entityTx.data.amount}, TokenId: ${entityTx.data.tokenId}`);
        console.log(`💸 Route: ${entityTx.data.route?.map(r => r.slice(-4)).join('→') || 'NONE (will calculate)'}`);
        console.log(`💸 Description: ${entityTx.data.description || 'none'}`);
      }

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      if (verbose) console.log(`💸 Initialized: outputs=[], mempoolOps=[]`);

      // Extract payment details
      let { targetEntityId, tokenId, amount, route, description } = entityTx.data;
      if (amount < FINANCIAL.MIN_PAYMENT_AMOUNT || amount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
        logError(
          'ENTITY_TX',
          `❌ Payment amount out of bounds: ${amount.toString()} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT.toString()}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT.toString()})`,
        );
        addMessage(newState, `❌ Payment failed: amount out of bounds`);
        return { newState, outputs: [] };
      }

      // If no route provided, check for direct account or calculate route
      if (!route || route.length === 0) {
        // Check if we have a direct account with target
        // Account keyed by counterparty ID
        if (newState.accounts.has(targetEntityId)) {
          if (verbose) console.log(`💸 Direct account exists with ${formatEntityId(targetEntityId)}`);
          route = [entityState.entityId, targetEntityId];
        } else {
          // Find route through network using gossip
          if (verbose) console.log(`💸 No direct account, finding route to ${formatEntityId(targetEntityId)}`);

          // Try to find a route through the network
          if (env.gossip) {
            const networkGraph = env.gossip.getNetworkGraph();
            const paths = await networkGraph.findPaths(entityState.entityId, targetEntityId, amount, tokenId);

            if (paths.length > 0) {
              // Use the shortest path
              const firstPath = paths[0];
              if (!firstPath) {
                throw new Error('ROUTE_DISCOVERY_INVARIANT: paths.length > 0 but paths[0] is missing');
              }
              route = firstPath.path;
              if (verbose) console.log(`💸 Found route: ${route.map(e => formatEntityId(e)).join(' → ')}`);
            } else {
              logError('ENTITY_TX', `❌ No route found to ${formatEntityId(targetEntityId)}`);
              addMessage(newState, `❌ Payment failed: No route to ${formatEntityId(targetEntityId)}`);
              return { newState, outputs: [] };
            }
          } else {
            logError('ENTITY_TX', `❌ Cannot find route: Gossip layer not available`);
            addMessage(newState, `❌ Payment failed: Network routing unavailable`);
            return { newState, outputs: [] };
          }
        }
      }

      // Validate route starts with current entity
      if (route.length < 1 || route[0] !== entityState.entityId) {
        console.error(
          `❌ ROUTE VALIDATION FAILED: route.length=${route.length}, route[0]=${route[0]?.slice(-4)}, entityId=${entityState.entityId.slice(-4)}`,
        );
        logError('ENTITY_TX', `❌ Invalid route: doesn't start with current entity`);
        return { newState: entityState, outputs: [] };
      }

      // Validate route ends with targetEntityId
      if (route[route.length - 1] !== targetEntityId) {
        console.error(
          `❌ ROUTE VALIDATION FAILED: route ends with ${route[route.length - 1]?.slice(-4)}, expected targetEntityId=${targetEntityId.slice(-4)}`,
        );
        logError('ENTITY_TX', `❌ Invalid route: route end must match targetEntityId`);
        return { newState: entityState, outputs: [] };
      }

      // Check if we're the final destination (route.length === 1)
      if (route.length === 1 && route[0] === targetEntityId) {
        console.error(`✅ FINAL DESTINATION: Entity ${entityState.entityId.slice(-4)} is the final recipient`);
        // This is a payment TO us (final hop) - handle as received payment
        // The payment was already applied in the bilateral consensus
        // Just add a message and return
        addMessage(newState, `💰 Received payment of ${amount} (token ${tokenId})`);
        return { newState, outputs: [] };
      }

      // Determine next hop (for intermediate forwarding)
      const nextHop = route[1];
      if (!nextHop) {
        console.error(`❌ ROUTE ERROR: No next hop in route=[${route.map(r => r.slice(-4)).join(',')}]`);
        logError('ENTITY_TX', `❌ Invalid route: no next hop specified in route`);
        return { newState, outputs: [] };
      }

      // Check if we have an account with next hop
      // Account keyed by counterparty ID
      const accountMachine = newState.accounts.get(nextHop);
      if (!accountMachine) {
        logError('ENTITY_TX', `❌ No account with next hop: ${nextHop}`);
        addMessage(newState, `❌ Payment failed: No account with ${formatEntityId(nextHop)}`);
        return { newState, outputs: [] };
      }

      // Capacity validation deferred to account-level (bilateral consensus)
      // Entity-level state may be stale before bilateral frames settle

      // Create AccountTx for the payment
      // CRITICAL: ALWAYS include fromEntityId/toEntityId for deterministic consensus
      const accountTx: AccountTx = {
        type: 'direct_payment',
        data: {
          tokenId,
          amount,
          route: route.slice(1), // Remove sender from route (next hop needs to see themselves in route[0])
          description: description || `Payment to ${formatEntityId(targetEntityId)}`,
          fromEntityId: entityState.entityId, // ✅ EXPLICIT direction
          toEntityId: nextHop, // ✅ EXPLICIT direction
        },
      };

      // Add to account machine mempool via pure mempoolOps
      if (accountMachine) {
        // Pure: return mempoolOp instead of mutating directly
        mempoolOps.push({ accountId: nextHop, tx: accountTx });
        if (verbose) {
          console.log(`💸 QUEUED TO MEMPOOL: account=${formatEntityId(nextHop)}`);
          console.log(`💸   AccountTx type: ${accountTx.type}`);
          console.log(`💸   Amount: ${accountTx.data.amount}`);
          console.log(`💸   From: ${accountTx.data.fromEntityId?.slice(-4)}`);
          console.log(`💸   To: ${accountTx.data.toEntityId?.slice(-4)}`);
          console.log(
            `💸   Route after slice: [${accountTx.data.route?.map((r: string) => r.slice(-4)).join(',') || 'none'}]`,
          );
          console.log(`💸 mempoolOps.length: ${mempoolOps.length}`);
        }

        const isLeft = isLeftEntity(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
        if (verbose) console.log(`💸 Account state: isLeft=${isLeft}, hasPendingFrame=${!!accountMachine.pendingFrame}`);

        // Message about payment initiation
        addMessage(
          newState,
          `💸 Sending ${amount} (token ${tokenId}) to ${formatEntityId(targetEntityId)} via ${route.length - 1} hops`,
        );

        // The payment is now queued for entity-level orchestration
        // Entity-consensus will apply mempoolOps and add to proposableAccounts
        if (verbose) {
          console.log(`💸 Payment queued for bilateral consensus with ${formatEntityId(nextHop)}`);
          console.log(`💸 Account ${formatEntityId(nextHop)} will be added to proposableAccounts`);
        }

        // Return a trigger output to ensure process() continues
        // This ensures the AUTO-PROPOSE logic runs to process the payment
        const firstValidator = entityState.config.validators[0];
        if (firstValidator) {
          outputs.push({
            entityId: entityState.entityId,
            signerId: firstValidator,
            entityTxs: [], // Empty transaction array - just triggers processing
          });
          if (verbose) console.log(`💸 Added processing trigger: outputs.length=${outputs.length}`);
        }
        if (verbose) {
          console.log(`💸 DIRECT-PAYMENT COMPLETE: mempoolOps=${mempoolOps.length}, outputs=${outputs.length}`);
          console.log(`💸 ═════════════════════════════════════════════════════════════`);
        }
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'r2c') {
      return await handleR2C(entityState, entityTx, env.timestamp);
    }

    if (entityTx.type === 'e2r') {
      return await handleE2R(entityState, entityTx);
    }

    if (entityTx.type === 'r2r') {
      return await handleR2R(entityState, entityTx);
    }

    if (entityTx.type === 'j_broadcast') {
      const batch = entityState.jBatchState?.batch;
      if (batch) {
        console.log(
          `🔍 APPLY j_broadcast: ${entityState.entityId.slice(-4)} batch r2r=${batch.reserveToReserve.length}, r2c=${batch.reserveToCollateral.length}, c2r=${batch.collateralToReserve.length}, settlements=${batch.settlements.length}, starts=${batch.disputeStarts.length}, finals=${batch.disputeFinalizations.length}`,
        );
      } else {
        console.log(`🔍 APPLY j_broadcast: ${entityState.entityId.slice(-4)} has no jBatchState`);
      }
      const result = await handleJBroadcast(entityState, entityTx, env);
      // j_broadcast returns jOutputs to queue to J-mempool
      return result;
    }

    if (entityTx.type === 'j_rebroadcast') {
      return await handleJRebroadcast(entityState, entityTx, env);
    }

    if (entityTx.type === 'j_abort_sent_batch') {
      return await handleJAbortSentBatch(entityState, entityTx, env);
    }

    if (entityTx.type === 'j_clear_batch') {
      return await handleJClearBatch(entityState, entityTx, env);
    }

    if (entityTx.type === 'mintReserves') {
      return await handleMintReserves(entityState, entityTx, env);
    }

    if (entityTx.type === 'createSettlement') {
      return await handleCreateSettlement(entityState, entityTx);
    }

    // === SETTLEMENT WORKSPACE HANDLERS ===
    if (entityTx.type === 'settle_propose') {
      return await handleSettlePropose(entityState, entityTx, env);
    }

    if (entityTx.type === 'settle_update') {
      return await handleSettleUpdate(entityState, entityTx, env);
    }

    if (entityTx.type === 'settle_approve') {
      const result = await handleSettleApprove(entityState, entityTx, env);
      return {
        ...result,
        ...(result.hashesToSign && result.hashesToSign.length > 0 && { hashesToSign: result.hashesToSign }),
      };
    }

    if (entityTx.type === 'settle_execute') {
      return await handleSettleExecute(entityState, entityTx, env);
    }

    if (entityTx.type === 'settle_reject') {
      return await handleSettleReject(entityState, entityTx, env);
    }

    if (entityTx.type === 'extendCredit') {
      console.log(
        `💳 EXTEND-CREDIT: ${entityState.entityId.slice(-4)} extending credit to ${entityTx.data.counterpartyEntityId.slice(-4)}`,
      );

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, tokenId, amount } = entityTx.data;

      // Get account machine (use canonical key)
      // Account keyed by counterparty ID
      const accountMachine = newState.accounts.get(counterpartyEntityId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for credit extension`);
        return { newState: entityState, outputs: [] };
      }

      // Create set_credit_limit account transaction
      // Side auto-detected by handler from frame proposer (no explicit side needed)
      const accountTx: AccountTx = {
        type: 'set_credit_limit',
        data: { tokenId, amount },
      };

      // Pure: return mempoolOp instead of mutating directly
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });
      console.log(
        `💳 Added set_credit_limit to mempoolOps for account with ${counterpartyEntityId.slice(-4)} amount=${amount}`,
      );

      addMessage(newState, `💳 Extended credit of ${amount} to ${counterpartyEntityId.slice(-4)}`);

      // Trigger processing (same pattern as directPayment)
      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({
          entityId: entityState.entityId,
          signerId: firstValidator,
          entityTxs: [], // Empty - triggers processing
        });
      }

      console.log(`💸 DIRECT-PAYMENT RETURN: outputs.length=${outputs.length}`);

      return { newState, outputs, mempoolOps };
    }

    // === HUB CONFIG (declare entity as hub, enable rebalance crontab) ===
    if (entityTx.type === 'setHubConfig') {
      const newState = cloneEntityState(entityState);
      const {
        matchingStrategy: matchingStrategyRaw = 'amount',
        policyVersion: policyVersionRaw,
        routingFeePPM = 1,
        baseFee = 0n,
        swapTakerFeeBps = 0,
        disputeAutoFinalizeMode = 'auto',
        minCollateralThreshold = 0n,
        c2rWithdrawSoftLimit = DEFAULT_SOFT_LIMIT,
        minFeeBps = 1n,
        rebalanceBaseFee = 10n ** 17n, // $0.10
        rebalanceLiquidityFeeBps = 1n, // 0.01%
        rebalanceGasFee = 0n,
        rebalanceTimeoutMs = 10 * 60 * 1000,
      } = entityTx.data;
      const matchingStrategy = normalizeRebalanceMatchingStrategy(matchingStrategyRaw);
      const previousConfig = entityState.hubRebalanceConfig;
      const previousVersion = previousConfig?.policyVersion ?? 0;
      const feePolicyChanged = !previousConfig ||
        (previousConfig.rebalanceBaseFee ?? 10n ** 17n) !== rebalanceBaseFee ||
        (previousConfig.rebalanceLiquidityFeeBps ?? previousConfig.minFeeBps ?? 1n) !== rebalanceLiquidityFeeBps ||
        (previousConfig.rebalanceGasFee ?? 0n) !== rebalanceGasFee;
      const requestedPolicyVersion = Number.isFinite(policyVersionRaw as number) && Number(policyVersionRaw) > 0
        ? Number(policyVersionRaw)
        : undefined;
      let policyVersion: number;
      if (requestedPolicyVersion !== undefined) {
        if (requestedPolicyVersion < previousVersion) {
          console.warn(
            `⚠️ setHubConfig policyVersion downgrade blocked: requested=${requestedPolicyVersion} < current=${previousVersion}`,
          );
          policyVersion = previousVersion;
        } else {
          policyVersion = requestedPolicyVersion;
        }
      } else if (previousVersion <= 0) {
        policyVersion = 1;
      } else {
        policyVersion = feePolicyChanged ? previousVersion + 1 : previousVersion;
      }
      const effectiveC2RWithdrawSoftLimit =
        c2rWithdrawSoftLimit < DEFAULT_SOFT_LIMIT ? DEFAULT_SOFT_LIMIT : c2rWithdrawSoftLimit;
      const normalizedSwapTakerFeeBps = Math.max(0, Math.min(10_000, Math.floor(Number(swapTakerFeeBps) || 0)));

      newState.hubRebalanceConfig = {
        matchingStrategy,
        policyVersion,
        routingFeePPM,
        baseFee,
        swapTakerFeeBps: normalizedSwapTakerFeeBps,
        disputeAutoFinalizeMode,
        minCollateralThreshold,
        c2rWithdrawSoftLimit: effectiveC2RWithdrawSoftLimit,
        minFeeBps,
        rebalanceBaseFee,
        rebalanceLiquidityFeeBps,
        rebalanceGasFee,
        rebalanceTimeoutMs,
      };
      newState.profile = {
        ...newState.profile,
        isHub: true,
      };
      console.log(
        `🏦 Hub config set: strategy=${matchingStrategy}, policyVersion=${policyVersion}, routingFee=${routingFeePPM}ppm, ` +
        `swapTakerFee=${normalizedSwapTakerFeeBps}bps, ` +
        `rebalance(base=${rebalanceBaseFee},liqBps=${rebalanceLiquidityFeeBps},gas=${rebalanceGasFee},timeoutMs=${rebalanceTimeoutMs},c2rWithdrawSoftLimit=${effectiveC2RWithdrawSoftLimit})` +
        `${feePolicyChanged ? ' [fee-policy-updated]' : ''}`,
      );

      // Announce updated profile with isHub: true
      if (env?.gossip) {
        const profile = announceLocalEntityProfile(env, newState, env.timestamp);
        console.log(`📡 Hub profile announced: ${newState.entityId.slice(-4)} isHub=${profile.metadata.isHub}`);
      }

      addMessage(
        newState,
        `🏦 Hub config activated: ${matchingStrategy} strategy v${policyVersion}, ${routingFeePPM}ppm routing fee, ` +
        `swapTakerFee=${normalizedSwapTakerFeeBps}bps, ` +
        `rebalance(base=${rebalanceBaseFee}, liqBps=${rebalanceLiquidityFeeBps}, gas=${rebalanceGasFee}, c2rWithdrawSoftLimit=${effectiveC2RWithdrawSoftLimit})`,
      );
      return { newState, outputs: [] };
    }

    if (entityTx.type === 'setRebalancePolicy') {
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, tokenId, r2cRequestSoftLimit, hardLimit, maxAcceptableFee } = entityTx.data;

      const accountMachine = newState.accounts.get(counterpartyEntityId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for rebalance policy`);
        return { newState: entityState, outputs: [] };
      }

      const accountTx: AccountTx = {
        type: 'set_rebalance_policy',
        data: { tokenId, r2cRequestSoftLimit, hardLimit, maxAcceptableFee },
      };
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'requestCollateral') {
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, tokenId, amount, feeTokenId, feeAmount, policyVersion } = entityTx.data;

      const accountMachine = newState.accounts.get(counterpartyEntityId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for collateral request`);
        return { newState: entityState, outputs: [] };
      }

      const accountTx: AccountTx = {
        type: 'request_collateral',
        data: {
          tokenId,
          amount,
          ...(feeTokenId !== undefined ? { feeTokenId } : {}),
          feeAmount,
          policyVersion,
        },
      };
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'reopenDisputedAccount') {
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId } = entityTx.data;

      const accountMachine = newState.accounts.get(counterpartyEntityId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for reopen`);
        return { newState: entityState, outputs: [] };
      }

      const onChainNonce = Number(entityTx.data.onChainNonce ?? accountMachine.onChainSettlementNonce ?? 0);

      const accountTx: AccountTx = {
        type: 'reopen_disputed',
        data: { onChainNonce },
      };
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }
      addMessage(newState, `🔓 Reopen requested with ${counterpartyEntityId.slice(-4)} at nonce=${onChainNonce}`);

      return { newState, outputs, mempoolOps };
    }

    // === SWAP ENTITY HANDLERS ===
    if (entityTx.type === 'pullLock') {
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, pullId, tokenId, amount, revealedUntilTimestamp, fullHash, partialRoot } = entityTx.data;
      const normalizedCounterparty = findAccountKey(newState, counterpartyEntityId);
      if (!normalizedCounterparty) {
        addMessage(newState, `❌ Pull lock failed: no account with ${formatEntityId(counterpartyEntityId)}`);
        return { newState, outputs, mempoolOps };
      }
      mempoolOps.push({
        accountId: normalizedCounterparty,
        tx: {
          type: 'pull_lock',
          data: {
            pullId,
            tokenId: Number(tokenId),
            amount: BigInt(amount),
            revealedUntilTimestamp: Number(revealedUntilTimestamp),
            fullHash,
            partialRoot,
          },
        },
      });
      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }
      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'resolvePull') {
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, pullId, binary } = entityTx.data;
      const normalizedCounterparty = findAccountKey(newState, counterpartyEntityId);
      if (!normalizedCounterparty) {
        addMessage(newState, `❌ Pull resolve failed: no account with ${formatEntityId(counterpartyEntityId)}`);
        return { newState, outputs, mempoolOps };
      }
      const crossSourceRoute = [...(newState.crossJurisdictionSwaps?.values?.() ?? [])].find(route =>
        route.sourcePull?.pullId === pullId &&
        normalizeEntityRef(route.source.counterpartyEntityId) === normalizeEntityRef(newState.entityId) &&
        normalizeEntityRef(route.source.entityId) === normalizeEntityRef(counterpartyEntityId),
      );
      if (crossSourceRoute && crossSourceRoute.status !== 'clearing') {
        addMessage(newState, `❌ Cross-j source pull ${pullId.slice(0, 8)} resolve blocked: use requestCrossJurisdictionClear`);
        return { newState, outputs, mempoolOps };
      }
      mempoolOps.push({
        accountId: normalizedCounterparty,
        tx: {
          type: 'pull_resolve',
          data: {
            pullId,
            binary,
          },
        },
      });
      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
	      }
	      return { newState, outputs, mempoolOps };
	    }

    if (entityTx.type === 'cancelPull' || entityTx.type === 'pullCancelExpired') {
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, pullId } = entityTx.data;
      const normalizedCounterparty = findAccountKey(newState, counterpartyEntityId);
      if (!normalizedCounterparty) {
        addMessage(newState, `❌ Pull cancel failed: no account with ${formatEntityId(counterpartyEntityId)}`);
        return { newState, outputs, mempoolOps };
      }
      mempoolOps.push({
        accountId: normalizedCounterparty,
        tx: {
          type: 'pull_cancel',
          data: {
            pullId,
            reason: entityTx.type === 'pullCancelExpired' ? 'expired' : 'beneficiary_release',
          },
        },
      });
      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }
      addMessage(newState, `🪝 Pull cancel queued: ${pullId.slice(0, 8)}`);
      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'requestCrossJurisdictionSwap') {
      let route: CrossJurisdictionSwapRoute;
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      try {
        route = withCanonicalCrossJurisdictionRouteHash(entityTx.data.route);
      } catch (error) {
        addMessage(newState, `❌ Cross-j request invalid route: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs };
      }
      const now = deterministicEntityTimestamp(newState, env);
      if (isCrossJurisdictionRouteExpired(route, now)) {
        addMessage(newState, `❌ Cross-j request ${route.orderId} expired`);
        return { newState, outputs };
      }
      if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.entityId)) {
        addMessage(newState, `❌ Cross-j request ${route.orderId} routed to wrong source entity`);
        return { newState, outputs };
      }
      if (!newState.accounts.has(normalizeEntityRef(route.source.counterpartyEntityId))) {
        addMessage(newState, `❌ Cross-j request ${route.orderId} blocked: no source account with ${formatEntityId(route.source.counterpartyEntityId)}`);
        return { newState, outputs };
      }
      newState.crossJurisdictionSwaps ||= new Map();
      const existing = newState.crossJurisdictionSwaps.get(route.orderId);
      if (existing) {
        addMessage(newState, `❌ Cross-j request ${route.orderId} already exists (${existing.status})`);
        return { newState, outputs };
      }
      const intentRoute = {
        ...route,
        status: 'intent' as const,
        updatedAt: newState.timestamp || env.timestamp,
      };
      newState.crossJurisdictionSwaps.set(intentRoute.orderId, intentRoute);
      outputs.push({
        entityId: intentRoute.source.counterpartyEntityId,
        entityTxs: [{
          type: 'prepareCrossJurisdictionSwap',
          data: { route: intentRoute },
        }],
      });
      addMessage(newState, `🌉 Cross-j swap ${intentRoute.orderId} requested`);
      return { newState, outputs };
    }

    if (entityTx.type === 'prepareCrossJurisdictionSwap') {
      let route: CrossJurisdictionSwapRoute;
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      try {
        route = withCanonicalCrossJurisdictionRouteHash(entityTx.data.route);
      } catch (error) {
        addMessage(newState, `❌ Cross-j prepare invalid route: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs };
      }
      if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.counterpartyEntityId)) {
        addMessage(newState, `❌ Cross-j prepare ${route.orderId} wrong source hub`);
        return { newState, outputs };
      }
      const preparedRoute = buildPreparedCrossJurisdictionRoute(route, {
        runtimeSeed: (env as { runtimeSeed?: string }).runtimeSeed,
        sourceDisputeDelayMs: requireRuntimeJurisdictionDisputeDelayMs(env, route.source.jurisdiction),
        now: newState.timestamp || env.timestamp,
      });
      rememberCrossJurisdictionPrivateSeed(
        env,
        preparedRoute,
        getCrossJurisdictionPrivateSeed(env, preparedRoute),
      );
      if (!preparedRoute.targetPull || !preparedRoute.sourcePull) {
        addMessage(newState, `❌ Cross-j prepare ${route.orderId} failed: pull commitments missing`);
        return { newState, outputs };
      }
      newState.crossJurisdictionSwaps ||= new Map();
      const existing = newState.crossJurisdictionSwaps.get(preparedRoute.orderId);
      const transitionError = validateCrossJurisdictionRouteTransition(existing, preparedRoute);
      if (transitionError) {
        addMessage(newState, `❌ Cross-j prepare ${route.orderId} blocked: ${transitionError}`);
        return { newState, outputs };
      }
      newState.crossJurisdictionSwaps.set(preparedRoute.orderId, mergeCrossJurisdictionRoute(existing, preparedRoute));
      const publicPreparedRoute = stripCrossJurisdictionPrivateData(preparedRoute);

      outputs.push({
        entityId: publicPreparedRoute.target.entityId,
        entityTxs: [
          { type: 'registerCrossJurisdictionSwap', data: { route: publicPreparedRoute } },
          {
            type: 'pullLock',
            data: {
              counterpartyEntityId: publicPreparedRoute.target.counterpartyEntityId,
              pullId: publicPreparedRoute.targetPull!.pullId,
              tokenId: publicPreparedRoute.targetPull!.tokenId,
              amount: publicPreparedRoute.targetPull!.signedAmount,
              revealedUntilTimestamp: publicPreparedRoute.targetPull!.revealedUntilTimestamp,
              fullHash: publicPreparedRoute.targetPull!.fullHash,
              partialRoot: publicPreparedRoute.targetPull!.partialRoot,
              description: publicPreparedRoute.memo || `Cross-j target pull ${publicPreparedRoute.orderId}`,
            },
          },
        ],
      });
      outputs.push({
        entityId: publicPreparedRoute.target.counterpartyEntityId,
        entityTxs: [{ type: 'registerCrossJurisdictionSwap', data: { route: publicPreparedRoute } }],
      });
      outputs.push({
        entityId: publicPreparedRoute.source.entityId,
        entityTxs: [{ type: 'commitCrossJurisdictionSwap', data: { route: publicPreparedRoute } }],
      });
      addMessage(newState, `🌉 Cross-j swap ${preparedRoute.orderId} prepared by hub`);
      return { newState, outputs };
    }

    if (entityTx.type === 'commitCrossJurisdictionSwap') {
      let route: CrossJurisdictionSwapRoute;
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      try {
        route = withCanonicalCrossJurisdictionRouteHash(entityTx.data.route);
      } catch (error) {
        addMessage(newState, `❌ Cross-j commit invalid route: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs };
      }
      const now = deterministicEntityTimestamp(newState, env);
      if (isCrossJurisdictionRouteExpired(route, now) || isCrossJurisdictionPullExpired(route, 'source', now)) {
        addMessage(newState, `❌ Cross-j commit ${route.orderId} expired`);
        return { newState, outputs };
      }
      if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.entityId)) {
        addMessage(newState, `❌ Cross-j commit ${route.orderId} routed to wrong source entity`);
        return { newState, outputs };
      }
      if (!route.sourcePull || !route.targetPull) {
        addMessage(newState, `❌ Cross-j commit ${route.orderId} missing pull commitments`);
        return { newState, outputs };
      }
      const sourcePull = route.sourcePull;
      const targetPull = route.targetPull;
      const restingRoute = {
        ...stripCrossJurisdictionPrivateData(route),
        sourcePull,
        targetPull,
        status: 'resting' as const,
        updatedAt: newState.timestamp || env.timestamp,
      };
      newState.crossJurisdictionSwaps ||= new Map();
      const existing = newState.crossJurisdictionSwaps.get(restingRoute.orderId);
      const transitionError = validateCrossJurisdictionRouteTransition(existing, restingRoute);
      if (transitionError) {
        addMessage(newState, `❌ Cross-j commit ${route.orderId} blocked: ${transitionError}`);
        return { newState, outputs };
      }
      newState.crossJurisdictionSwaps.set(restingRoute.orderId, mergeCrossJurisdictionRoute(existing, restingRoute));
      const firstValidator = entityState.config.validators[0];
      outputs.push({
        entityId: newState.entityId,
        ...(firstValidator ? { signerId: firstValidator } : {}),
        entityTxs: [
          {
            type: 'pullLock',
            data: {
              counterpartyEntityId: restingRoute.source.counterpartyEntityId,
              pullId: sourcePull.pullId,
              tokenId: sourcePull.tokenId,
              amount: sourcePull.signedAmount,
              revealedUntilTimestamp: sourcePull.revealedUntilTimestamp,
              fullHash: sourcePull.fullHash,
              partialRoot: sourcePull.partialRoot,
              description: restingRoute.memo || `Cross-j source pull ${restingRoute.orderId}`,
            },
          },
          {
            type: 'placeSwapOffer',
            data: {
              counterpartyEntityId: restingRoute.source.counterpartyEntityId,
              offerId: restingRoute.orderId,
              giveTokenId: restingRoute.source.tokenId,
              giveAmount: restingRoute.source.amount,
              wantTokenId: restingRoute.target.tokenId,
              wantAmount: restingRoute.target.amount,
              ...(restingRoute.priceTicks !== undefined ? { priceTicks: restingRoute.priceTicks } : {}),
              timeInForce: 0,
              minFillRatio: 0,
              crossJurisdiction: stripCrossJurisdictionPrivateData(restingRoute),
            },
          },
        ],
      });
      addMessage(newState, `🌉 Cross-j swap ${restingRoute.orderId} committed by source`);
      return { newState, outputs };
    }

    if (entityTx.type === 'registerCrossJurisdictionSwap') {
      let route: CrossJurisdictionSwapRoute;
      const newState = cloneEntityState(entityState);
      try {
        route = withCanonicalCrossJurisdictionRouteHash(entityTx.data.route);
      } catch (error) {
        addMessage(newState, `❌ Cross-j register invalid route: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs: [] };
      }
      if (!isCrossJurisdictionRouteParticipant(newState.entityId, route)) {
        addMessage(newState, `❌ Cross-j register ${route.orderId} routed to non-participant entity`);
        return { newState, outputs: [] };
      }
      newState.crossJurisdictionSwaps ||= new Map();
      const existing = newState.crossJurisdictionSwaps.get(route.orderId);
      const transitionError = validateCrossJurisdictionRouteTransition(existing, route);
      if (transitionError) {
        addMessage(newState, `❌ Cross-j swap ${route.orderId} register blocked: ${transitionError}`);
        return { newState, outputs: [] };
      }
      newState.crossJurisdictionSwaps.set(route.orderId, mergeCrossJurisdictionRoute(existing, route));
      addMessage(newState, `🌉 Cross-j swap ${route.orderId} registered`);
      return { newState, outputs: [] };
    }

    if (entityTx.type === 'crossJurisdictionFillNotice') {
      const {
        orderId,
        fillSeq,
        incrementalSourceAmount,
        incrementalTargetAmount,
        cumulativeSourceAmount,
        cumulativeTargetAmount,
        cumulativeFillRatio,
        priceTicks,
        pairId,
      } = entityTx.data;
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      let route = newState.crossJurisdictionSwaps?.get(orderId);
      if (!route) {
        const offerRoute = findCrossJurisdictionOfferRoute(newState, orderId);
        if (!offerRoute) {
          addMessage(newState, `❌ Cross-j fill notice ${orderId} missing route`);
          return { newState, outputs, mempoolOps };
        }
        route = offerRoute.route;
      }
      const offerRoute = findCrossJurisdictionOfferRoute(newState, orderId);
      if (offerRoute) {
        try {
          route = mergeCrossJurisdictionRoute(route, withCanonicalCrossJurisdictionRouteHash(offerRoute.route));
          newState.crossJurisdictionSwaps ||= new Map();
          newState.crossJurisdictionSwaps.set(orderId, route);
        } catch {
          // Keep the entity-level route; validation below will reject if it is unusable.
        }
      }
      const currentEntityId = normalizeEntityRef(newState.entityId);
      const routeBookOwner = normalizeEntityRef(route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId);
      const routeSourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
      if (routeBookOwner !== currentEntityId && routeSourceHub !== currentEntityId) {
        addMessage(newState, `❌ Cross-j fill notice ${orderId} routed to wrong book owner/source hub`);
        return { newState, outputs, mempoolOps };
      }
      const allowed = route.status === 'resting' || route.status === 'partially_filled';
      if (!allowed) {
        addMessage(newState, `❌ Cross-j fill notice ${orderId} blocked in status ${route.status}`);
        return { newState, outputs, mempoolOps };
      }
      const validatedFill = validateCrossJurisdictionFillProgress(route, {
        fillSeq,
        cumulativeFillRatio,
        incrementalSourceAmount,
        incrementalTargetAmount,
        cumulativeSourceAmount,
        cumulativeTargetAmount,
      });
      if (!validatedFill.ok) {
        addMessage(newState, `❌ Cross-j fill notice ${orderId} blocked: ${validatedFill.error}`);
        return { newState, outputs, mempoolOps };
      }
      const fill = validatedFill.value;
      const accountId = findAccountKey(newState, route.source.entityId);
      if (!accountId) {
        addMessage(newState, `❌ Cross-j fill notice ${orderId} blocked: no source account`);
        return { newState, outputs, mempoolOps };
      }
      mempoolOps.push({
        accountId,
        tx: {
          type: 'cross_swap_fill_ack',
          data: {
            offerId: orderId,
            fillSeq: fill.fillSeq,
            incrementalSourceAmount: fill.incrementalSourceAmount,
            incrementalTargetAmount: fill.incrementalTargetAmount,
            cumulativeSourceAmount: fill.cumulativeSourceAmount,
            cumulativeTargetAmount: fill.cumulativeTargetAmount,
            cumulativeFillRatio: fill.nextRatio,
            executionSourceAmount: fill.incrementalSourceAmount,
            executionTargetAmount: fill.incrementalTargetAmount,
            cancelRemainder: fill.nextRatio >= 65_535,
            ...(priceTicks !== undefined ? { priceTicks } : {}),
            pairId,
            comment: `cross-j-fill-notice:${fill.nextRatio}`,
          },
        },
      });
      const firstValidator = entityState.config.validators[0];
      if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
      addMessage(newState, `🌉 Cross-j fill notice ${orderId} queued account ack ${fill.nextRatio}/65535`);
      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'requestCrossJurisdictionClear') {
      const { orderId, cancelRemainder = false } = entityTx.data;
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      let route = newState.crossJurisdictionSwaps?.get(orderId);
      if (!route) {
        addMessage(newState, `❌ Cross-j clear ${orderId} missing route`);
        return { newState, outputs, mempoolOps };
      }
      const offerRoute = findCrossJurisdictionOfferRoute(newState, orderId);
      if (offerRoute) {
        try {
          route = mergeCrossJurisdictionRoute(route, withCanonicalCrossJurisdictionRouteHash(offerRoute.route));
          newState.crossJurisdictionSwaps ||= new Map();
          newState.crossJurisdictionSwaps.set(orderId, route);
        } catch {
          // Keep the entity-level route; validation below will reject if it is unusable.
        }
      }
      const sourceHubId = normalizeEntityRef(route.source.counterpartyEntityId);
      if (normalizeEntityRef(newState.entityId) !== sourceHubId) {
        outputs.push({
          entityId: route.source.counterpartyEntityId,
          entityTxs: [{
            type: 'requestCrossJurisdictionClear',
            data: { orderId, cancelRemainder },
          }],
        });
        route.status = 'clear_requested';
        route.pendingClearRequestedAt = deterministicEntityTimestamp(newState, env);
        route.clearingPolicy = cancelRemainder ? 'cancel_and_clear' : 'manual';
        route.updatedAt = newState.timestamp || env.timestamp;
        newState.crossJurisdictionSwaps?.set(orderId, route);
        addMessage(newState, `🌉 Cross-j clear ${orderId} requested from source hub`);
        return { newState, outputs, mempoolOps };
      }

      let canonicalRoute: CrossJurisdictionSwapRoute;
      try {
        canonicalRoute = withCanonicalCrossJurisdictionRouteHash(route);
      } catch (error) {
        addMessage(newState, `❌ Cross-j clear ${orderId} invalid route: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs, mempoolOps };
      }
      if (!canonicalRoute.sourcePull || !canonicalRoute.targetPull) {
        addMessage(newState, `❌ Cross-j clear ${orderId} blocked: pull commitments missing`);
        return { newState, outputs, mempoolOps };
      }
      const ratio = Math.max(
        0,
        Math.min(65_535, Math.floor(Number(canonicalRoute.cumulativeFillRatio ?? canonicalRoute.claimedRatio ?? 0) || 0)),
      );
      const accountId = findAccountKey(newState, canonicalRoute.source.entityId);
      const account = accountId ? newState.accounts.get(accountId) : undefined;
      const liveOffer = account?.swapOffers?.get(orderId);
      if (liveOffer?.crossJurisdiction && (cancelRemainder || ratio > 0)) {
        if (!accountId || !account) {
          addMessage(newState, `❌ Cross-j clear ${orderId} blocked: no source account with ${formatEntityId(canonicalRoute.source.entityId)}`);
          return { newState, outputs, mempoolOps };
        }
        if (accountHasCrossSwapAckQueued(account, orderId)) {
          addMessage(newState, `🌉 Cross-j clear ${orderId} waiting for account offer close ack`);
          return { newState, outputs, mempoolOps };
        }
        const removedFromBook = cancelOrderbookOfferIfPresent(env, newState, accountId, orderId);
        mempoolOps.push({
          accountId,
          tx: buildCrossJurisdictionCancelAck(orderId, canonicalRoute),
        });
        canonicalRoute.status = 'clear_requested';
        canonicalRoute.pendingClearRequestedAt = deterministicEntityTimestamp(newState, env);
        canonicalRoute.clearingPolicy = 'cancel_and_clear';
        canonicalRoute.updatedAt = newState.timestamp || env.timestamp;
        newState.crossJurisdictionSwaps?.set(orderId, canonicalRoute);
        const firstValidator = entityState.config.validators[0];
        if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
        addMessage(
          newState,
          removedFromBook
            ? `🌉 Cross-j clear ${orderId} removed live book order and queued account offer close before pull reveal`
            : `🌉 Cross-j clear ${orderId} queued account offer close before pull reveal`,
        );
        return { newState, outputs, mempoolOps };
      }
      if (ratio <= 0) {
        if (!cancelRemainder) {
          addMessage(newState, `🌉 Cross-j clear ${orderId} ignored: no pending fill`);
          return { newState, outputs, mempoolOps };
        }
        if (accountId && account?.pulls?.has(canonicalRoute.sourcePull.pullId)) {
          mempoolOps.push({
            accountId,
            tx: {
              type: 'pull_cancel',
              data: {
                pullId: canonicalRoute.sourcePull.pullId,
                reason: 'cross_j_cancel_no_fill',
              },
            },
          });
        }
        outputs.push({
          entityId: canonicalRoute.target.counterpartyEntityId,
          entityTxs: [{
            type: 'cancelPull',
            data: {
              counterpartyEntityId: canonicalRoute.target.entityId,
              pullId: canonicalRoute.targetPull.pullId,
              description: `Cross-j ${orderId} cancel target pull without fill`,
            },
          }],
        });
        canonicalRoute.status = 'cancelled';
        canonicalRoute.pendingClearRequestedAt = deterministicEntityTimestamp(newState, env);
        canonicalRoute.clearingPolicy = 'cancel_and_clear';
        canonicalRoute.updatedAt = newState.timestamp || env.timestamp;
        newState.crossJurisdictionSwaps?.set(orderId, canonicalRoute);
        const firstValidator = entityState.config.validators[0];
        if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
        addMessage(newState, `🌉 Cross-j clear ${orderId} cancelled without fill`);
        return { newState, outputs, mempoolOps };
      }
      if (!accountId || !account) {
        addMessage(newState, `❌ Cross-j clear ${orderId} blocked: no source account with ${formatEntityId(canonicalRoute.source.entityId)}`);
        return { newState, outputs, mempoolOps };
      }
      if (!account.pulls?.has(canonicalRoute.sourcePull.pullId)) {
        addMessage(newState, `🌉 Cross-j clear ${orderId} ignored: source pull already closed`);
        return { newState, outputs, mempoolOps };
      }
      if (accountHasPullResolveQueued(account, canonicalRoute.sourcePull.pullId)) {
        addMessage(newState, `🌉 Cross-j clear ${orderId} ignored: source pull resolve already queued`);
        return { newState, outputs, mempoolOps };
      }
      let reveal;
      try {
        reveal = buildCrossJurisdictionPullReveal(
          canonicalRoute,
          ratio,
          getCrossJurisdictionPrivateSeed(env, canonicalRoute),
        );
      } catch (error) {
        addMessage(newState, `❌ Cross-j clear ${orderId} reveal failed: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs, mempoolOps };
      }
      mempoolOps.push({
        accountId,
        tx: {
          type: 'pull_resolve',
          data: {
            pullId: canonicalRoute.sourcePull.pullId,
            binary: reveal.binary,
          },
        },
      });
      const closeRemainder = cancelRemainder || ratio < 65_535;
      canonicalRoute.status = 'clearing';
      canonicalRoute.pendingClearRequestedAt = deterministicEntityTimestamp(newState, env);
      canonicalRoute.clearingPolicy = closeRemainder ? 'cancel_and_clear' : ratio >= 65_535 ? 'full_fill' : 'manual';
      canonicalRoute.updatedAt = newState.timestamp || env.timestamp;
      newState.crossJurisdictionSwaps?.set(orderId, canonicalRoute);
      const firstValidator = entityState.config.validators[0];
      if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
      addMessage(newState, `🌉 Cross-j clear ${orderId} queued ratio=${ratio}/65535`);
      return { newState, outputs, mempoolOps };
    }

	    if (entityTx.type === 'crossJurisdictionSalvage') {
	      const { routeId, binary, fillRatio, sourceEntityId, sourceCounterpartyEntityId, observedAt } = entityTx.data;
	      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      if (!binary || binary === '0x' || fillRatio <= 0) {
        addMessage(newState, `🌉 Cross-j salvage ignored for ${routeId}: empty pull args`);
        return { newState, outputs };
      }
      try {
        const decoded = decodeHashLadderBinary(binary);
        if (decoded.fillRatio <= 0) {
          addMessage(newState, `🌉 Cross-j salvage ignored for ${routeId}: zero pull binary`);
          return { newState, outputs };
        }
      } catch (error) {
        addMessage(newState, `❌ Cross-j salvage ${routeId} invalid pull binary: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs };
      }
      const route = newState.crossJurisdictionSwaps?.get(routeId);
      if (!route) {
        addMessage(newState, `❌ Cross-j salvage ${routeId} missing local route`);
        return { newState, outputs };
      }
      if (!route.targetPull) {
        addMessage(newState, `❌ Cross-j salvage ${routeId} missing target pull commitment`);
        return { newState, outputs };
      }
      if (isCrossJurisdictionPullExpired(route, 'target', deterministicEntityTimestamp(newState, env))) {
        addMessage(newState, `❌ Cross-j salvage ${routeId} target pull expired`);
        return { newState, outputs };
      }
      const targetUserEntityId = normalizeEntityRef(route.target.counterpartyEntityId);
      const targetHubEntityId = normalizeEntityRef(route.target.entityId);
      if (normalizeEntityRef(newState.entityId) !== targetUserEntityId) {
        addMessage(newState, `❌ Cross-j salvage ${routeId} routed to wrong sibling entity`);
        return { newState, outputs };
      }
      if (!newState.accounts.has(targetHubEntityId)) {
        addMessage(newState, `❌ Cross-j salvage ${routeId} blocked: no target account with ${targetHubEntityId.slice(-4)}`);
        return { newState, outputs };
      }
      route.status = 'clearing';
      route.pendingClearRequestedAt = deterministicEntityTimestamp(newState, env);
      route.updatedAt = newState.timestamp || env.timestamp;
      newState.crossJurisdictionSwaps ||= new Map();
      newState.crossJurisdictionSwaps.set(route.orderId, route);
      const firstValidator = entityState.config.validators[0];
      outputs.push({
        entityId: newState.entityId,
        ...(firstValidator ? { signerId: firstValidator } : {}),
        entityTxs: [
          {
            type: 'resolvePull',
            data: {
              counterpartyEntityId: targetHubEntityId,
              pullId: route.targetPull.pullId,
              binary,
              description:
                `Cross-j salvage resolve ${routeId} fill=${fillRatio}/65535 ` +
                `source=${sourceEntityId.slice(-4)}:${sourceCounterpartyEntityId.slice(-4)}`,
            },
          },
          {
            type: 'disputeStart',
            data: {
              counterpartyEntityId: targetHubEntityId,
              description:
                `Cross-j salvage ${routeId} fill=${fillRatio}/65535 ` +
                `source=${sourceEntityId.slice(-4)}:${sourceCounterpartyEntityId.slice(-4)}` +
                (observedAt ? ` observed=${observedAt}` : ''),
            },
          },
          { type: 'j_broadcast', data: {} },
        ],
      });
      addMessage(newState, `🌉 Cross-j salvage queued for ${routeId}: target dispute vs ${targetHubEntityId.slice(-4)}`);
	      return { newState, outputs };
	    }

	    if (entityTx.type === 'orderbookSweepCrossJurisdiction') {
	      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const now = deterministicEntityTimestamp(newState, env);
      let expiredRoutes = 0;
      let closedOffers = 0;
      let waitingRoutes = 0;

      for (const [orderId, storedRoute] of [...(newState.crossJurisdictionSwaps?.entries?.() ?? [])]) {
        let route = storedRoute;
        const offerRoute = findCrossJurisdictionOfferRoute(newState, orderId);
        if (offerRoute) {
          try {
            route = mergeCrossJurisdictionRoute(route, withCanonicalCrossJurisdictionRouteHash(offerRoute.route));
            newState.crossJurisdictionSwaps?.set(orderId, route);
          } catch {
            // The expiry cleanup below will still fail closed on the entity-level route.
          }
        }
        if (isCrossJurisdictionTerminalStatus(route.status)) continue;
        const routeExpired = isCrossJurisdictionRouteExpired(route, now);
        const sourceExpired = isCrossJurisdictionPullExpired(route, 'source', now);
        const targetExpired = isCrossJurisdictionPullExpired(route, 'target', now);
        if (!routeExpired && !sourceExpired && !targetExpired) {
          waitingRoutes++;
          continue;
        }

        expiredRoutes++;
        const sourceEntityId = (route.source as { entityId?: string } | undefined)?.entityId;
        if (!sourceEntityId) {
          route.status = 'failed';
          route.updatedAt = now;
          newState.crossJurisdictionSwaps?.set(orderId, route);
          addMessage(newState, `🌉 Cross-j sweep ${orderId}: failed malformed route without source entity`);
          continue;
        }

        const accountId = findAccountKey(newState, sourceEntityId);
        const account = accountId ? newState.accounts.get(accountId) : undefined;
        const hasFilledAmount =
          Number(route.cumulativeFillRatio || route.claimedRatio || 0) > 0 ||
          (route.filledSourceAmount ?? route.sourceClaimed ?? 0n) > 0n ||
          (route.filledTargetAmount ?? route.targetClaimed ?? 0n) > 0n;

        if (accountId && account?.swapOffers?.has(orderId)) {
          cancelOrderbookOfferIfPresent(env, newState, accountId, orderId);
          if (!accountHasCrossSwapAckQueued(account, orderId)) {
            mempoolOps.push({
              accountId,
              tx: buildCrossJurisdictionCancelAck(orderId, route),
            });
            closedOffers++;
          }
        } else if (!accountId) {
          addMessage(newState, `🌉 Cross-j sweep ${orderId}: no source account for ${formatEntityId(sourceEntityId)}`);
        } else {
          addMessage(newState, `🌉 Cross-j sweep ${orderId}: no live source offer in ${formatEntityId(accountId)}`);
        }

        if (!hasFilledAmount) {
          if (accountId && account?.pulls?.has(route.sourcePull?.pullId || '')) {
            const sourcePullId = route.sourcePull!.pullId;
            mempoolOps.push({
              accountId,
              tx: {
                type: 'pull_cancel',
                data: {
                  pullId: sourcePullId,
                  reason: 'expired',
                },
              },
            });
          }
          if (route.targetPull && route.target?.counterpartyEntityId && route.target?.entityId) {
            outputs.push({
              entityId: route.target.counterpartyEntityId,
              entityTxs: [{
                type: 'cancelPull',
                data: {
                  counterpartyEntityId: route.target.entityId,
                  pullId: route.targetPull.pullId,
                  description: `Cross-j ${orderId} sweep cancel target pull`,
                },
              }],
            });
          }
          route.status = 'expired';
        } else {
          route.status = 'failed';
        }
        route.updatedAt = now;
        route.clearingPolicy = hasFilledAmount ? 'manual' : 'cancel_and_clear';
        newState.crossJurisdictionSwaps?.set(orderId, route);
      }

      if (expiredRoutes > 0) {
        const firstValidator = entityState.config.validators[0];
        if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
      }
	      addMessage(
        newState,
        `🌉 Cross-j orderbook sweep${entityTx.data?.reason ? `: ${entityTx.data.reason}` : ''} ` +
        `expired=${expiredRoutes} closedOffers=${closedOffers} waiting=${waitingRoutes}`,
      );
	      return { newState, outputs, mempoolOps };
	    }

	    if (entityTx.type === 'placeSwapOffer') {
	      console.log(
        `📊 PLACE-SWAP-OFFER: ${entityState.entityId.slice(-4)} placing offer with ${entityTx.data.counterpartyEntityId.slice(-4)}`,
      );

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, offerId, giveTokenId, giveAmount, wantTokenId, wantAmount, priceTicks, timeInForce, minFillRatio, crossJurisdiction } =
        entityTx.data;

      // Use canonical key for account lookup
      // Account keyed by counterparty ID
      const accountMachine = newState.accounts.get(counterpartyEntityId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for swap offer`);
        return { newState: entityState, outputs: [] };
      }
      const publicCrossJurisdiction = crossJurisdiction
        ? stripCrossJurisdictionPrivateData(withCanonicalCrossJurisdictionRouteHash(crossJurisdiction))
        : undefined;
      if (publicCrossJurisdiction) {
        const route = publicCrossJurisdiction;
        const existing = newState.crossJurisdictionSwaps?.get(route.orderId);
        const transitionError = validateCrossJurisdictionRouteTransition(existing, route);
        if (transitionError || isCrossJurisdictionRouteExpired(route, deterministicEntityTimestamp(newState, env))) {
          addMessage(newState, `❌ Cross-j offer ${route.orderId} blocked: ${transitionError || 'expired'}`);
          return { newState, outputs: [] };
        }
        newState.crossJurisdictionSwaps ||= new Map();
        newState.crossJurisdictionSwaps.set(route.orderId, mergeCrossJurisdictionRoute(existing, route));
      }

      const accountTx: AccountTx = {
        type: 'swap_offer',
        data: {
          offerId,
          giveTokenId,
          giveAmount,
          wantTokenId,
          wantAmount,
          ...(priceTicks !== undefined ? { priceTicks } : {}),
          ...(timeInForce !== undefined ? { timeInForce } : {}),
          minFillRatio,
          ...(publicCrossJurisdiction ? { crossJurisdiction: publicCrossJurisdiction } : {}),
        },
      };

      // Pure: return mempoolOp instead of mutating directly
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });
      console.log(`📊 Added swap_offer to mempoolOps for account with ${counterpartyEntityId.slice(-4)}`);

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'resolveSwap') {
      console.log(
        `💱 RESOLVE-SWAP: ${entityState.entityId.slice(-4)} resolving offer with ${entityTx.data.counterpartyEntityId.slice(-4)}`,
      );

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const {
        counterpartyEntityId,
        offerId,
        fillRatio,
        cancelRemainder,
        comment,
        feeTokenId,
        feeAmount,
        executionGiveAmount,
        executionWantAmount,
      } = entityTx.data;

      // Use canonical key for account lookup
      // Account keyed by counterparty ID
      const accountMachine = newState.accounts.get(counterpartyEntityId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for swap resolve`);
        return { newState: entityState, outputs: [] };
      }
      if (accountMachine.swapOffers.get(offerId)?.crossJurisdiction) {
        addMessage(newState, `❌ Cross-j offer ${offerId} cannot be resolved through plain swap_resolve`);
        return { newState, outputs, mempoolOps };
      }

      const accountTx: AccountTx = {
        type: 'swap_resolve',
        data: {
          offerId,
          fillRatio,
          cancelRemainder,
          ...(comment !== undefined ? { comment } : {}),
          ...(feeTokenId !== undefined ? { feeTokenId } : {}),
          ...(feeAmount !== undefined ? { feeAmount } : {}),
          ...(executionGiveAmount !== undefined ? { executionGiveAmount } : {}),
          ...(executionWantAmount !== undefined ? { executionWantAmount } : {}),
        },
      };

      // Pure: return mempoolOp instead of mutating directly (keyed by counterparty)
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });
      console.log(`💱 Added swap_resolve to mempoolOps for account with ${counterpartyEntityId.slice(-4)}`);

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'cancelSwapOffer' || entityTx.type === 'cancelSwap' || entityTx.type === 'proposeCancelSwap') {
      console.log(
        `📊 CANCEL-SWAP-REQUEST: ${entityState.entityId.slice(-4)} requesting cancel with ${entityTx.data.counterpartyEntityId.slice(-4)}`,
      );

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, offerId } = entityTx.data;

      // Use canonical key for account lookup
      // Account keyed by counterparty ID
      const accountMachine = newState.accounts.get(counterpartyEntityId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for swap cancel`);
        return { newState: entityState, outputs: [] };
      }

      const accountTx: AccountTx = {
        type: 'swap_cancel_request',
        data: { offerId },
      };

      // Pure: return mempoolOp instead of mutating directly
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });
      console.log(`📊 Added swap_cancel_request to mempoolOps for account with ${counterpartyEntityId.slice(-4)}`);

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'r2e') {
      return handleR2E(entityState, entityTx);
    }

    if (entityTx.type === 'settleDiffs') {
      console.log(`🏦 SETTLE-DIFFS: Processing settlement with ${entityTx.data.counterpartyEntityId}`);

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const { counterpartyEntityId, diffs, description, sig } = entityTx.data;

      // Step 1: Validate invariant for all diffs
      for (const diff of diffs) {
        const sum = diff.leftDiff + diff.rightDiff + diff.collateralDiff;
        if (sum !== 0n) {
          logError('ENTITY_TX', `❌ INVARIANT-VIOLATION: leftDiff + rightDiff + collateralDiff = ${sum} (must be 0)`);
          throw new Error(`Settlement invariant violation: ${sum} !== 0`);
        }
      }

      // Step 2: Validate account exists (keyed by counterparty ID)
      if (!newState.accounts.has(counterpartyEntityId)) {
        logError('ENTITY_TX', `❌ No account exists with ${formatEntityId(counterpartyEntityId)}`);
        throw new Error(`No account with ${counterpartyEntityId}`);
      }

      // Step 3: Determine canonical left/right order
      const isLeft = isLeftEntity(entityState.entityId, counterpartyEntityId);
      const leftEntity = isLeft ? entityState.entityId : counterpartyEntityId;
      const rightEntity = isLeft ? counterpartyEntityId : entityState.entityId;

      console.log(`🏦 Canonical order: left=${leftEntity.slice(0, 10)}..., right=${rightEntity.slice(0, 10)}...`);
      console.log(`🏦 We are: ${isLeft ? 'LEFT' : 'RIGHT'}`);

      // Step 4: Get jurisdiction config
      const jurisdiction = entityState.config.jurisdiction;
      if (!jurisdiction) {
        throw new Error('No jurisdiction configured for this entity');
      }

      // Step 5: Convert diffs to contract format (keep as bigint - ethers handles conversion)
      const contractDiffs = diffs.map(d => ({
        tokenId: d.tokenId,
        leftDiff: d.leftDiff,
        rightDiff: d.rightDiff,
        collateralDiff: d.collateralDiff,
        ondeltaDiff: d.ondeltaDiff || 0n,
      }));

      console.log(`🏦 Queueing settlement diff batch:`, safeStringify(contractDiffs, 2));

      // Step 6: Add settlement to jBatch and trigger j_broadcast.
      if (!sig || sig === '0x') {
        throw new Error(
          `Settlement ${entityState.entityId.slice(-4)}↔${counterpartyEntityId.slice(-4)} missing hanko signature`,
        );
      }

      if (!newState.jBatchState) {
        newState.jBatchState = initJBatch();
      }
      const entityProviderAddress = requireUsableContractAddress(
        'entity_provider',
        jurisdiction.entityProviderAddress,
      );
      batchAddSettlement(
        newState.jBatchState,
        leftEntity,
        rightEntity,
        contractDiffs,
        [],
        sig,
        entityProviderAddress,
        '0x',
        0,
        entityState.entityId,
      );

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({
          entityId: entityState.entityId,
          signerId: firstValidator,
          entityTxs: [{
            type: 'j_broadcast',
            data: {},
          }],
        });
      }

      addMessage(
        newState,
        `🏦 ${description || 'Settlement'} queued to jBatch`,
      );

      return { newState, outputs };
    }

    // === DISPUTES ===
    if (entityTx.type === 'disputeStart') {
      return await handleDisputeStart(entityState, entityTx, env);
    }

    if (entityTx.type === 'disputeFinalize') {
      return await handleDisputeFinalize(entityState, entityTx, env);
    }

    console.warn(`⚠️ Unhandled EntityTx type: ${entityTx.type}`);
    return { newState: entityState, outputs: [], jOutputs: [] };
  } catch (error) {
    console.error(`❌ Transaction execution error:`, error);
    log.error(`❌ Transaction execution error: ${error}`);
    return { newState: entityState, outputs: [], jOutputs: [] }; // Return unchanged state on error
  }
};
