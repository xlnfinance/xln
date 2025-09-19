import { AccountInput, EntityState, Env } from '../../types';
import { createDemoDelta } from '../../account-utils';
import { handleAccountInput as processAccountInput, addToAccountMempool } from '../../account-consensus';
import { cloneEntityState } from '../../state-helpers';

export function handleAccountInput(state: EntityState, input: AccountInput, env: Env): EntityState {
  console.log(`🚀 APPLY accountInput: ${input.fromEntityId} → ${input.toEntityId}`, input.accountTx);

  // Create immutable copy of current state
  const newState: EntityState = cloneEntityState(state);

  // Add chat message about receiving account input
  if (input.accountTx) {
    newState.messages.push(`📨 Received ${input.accountTx.type} from Entity ${input.fromEntityId.slice(-4)}`);
  }

  // Get or create account machine for this counterparty
  let accountMachine = newState.accounts.get(input.toEntityId);
  if (!accountMachine) {
    // Create new account machine with demo deltas for tokens 1, 2, 3
    const demoDeltasMap = new Map();
    demoDeltasMap.set(1, createDemoDelta(1, 1000n, 0n)); // ETH: 1000 collateral
    demoDeltasMap.set(2, createDemoDelta(2, 2000n, -100n)); // USDT: 2000 collateral, we owe them 100
    demoDeltasMap.set(3, createDemoDelta(3, 500n, 50n)); // USDC: 500 collateral, they owe us 50

    accountMachine = {
      counterpartyEntityId: input.toEntityId,
      mempool: [],
      currentFrame: {
        frameId: 0,
        timestamp: Date.now(),
        tokenIds: [1, 2, 3],
        deltas: [0n, -100n, 50n],
      },
      sentTransitions: 0,
      ackedTransitions: 0,
      deltas: demoDeltasMap,
      globalCreditLimits: {
        ownLimit: 1000000n, // We extend 1M USD credit to counterparty
        peerLimit: 1000000n, // Counterparty extends 1M USD credit to us
      },
      // Frame-based consensus fields
      currentFrameId: 0,
      pendingFrame: undefined,
      pendingSignatures: [],
      rollbackCount: 0,
      isProposer: state.entityId < input.toEntityId, // Lexicographically smaller is proposer
      clonedForValidation: undefined,
      proofHeader: {
        fromEntity: state.entityId,
        toEntity: input.toEntityId,
        cooperativeNonce: 0,
        disputeNonce: 0,
      },
      proofBody: {
        tokenIds: [1, 2, 3],
        deltas: [0n, -100n, 50n],
      },
    };
    newState.accounts.set(input.toEntityId, accountMachine);
    console.log(`💳 Created new account machine for counterparty ${input.toEntityId}`);
  }

  // Process the account transaction immediately based on type
  if (input.accountTx.type === 'account_settle') {
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
  } else if (input.frameId || input.newAccountFrame || input.accountFrame) {
    // Handle frame-level consensus using production account-consensus system
    console.log(`🤝 Processing frame-level AccountInput from ${input.fromEntityId.slice(-4)}`);

    const result = processAccountInput(accountMachine, input);

    if (result.success) {
      // Add events to entity messages
      newState.messages.push(...result.events);

      // If there's a response, queue it for sending back
      if (result.response) {
        // TODO: Send response back to counterparty
        console.log(`📤 Would send AccountInput response back to ${result.response.toEntityId.slice(-4)}`);
      }
    } else {
      console.log(`❌ Frame consensus failed: ${result.error}`);
      newState.messages.push(`❌ Frame consensus failed with Entity ${input.fromEntityId.slice(-4)}: ${result.error}`);
    }
  } else if (input.accountTx) {
    // Handle transaction-level input - add to mempool
    console.log(`📥 Adding ${input.accountTx.type} to account mempool for ${input.toEntityId.slice(0,10)}`);

    const added = addToAccountMempool(accountMachine, input.accountTx);

    if (added) {
      const message = `💳 ${input.accountTx.type} queued for processing with Entity ${input.toEntityId.slice(-4)}`;
      newState.messages.push(message);
      console.log(`📊 Account mempool now has ${accountMachine.mempool.length} pending transactions`);
    } else {
      const message = `❌ Failed to add ${input.accountTx.type} to mempool (full)`;
      newState.messages.push(message);
    }
  }

  return newState;
}
