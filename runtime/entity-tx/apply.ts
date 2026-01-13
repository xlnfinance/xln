import { calculateQuorumPower } from '../entity-consensus';
import { formatEntityId } from '../utils';
import { processProfileUpdate } from '../name-resolution';
import { createOrderbookExtState } from '../orderbook';
import { db } from '../runtime';
import { EntityState, EntityTx, Env, Proposal, Delta, AccountTx, EntityInput, JInput } from '../types';
import { DEBUG, HEAVY_LOGS, log } from '../utils';
import { safeStringify } from '../serialization-utils';
import { buildEntityProfile } from '../gossip-helper';
// import { addToReserves, subtractFromReserves } from './financial'; // Currently unused
import { handleAccountInput, type MempoolOp, type SwapOfferEvent, type SwapCancelEvent } from './handlers/account';
import { handleJEvent } from './j-events';

// Extended return type including pure events from handlers
export interface ApplyEntityTxResult {
  newState: EntityState;
  outputs: EntityInput[];
  jOutputs?: JInput[];
  // Pure events for entity-level orchestration
  mempoolOps?: MempoolOp[];
  swapOffersCreated?: SwapOfferEvent[];
  swapOffersCancelled?: SwapCancelEvent[];
}
import { executeProposal, generateProposalId } from './proposals';
import { validateMessage } from './validation';
import { cloneEntityState, addMessage, canonicalAccountKey } from '../state-helpers';
import { submitSettle } from '../evm';
import { logError } from '../logger';

export const applyEntityTx = async (env: Env, entityState: EntityState, entityTx: EntityTx): Promise<ApplyEntityTxResult> => {
  if (!entityTx) {
    logError("ENTITY_TX", `❌ EntityTx is undefined!`);
    return { newState: entityState, outputs: [] };
  }

  try {
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
      console.log(`🏷️ Profile update transaction processing - data:`, entityTx.data);

      // Extract profile update data
      const profileData = entityTx.data.profile;
      console.log(`🏷️ Extracted profileData:`, profileData);

      if (profileData && profileData.entityId) {
        console.log(`🏷️ Calling processProfileUpdate for entity ${profileData.entityId}`);
        // Process profile update synchronously to ensure gossip is updated before snapshot
        try {
          await processProfileUpdate(db, profileData.entityId, profileData, profileData.hankoSignature || '', env);
        } catch (error) {
          logError("ENTITY_TX", `❌ Failed to process profile update for ${profileData.entityId}:`, error);
        }
      } else {
        console.warn(`⚠️ Invalid profile-update transaction data:`, entityTx.data);
        console.warn(`⚠️ ProfileData missing or invalid:`, profileData);
      }

      return { newState: entityState, outputs: [] };
    }

    if (entityTx.type === 'initOrderbookExt') {
      if (entityState.orderbookExt) {
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
      // Emit J-event received
      env.emit('JEventReceived', {
        entityId: entityState.entityId,
        eventType: entityTx.data.event.type,
        blockNumber: entityTx.data.blockNumber,
        txHash: entityTx.data.transactionHash,
      });

      const { newState, mempoolOps } = handleJEvent(entityState, entityTx.data, env);
      return { newState, outputs: [], mempoolOps: mempoolOps || [] };
    }

    if (entityTx.type === 'accountInput') {
      const result = await handleAccountInput(entityState, entityTx.data, env);
      return {
        newState: result.newState,
        outputs: result.outputs,
        mempoolOps: result.mempoolOps,
        swapOffersCreated: result.swapOffersCreated,
        swapOffersCancelled: result.swapOffersCancelled,
      };
    }

    if (entityTx.type === 'openAccount') {
      const targetEntityId = entityTx.data.targetEntityId;
      // Account keyed by counterparty ID (simpler than canonical)
      const counterpartyId = targetEntityId;
      const isLeft = entityState.entityId < targetEntityId;

      if (entityState.accounts.has(counterpartyId)) {
        console.log(`💳 OPEN-ACCOUNT: Account with ${formatEntityId(counterpartyId)} already exists, skipping duplicate request`);
        return { newState: entityState, outputs: [] };
      }

      console.log(`💳 OPEN-ACCOUNT: Opening account with ${counterpartyId} (counterparty: ${counterpartyId.slice(-4)})`);

      // Emit account opening event
      env.emit('AccountOpening', {
        entityId: entityState.entityId,
        counterpartyId: targetEntityId,
      });

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];

      // Add chat message about account opening
      addMessage(newState, `💳 Opening account with Entity ${formatEntityId(entityTx.data.targetEntityId)}...`);

      // STEP 1: Create local account machine
      if (!newState.accounts.has(counterpartyId)) {
        console.log(`💳 LOCAL-ACCOUNT: Creating local account with Entity ${formatEntityId(counterpartyId)}...`);

        // CONSENSUS FIX: Start with empty deltas - let all delta creation happen through transactions
        // This ensures both sides have identical delta Maps (matches Channel.ts pattern)
        const initialDeltas = new Map<number, Delta>();

        // CANONICAL: Store leftEntity/rightEntity (sorted) for AccountMachine internals
        const leftEntity = isLeft ? entityState.entityId : counterpartyId;
        const rightEntity = isLeft ? counterpartyId : entityState.entityId;

        newState.accounts.set(counterpartyId, {
          leftEntity,
          rightEntity,
          mempool: [],
          currentFrame: {
            height: 0,
            timestamp: env.timestamp,
            jHeight: 0,
            accountTxs: [],
            prevFrameHash: '',
            tokenIds: [],
            deltas: [],
            stateHash: '',
            byLeft: isLeft,
          },
          sentTransitions: 0,
          ackedTransitions: 0,
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
          sendCounter: 0,    // Like Channel.ts line 131
          receiveCounter: 0, // Like Channel.ts line 132
          // Removed isProposer - use isLeft() function like old_src Channel.ts
          proofHeader: {
            fromEntity: entityState.entityId,  // Perspective-dependent for signing
            toEntity: counterpartyId,
            cooperativeNonce: 0,
            disputeNonce: 0,
          },
          proofBody: { tokenIds: [], deltas: [] },
          // Dispute configuration (default: 20 blocks = 2 * 10)
          disputeConfig: {
            leftDisputeDelay: 2,  // 20 blocks for left entity
            rightDisputeDelay: 2, // 20 blocks for right entity
          },
          frameHistory: [],
          pendingWithdrawals: new Map(),
          requestedRebalance: new Map(),
          locks: new Map(), // HTLC: Initialize empty locks
          swapOffers: new Map(), // Swap: Initialize empty offers
          // Bilateral J-event consensus
          leftJObservations: [],
          rightJObservations: [],
          jEventChain: [],
          lastFinalizedJHeight: 0,
        });
      }

      // STEP 2: Add setup txs ONLY on LEFT side (Channel.ts pattern)
      // Right side waits for left's frame; otherwise it will re-propose add_delta and stall.
      console.log(`💳 Preparing account setup for ${formatEntityId(entityTx.data.targetEntityId)} (left=${isLeft})`);

      const localAccount = newState.accounts.get(counterpartyId);
      if (!localAccount) {
        throw new Error(`CRITICAL: Account machine not found after creation`);
      }

      if (isLeft) {
        // Token 1 = USDC
        const usdcTokenId = 1;
        // Add transactions to mempool - will be batched into frame #1 on next tick
        // NOTE: Only add_delta is queued. Credit limits are 0 by default - must be explicitly set
        localAccount.mempool.push({
          type: 'add_delta',
          data: { tokenId: usdcTokenId }
        });

        console.log(`📝 Queued add_delta to mempool (total: ${localAccount.mempool.length})`);
        console.log(`⏰ Frame #1 will be auto-proposed on next tick (100ms) via AUTO-PROPOSE`);
        console.log(`   Transactions: [add_delta] - credit limits start at 0, must be explicitly set`);
      } else {
        console.log(`🧭 Right side: waiting for left's frame (mempool stays empty)`);
      }

      // Add success message to chat
      addMessage(newState, `✅ Account opening request sent to Entity ${formatEntityId(counterpartyId)}`);

      // CRITICAL: Notify counterparty to create mirror account
      // Without this, Hub won't know about Alice-Hub account when j-events arrive!
      // Look up actual signer from env.eReplicas (key format: entityId:signerId)
      let counterpartySigner = 's1'; // Fallback
      for (const [replicaKey] of env.eReplicas.entries()) {
        if (replicaKey.startsWith(targetEntityId + ':')) {
          counterpartySigner = replicaKey.split(':')[1] || 's1';
          break;
        }
      }
      outputs.push({
        entityId: targetEntityId,
        signerId: counterpartySigner,
        entityTxs: [{
          type: 'openAccount',
          data: { targetEntityId: entityState.entityId }
        }]
      });
      console.log(`📤 Sent openAccount request to counterparty ${formatEntityId(targetEntityId)} (signer: ${counterpartySigner})`);

      // Broadcast updated profile to gossip layer
      if (env.gossip) {
        const profile = buildEntityProfile(newState, undefined, env.timestamp);
        if (env.runtimeId) {
          profile.runtimeId = env.runtimeId;
        }
        env.gossip.announce(profile);
        console.log(`📡 Broadcast profile for ${entityState.entityId} with ${newState.accounts.size} accounts`);
      }

      return { newState, outputs };
    }

    if (entityTx.type === 'htlcPayment') {
      const { handleHtlcPayment } = await import('./handlers/htlc-payment');
      return await handleHtlcPayment(entityState, entityTx, env);
    }

    if (entityTx.type === 'processHtlcTimeouts') {
      console.log(`⏰ PROCESS-HTLC-TIMEOUTS: Processing ${entityTx.data.expiredLocks?.length || 0} expired locks`);

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];

      // Convert expired locks to htlc_timeout mempoolOps
      for (const { accountId, lockId } of entityTx.data.expiredLocks || []) {
        mempoolOps.push({
          accountId,
          tx: {
            type: 'htlc_timeout',
            data: { lockId }
          }
        });
        console.log(`⏰   Queued timeout for lock ${lockId.slice(0,16)}... on account ${accountId.slice(-4)}`);
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'manualHtlcLock') {
      console.log(`🔒 MANUAL-HTLC-LOCK: Creating lock without envelope (timeout test)`);

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];

      const { counterpartyId, lockId, hashlock, timelock, revealBeforeHeight, amount, tokenId } = entityTx.data;

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
            tokenId
            // NO envelope - for timeout testing
          }
        }
      });

      console.log(`🔒   Queued htlc_lock for ${counterpartyId.slice(-4)}, lockId=${lockId.slice(0,16)}...`);

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'directPayment') {
      console.log(`💸 ═════════════════════════════════════════════════════════════`);
      console.log(`💸 DIRECT-PAYMENT HANDLER: ${entityState.entityId.slice(-4)} → ${entityTx.data.targetEntityId.slice(-4)}`);
      console.log(`💸 Amount: ${entityTx.data.amount}, TokenId: ${entityTx.data.tokenId}`);
      console.log(`💸 Route: ${entityTx.data.route?.map(r => r.slice(-4)).join('→') || 'NONE (will calculate)'}`);
      console.log(`💸 Description: ${entityTx.data.description || 'none'}`);

      // Emit payment initiation event
      env.emit('PaymentInitiated', {
        fromEntity: entityState.entityId,
        toEntity: entityTx.data.targetEntityId,
        tokenId: entityTx.data.tokenId,
        amount: entityTx.data.amount.toString(),
        route: entityTx.data.route,
      });

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      console.log(`💸 Initialized: outputs=[], mempoolOps=[]`);

      // Extract payment details
      let { targetEntityId, tokenId, amount, route, description } = entityTx.data;

      // If no route provided, check for direct account or calculate route
      if (!route || route.length === 0) {
        // Check if we have a direct account with target
        // Account keyed by counterparty ID
        if (newState.accounts.has(targetEntityId)) {
          console.log(`💸 Direct account exists with ${formatEntityId(targetEntityId)}`);
          route = [entityState.entityId, targetEntityId];
        } else {
          // Find route through network using gossip
          console.log(`💸 No direct account, finding route to ${formatEntityId(targetEntityId)}`);

          // Try to find a route through the network
          if (env.gossip) {
            const networkGraph = env.gossip.getNetworkGraph();
            const paths = networkGraph.findPaths(entityState.entityId, targetEntityId);

            if (paths.length > 0) {
              // Use the shortest path
              route = paths[0].path;
              console.log(`💸 Found route: ${route.map(e => formatEntityId(e)).join(' → ')}`);
            } else {
              logError("ENTITY_TX", `❌ No route found to ${formatEntityId(targetEntityId)}`);
              addMessage(newState, `❌ Payment failed: No route to ${formatEntityId(targetEntityId)}`);
              return { newState, outputs: [] };
            }
          } else {
            logError("ENTITY_TX", `❌ Cannot find route: Gossip layer not available`);
            addMessage(newState, `❌ Payment failed: Network routing unavailable`);
            return { newState, outputs: [] };
          }
        }
      }

      // Validate route starts with current entity
      if (route.length < 1 || route[0] !== entityState.entityId) {
        console.error(`❌ ROUTE VALIDATION FAILED: route.length=${route.length}, route[0]=${route[0]?.slice(-4)}, entityId=${entityState.entityId.slice(-4)}`);
        logError("ENTITY_TX", `❌ Invalid route: doesn't start with current entity`);
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
        logError("ENTITY_TX", `❌ Invalid route: no next hop specified in route`);
        return { newState, outputs: [] };
      }

      // Check if we have an account with next hop
      // Account keyed by counterparty ID
      const accountMachine = newState.accounts.get(nextHop);
      if (!accountMachine) {
        logError("ENTITY_TX", `❌ No account with next hop: ${nextHop}`);
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
          toEntityId: nextHop,                 // ✅ EXPLICIT direction
        },
      };

      // Add to account machine mempool via pure mempoolOps
      if (accountMachine) {
        // Pure: return mempoolOp instead of mutating directly
        mempoolOps.push({ accountId: nextHop, tx: accountTx });
        console.log(`💸 QUEUED TO MEMPOOL: account=${formatEntityId(nextHop)}`);
        console.log(`💸   AccountTx type: ${accountTx.type}`);
        console.log(`💸   Amount: ${accountTx.data.amount}`);
        console.log(`💸   From: ${accountTx.data.fromEntityId.slice(-4)}`);
        console.log(`💸   To: ${accountTx.data.toEntityId.slice(-4)}`);
        console.log(`💸   Route after slice: [${accountTx.data.route.map(r => r.slice(-4)).join(',')}]`);
        console.log(`💸 mempoolOps.length: ${mempoolOps.length}`);

        const isLeft = accountMachine.proofHeader.fromEntity < accountMachine.proofHeader.toEntity;
        console.log(`💸 Account state: isLeft=${isLeft}, hasPendingFrame=${!!accountMachine.pendingFrame}`);

        // Message about payment initiation
        addMessage(newState,
          `💸 Sending ${amount} (token ${tokenId}) to ${formatEntityId(targetEntityId)} via ${route.length - 1} hops`
        );

        // The payment is now queued for entity-level orchestration
        // Entity-consensus will apply mempoolOps and add to proposableAccounts
        console.log(`💸 Payment queued for bilateral consensus with ${formatEntityId(nextHop)}`);
        console.log(`💸 Account ${formatEntityId(nextHop)} will be added to proposableAccounts`);

        // Return a trigger output to ensure process() continues
        // This ensures the AUTO-PROPOSE logic runs to process the payment
        const firstValidator = entityState.config.validators[0];
        if (firstValidator) {
          outputs.push({
            entityId: entityState.entityId,
            signerId: firstValidator,
            entityTxs: [] // Empty transaction array - just triggers processing
          });
          console.log(`💸 Added processing trigger: outputs.length=${outputs.length}`);
        }
        console.log(`💸 DIRECT-PAYMENT COMPLETE: mempoolOps=${mempoolOps.length}, outputs=${outputs.length}`);
        console.log(`💸 ═════════════════════════════════════════════════════════════`);
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'deposit_collateral') {
      const { handleDepositCollateral } = await import('./handlers/deposit-collateral');
      return await handleDepositCollateral(entityState, entityTx);
    }

    if (entityTx.type === 'reserve_to_reserve') {
      const { handleReserveToReserve } = await import('./handlers/reserve-to-reserve');
      return await handleReserveToReserve(entityState, entityTx);
    }

    if (entityTx.type === 'j_broadcast') {
      const { handleJBroadcast } = await import('./handlers/j-broadcast');
      const result = await handleJBroadcast(entityState, entityTx, env);
      // j_broadcast returns jOutputs to queue to J-mempool
      return result;
    }

    if (entityTx.type === 'mintReserves') {
      const { handleMintReserves } = await import('./handlers/mint-reserves');
      return await handleMintReserves(entityState, entityTx);
    }

    if (entityTx.type === 'createSettlement') {
      const { handleCreateSettlement } = await import('./handlers/create-settlement');
      return await handleCreateSettlement(entityState, entityTx);
    }

    if (entityTx.type === 'extendCredit') {
      console.log(`💳 EXTEND-CREDIT: ${entityState.entityId.slice(-4)} extending credit to ${entityTx.data.counterpartyEntityId.slice(-4)}`);

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

      // Determine canonical side - credit limit I'm setting for my COUNTERPARTY to use
      // If I'm LEFT and extend credit → set rightCreditLimit (credit available TO right/counterparty)
      // If I'm RIGHT and extend credit → set leftCreditLimit (credit available TO left/counterparty)
      const isLeftEntity = entityState.entityId < counterpartyEntityId;
      const side = isLeftEntity ? 'right' : 'left';

      // Create set_credit_limit account transaction
      const accountTx: AccountTx = {
        type: 'set_credit_limit',
        data: {
          tokenId,
          amount,
          side: side as 'left' | 'right',
        },
      };

      // Pure: return mempoolOp instead of mutating directly
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });
      console.log(`💳 Added set_credit_limit to mempoolOps for account with ${counterpartyEntityId.slice(-4)}`);
      console.log(`💳 Setting ${side}CreditLimit=${amount} (counterparty is ${side}) for token ${tokenId}`);

      addMessage(newState, `💳 Extended credit of ${amount} to ${counterpartyEntityId.slice(-4)}`);

      // Trigger processing (same pattern as directPayment)
      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({
          entityId: entityState.entityId,
          signerId: firstValidator,
          entityTxs: [] // Empty - triggers processing
        });
      }

      console.log(`💸 DIRECT-PAYMENT RETURN: outputs.length=${outputs.length}`);

      return { newState, outputs, mempoolOps };
    }

    // === SWAP ENTITY HANDLERS ===
    if (entityTx.type === 'placeSwapOffer') {
      console.log(`📊 PLACE-SWAP-OFFER: ${entityState.entityId.slice(-4)} placing offer with ${entityTx.data.counterpartyEntityId.slice(-4)}`);

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, offerId, giveTokenId, giveAmount, wantTokenId, wantAmount, minFillRatio } = entityTx.data;

      // Use canonical key for account lookup
      // Account keyed by counterparty ID
      const accountMachine = newState.accounts.get(counterpartyEntityId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for swap offer`);
        return { newState: entityState, outputs: [] };
      }

      const accountTx: AccountTx = {
        type: 'swap_offer',
        data: { offerId, giveTokenId, giveAmount, wantTokenId, wantAmount, minFillRatio },
      };

      // Pure: return mempoolOp instead of mutating directly
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });
      console.log(`📊 Added swap_offer to mempoolOps for account with ${counterpartyEntityId.slice(-4)}`);

      // AUDIT FIX (CRITICAL-6): Use namespaced key to prevent offerId collisions across accounts
      // Key format: accountId:offerId (same as orderbook uses)
      const swapBookKey = `${counterpartyEntityId}:${offerId}`;
      newState.swapBook.set(swapBookKey, {
        offerId,
        accountId: counterpartyEntityId,
        giveTokenId,
        giveAmount,
        wantTokenId,
        wantAmount,
        minFillRatio: minFillRatio ?? 0,
        createdAt: BigInt(env.timestamp),
      });

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'resolveSwap') {
      console.log(`💱 RESOLVE-SWAP: ${entityState.entityId.slice(-4)} resolving offer with ${entityTx.data.counterpartyEntityId.slice(-4)}`);

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, offerId, fillRatio, cancelRemainder } = entityTx.data;

      // Use canonical key for account lookup
      // Account keyed by counterparty ID
      const accountMachine = newState.accounts.get(counterpartyEntityId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for swap resolve`);
        return { newState: entityState, outputs: [] };
      }

      const accountTx: AccountTx = {
        type: 'swap_resolve',
        data: { offerId, fillRatio, cancelRemainder },
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

    if (entityTx.type === 'fillSwapOffer') {
      // Alias for swap fill/resolve
      console.log(`💱 FILL-SWAP-OFFER: ${entityState.entityId.slice(-4)} filling offer`);

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { offerId, counterpartyId, fillRatio } = entityTx.data;

      const accountMachine = newState.accounts.get(counterpartyId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyId.slice(-4)}`);
        return { newState: entityState, outputs: [] };
      }

      // Create swap_resolve AccountTx
      const accountTx: AccountTx = {
        type: 'swap_resolve',
        data: { offerId, fillRatio, cancelRemainder: false },
      };

      mempoolOps.push({ accountId: counterpartyId, tx: accountTx });

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'cancelSwapOffer' || entityTx.type === 'cancelSwap') {
      console.log(`📊 CANCEL-SWAP: ${entityState.entityId.slice(-4)} cancelling offer with ${entityTx.data.counterpartyEntityId.slice(-4)}`);

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
        type: 'swap_cancel',
        data: { offerId },
      };

      // Pure: return mempoolOp instead of mutating directly
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });
      console.log(`📊 Added swap_cancel to mempoolOps for account with ${counterpartyEntityId.slice(-4)}`);

      // AUDIT FIX (CRITICAL-6): Use namespaced key for swapBook delete
      const swapBookKey = `${counterpartyEntityId}:${offerId}`;
      newState.swapBook.delete(swapBookKey);

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'requestWithdrawal') {
      const { handleRequestWithdrawal } = await import('./handlers/request-withdrawal');
      return { newState: handleRequestWithdrawal(entityState, entityTx), outputs: [] };
    }

    if (entityTx.type === 'settleDiffs') {
      console.log(`🏦 SETTLE-DIFFS: Processing settlement with ${entityTx.data.counterpartyEntityId}`);

      const newState = cloneEntityState(entityState);
      const { counterpartyEntityId, diffs, description } = entityTx.data;

      // Step 1: Validate invariant for all diffs
      for (const diff of diffs) {
        const sum = diff.leftDiff + diff.rightDiff + diff.collateralDiff;
        if (sum !== 0n) {
          logError("ENTITY_TX", `❌ INVARIANT-VIOLATION: leftDiff + rightDiff + collateralDiff = ${sum} (must be 0)`);
          throw new Error(`Settlement invariant violation: ${sum} !== 0`);
        }
      }

      // Step 2: Validate account exists (use canonical key)
      // Account keyed by counterparty ID
      if (!newState.accounts.has(settleAccountKey)) {
        logError("ENTITY_TX", `❌ No account exists with ${formatEntityId(counterpartyEntityId)}`);
        throw new Error(`No account with ${counterpartyEntityId}`);
      }

      // Step 3: Determine canonical left/right order
      const isLeft = entityState.entityId < counterpartyEntityId;
      const leftEntity = isLeft ? entityState.entityId : counterpartyEntityId;
      const rightEntity = isLeft ? counterpartyEntityId : entityState.entityId;

      console.log(`🏦 Canonical order: left=${leftEntity.slice(0,10)}..., right=${rightEntity.slice(0,10)}...`);
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

      console.log(`🏦 Calling submitSettle with diffs:`, safeStringify(contractDiffs, 2));

      // Step 6: Call Depository.settle() - fire and forget (j-watcher handles result)
      try {
        const result = await submitSettle(jurisdiction, leftEntity, rightEntity, contractDiffs);
        console.log(`✅ Settlement transaction sent: ${result.txHash}`);

        // Add message to chat
        addMessage(newState,
          `🏦 ${description || 'Settlement'} tx: ${result.txHash.slice(0, 10)}... (block ${result.blockNumber})`
        );
      } catch (error) {
        logError("ENTITY_TX", `❌ Settlement transaction failed:`, error);
        addMessage(newState, `❌ Settlement failed: ${(error as Error).message}`);
        throw error; // Re-throw to trigger outer catch
      }

      return { newState, outputs: [] };
    }

    console.warn(`⚠️ Unhandled EntityTx type: ${entityTx.type}`);
    return { newState: entityState, outputs: [], jOutputs: [] };
  } catch (error) {
    log.error(`❌ Transaction execution error: ${error}`);
    return { newState: entityState, outputs: [], jOutputs: [] }; // Return unchanged state on error
  }
};
