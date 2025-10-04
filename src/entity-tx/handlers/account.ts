import { AccountInput, EntityState, Env, EntityInput } from '../../types';
import { handleAccountInput as processAccountInput } from '../../account-consensus';
import { cloneEntityState } from '../../state-helpers';
import { formatEntityId } from '../../entity-helpers';
import { createDemoDelta, getDefaultCreditLimit } from '../../account-utils';

export async function handleAccountInput(state: EntityState, input: AccountInput, env: Env): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  console.log(`🚀 APPLY accountInput: ${input.fromEntityId} → ${input.toEntityId}`, input.accountTx);

  // Create immutable copy of current state
  const newState: EntityState = cloneEntityState(state);
  const outputs: EntityInput[] = [];

  // Add chat message about receiving account input
  if (input.accountTx && input.accountTx.type) {
    newState.messages.push(`📨 Received ${input.accountTx.type} from Entity ${input.fromEntityId.slice(-4)}`);
  } else if (!input.accountTx) {
    console.warn(`⚠️ Received accountInput without accountTx from ${input.fromEntityId}`);
    newState.messages.push(`📨 Received account request from Entity ${input.fromEntityId.slice(-4)}`);
  }

  // Get or create account machine for this counterparty (fromEntityId is who we're creating an account WITH)
  let accountMachine = newState.accounts.get(input.fromEntityId);
  if (!accountMachine) {
    // Initialize with default USDC delta showing credit limits (no collateral initially)
    const initialDeltas = new Map();
    initialDeltas.set(2, createDemoDelta(2, 0n, 0n));

    accountMachine = {
      counterpartyEntityId: input.fromEntityId,
      mempool: [],
      currentFrame: {
        frameId: 0,
        timestamp: Date.now(),
        tokenIds: [],
        deltas: [],
      },
      sentTransitions: 0,
      ackedTransitions: 0,
      deltas: initialDeltas,
      globalCreditLimits: {
        ownLimit: getDefaultCreditLimit(2),
        peerLimit: getDefaultCreditLimit(2),
      },
      // Frame-based consensus fields
      currentFrameId: 0,
      pendingSignatures: [],
      rollbackCount: 0,
      // CHANNEL.TS REFERENCE: Proper message counters (NOT timestamps!)
      sendCounter: 0,    // Like Channel.ts line 131
      receiveCounter: 0, // Like Channel.ts line 132
      // Removed isProposer - use isLeft() function like old_src Channel.ts
      proofHeader: {
        fromEntity: state.entityId,
        toEntity: input.fromEntityId,  // Fixed: should be fromEntityId
        cooperativeNonce: 0,
        disputeNonce: 0,
      },
      proofBody: {
        tokenIds: [1, 2, 3],
        deltas: [0n, -100n, 50n],
      },
      frameHistory: [] // Initialize empty frame history
    };
    newState.accounts.set(input.fromEntityId, accountMachine);  // Fixed: use fromEntityId as key
    console.log(`💳 Created new account machine for counterparty ${input.fromEntityId}`);
  }

  // FINTECH-SAFETY: Ensure accountMachine exists after creation/retrieval
  if (!accountMachine) {
    throw new Error(`CRITICAL: AccountMachine creation failed for ${input.fromEntityId}`);
  }

  // Process the account transaction immediately based on type
  if (input.accountTx && input.accountTx.type === 'account_payment' && input.accountTx.data.amount === 0n) {
    // Handle incoming account opening (account_payment with 0 amount indicates account opening)
    console.log(`💳 Received account opening request from Entity ${input.fromEntityId.slice(-4)}`);

    // Account already created above, just acknowledge
    newState.messages.push(`✅ Account opened with Entity ${formatEntityId(input.fromEntityId)}`);
    console.log(`💳 Account established with Entity ${input.fromEntityId.slice(-4)}`);

    // No need to send a response - accounts are symmetric
    // Both sides create their account independently
  } else if (input.accountTx && input.accountTx.type === 'account_settle') {
    // Process settlement event from blockchain
    const settleData = input.accountTx.data;
    const tokenId = settleData.tokenId;

    console.log(`💰 Processing settlement for token ${tokenId}:`, settleData);

    // Get or create delta for this token
    let delta = accountMachine.deltas.get(tokenId);
    if (!delta) {
      delta = createDemoDelta(tokenId, 0n, 0n);
      accountMachine.deltas.set(tokenId, delta);
    }

    // Update delta with settlement data
    delta.collateral = BigInt(settleData.collateral);
    delta.ondelta = BigInt(settleData.ondelta);

    console.log(`💰 Updated delta for token ${tokenId}:`, {
      tokenId: delta.tokenId,
      collateral: delta.collateral.toString(),
      ondelta: delta.ondelta.toString(),
      offdelta: delta.offdelta.toString(),
    });

    // Update current frame with new settlement
    const frameTokenIds = accountMachine.currentFrame.tokenIds;
    const frameDeltas = [...accountMachine.currentFrame.deltas];

    const tokenIndex = frameTokenIds.indexOf(tokenId);
    if (tokenIndex >= 0) {
      // Update existing token in frame
      frameDeltas[tokenIndex] = delta.ondelta + delta.offdelta;
    } else {
      // Add new token to frame
      frameTokenIds.push(tokenId);
      frameDeltas.push(delta.ondelta + delta.offdelta);
    }

    accountMachine.currentFrame = {
      frameId: accountMachine.currentFrame.frameId + 1,
      timestamp: Date.now(),
      tokenIds: frameTokenIds,
      deltas: frameDeltas,
    };

    // Add chat message about the settlement
    const message = `💰 Settlement processed: Token ${tokenId}, Collateral ${settleData.collateral}, OnDelta ${settleData.ondelta}`;
    newState.messages.push(message);

    console.log(`✅ Settlement processed for Entity ${input.toEntityId.slice(-4)}, Token ${tokenId}`);
  } else if (input.frameId || input.newAccountFrame) {
    // Handle frame-level consensus using production account-consensus system
    console.log(`🤝 Processing frame-level AccountInput from ${input.fromEntityId.slice(-4)}`);

    const result = processAccountInput(accountMachine, input);

    if (result.success) {
      // Add events to entity messages
      newState.messages.push(...result.events);

      // If there's a response, queue it for sending back
      if (result.response) {
        console.log(`📤 Sending AccountInput ACK back to ${result.response.toEntityId.slice(-4)}`);

        // Get the proposer of the target entity
        let targetProposerId = 'alice'; // Default fallback
        const targetReplicaKeys = Array.from(env.replicas.keys()).filter(key => key.startsWith((result.response?.toEntityId || '') + ':'));
        if (targetReplicaKeys.length > 0) {
          const firstTargetReplica = env.replicas.get(targetReplicaKeys[0]!);
          if (firstTargetReplica?.state.config.validators[0]) {
            targetProposerId = firstTargetReplica.state.config.validators[0];
          }
        }

        // Create output to send ACK back to counterparty
        outputs.push({
          entityId: result.response?.toEntityId || '',
          signerId: targetProposerId,
          entityTxs: [{
            type: 'accountInput',
            data: result.response
          }]
        });

        console.log(`✅ ACK queued for Entity ${result.response.toEntityId.slice(-4)}`);
      }
    } else {
      console.log(`❌ Frame consensus failed: ${result.error}`);
      newState.messages.push(`❌ Frame consensus failed with Entity ${input.fromEntityId.slice(-4)}: ${result.error}`);
    }
  } else if (input.accountTx) {
    // Special handling for direct_payment - needs to be forwarded
    if (input.accountTx && input.accountTx.type === 'direct_payment') {
      const paymentData = input.accountTx.data;
      console.log(`💸 Processing direct_payment relay: route=${paymentData.route}, amount=${paymentData.amount}`);

      // Check if we're the final destination
      if (!paymentData.route || paymentData.route.length === 0) {
        // We are the final destination - payment complete!
        newState.messages.push(`💰 Received payment: ${paymentData.amount} (token ${paymentData.tokenId}) - ${paymentData.description}`);
        console.log(`✅ Payment received at final destination`);
        // IMPORTANT: Do NOT add to mempool - payment is already in the frame being processed
        // The frame consensus already handled this transaction
      } else if (paymentData.route.length === 1 && paymentData.route[0] === state.entityId) {
        // Route contains only us - we're the destination
        newState.messages.push(`💰 Received payment: ${paymentData.amount} (token ${paymentData.tokenId}) - ${paymentData.description}`);
        console.log(`✅ Payment received at final destination (single hop)`);
        // IMPORTANT: Do NOT add to mempool - payment is already in the frame being processed
        // The frame consensus already handled this transaction
      } else {
        // We need to forward the payment to the next hop
        const nextHop = paymentData.route[0];
        const remainingRoute = paymentData.route.slice(1);

        console.log(`💸 Forwarding payment to next hop: ${nextHop}, remaining route: ${remainingRoute}`);

        // Check if we have an account with next hop
        if (!nextHop || !newState.accounts.has(nextHop)) {
          console.error(`❌ Cannot forward payment: No account with ${nextHop}`);
          newState.messages.push(`❌ Payment routing failed: No account with Entity ${nextHop?.slice(-4) || 'unknown'}`);
        } else {
          // Calculate forwarding fee (0.1% with 1 token minimum)
          const feeRate = 1000n; // 0.1% = 1/1000
          const fee = paymentData.amount / feeRate > 1n ? paymentData.amount / feeRate : 1n;
          const forwardAmount = paymentData.amount - fee;

          console.log(`💰 Forwarding fee: ${fee}, forward amount: ${forwardAmount}`);

          // Check next hop capacity
          const nextAccount = newState.accounts.get(nextHop);
          if (!nextAccount) {
            console.error(`❌ Next hop account not found`);
            newState.messages.push(`❌ Payment routing failed: No account with ${nextHop.slice(-4)}`);
            return { newState, outputs };
          }

          const nextDelta = nextAccount.deltas.get(paymentData.tokenId);
          if (!nextDelta) {
            console.error(`❌ Next hop doesn't support token ${paymentData.tokenId}`);
            newState.messages.push(`❌ Payment routing failed: Next hop doesn't support token`);
            return { newState, outputs };
          }

          // Check capacity using deriveDelta
          const isLeft = state.entityId < nextHop;
          const derived = env.xlnFunctions?.deriveDelta(nextDelta, isLeft);
          if (!derived || forwardAmount > derived.outCapacity) {
            console.error(`❌ Next hop insufficient capacity: ${derived?.outCapacity || 0n} < ${forwardAmount}`);
            newState.messages.push(`❌ Payment routing failed: Insufficient capacity at next hop`);
            return { newState, outputs };
          }

          // Create forwarded payment AccountTx
          const forwardedPayment = {
            type: 'direct_payment' as const,
            data: {
              tokenId: paymentData.tokenId,
              amount: forwardAmount, // Reduced by fee
              route: remainingRoute,
              ...(paymentData.description ? { description: paymentData.description } : {}),
              fromEntityId: state.entityId,
              toEntityId: nextHop,
            },
          };

          // Add to mempool for the next hop account
          const nextHopAccount = newState.accounts.get(nextHop);
          if (nextHopAccount) {
            nextHopAccount.mempool.push(forwardedPayment);
            newState.messages.push(`⚡ Relaying payment to Entity ${nextHop?.slice(-4)} (${remainingRoute.length} hops remaining)`);
            console.log(`📤 Payment forwarded to ${nextHop} account mempool`);
          }
        }
      }
    } else if (input.accountTx) {
      // Handle other transaction types
      // IMPORTANT: Do NOT add incoming transactions to our mempool
      // The transactions will be processed when they arrive in a frame
      console.log(`📥 Received ${input.accountTx.type} from ${input.fromEntityId.slice(-4)} - will be processed in next frame`);

      // Just acknowledge receipt - don't add to mempool
      newState.messages.push(`📨 Received ${input.accountTx.type} from Entity ${input.fromEntityId.slice(-4)}`);
    }
  }

  return { newState, outputs };
}
