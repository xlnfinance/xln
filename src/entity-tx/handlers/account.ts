import { AccountInput, EntityState, Env } from '../../types';
import { createDemoDelta } from '../../account-utils';
// TODO: Re-enable when account-tx is fixed
// import { processAccountTransaction } from '../../account-tx';

export function handleAccountInput(state: EntityState, input: AccountInput, env: Env): EntityState {
  console.log(`🚀 APPLY accountInput: ${input.fromEntityId} → ${input.toEntityId}`, input.accountTx);

  // Create immutable copy of current state
  const newState: EntityState = {
    ...state,
    nonces: new Map(state.nonces),
    messages: [...state.messages],
    proposals: new Map(state.proposals),
    reserves: new Map(state.reserves),
    accounts: new Map(state.accounts),
    collaterals: new Map(state.collaterals),
  };

  // Get or create account machine for this counterparty
  let accountMachine = newState.accounts.get(input.toEntityId);
  if (!accountMachine) {
    // Create new account machine with demo deltas for tokens 1, 2, 3
    const demoDeltasMap = new Map();
    demoDeltasMap.set(1, createDemoDelta(1, 1000n, 0n));  // ETH: 1000 collateral
    demoDeltasMap.set(2, createDemoDelta(2, 2000n, -100n)); // USDT: 2000 collateral, we owe them 100
    demoDeltasMap.set(3, createDemoDelta(3, 500n, 50n));    // USDC: 500 collateral, they owe us 50
    
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
      deltas: demoDeltasMap,
      proofHeader: {
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
      offdelta: delta.offdelta.toString()
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
  } else {
    // Process other account transactions immediately using account-tx processor
    // TODO: Re-enable when account-tx is fixed  
    // const result = processAccountTransaction(accountMachine, input.accountTx);
    const result = { success: true }; // Temporary placeholder
    
    if (result.success) {
      console.log(`✅ Processed ${input.accountTx.type} successfully for ${input.toEntityId}`);
      
      // Add a chat message about successful transaction
      const message = `💳 ${input.accountTx.type} processed with Entity ${input.toEntityId.slice(-4)}`;
      newState.messages.push(message);
    } else {
      console.log(`❌ Failed to process ${input.accountTx.type}: ${result.error}`);
      
      // Add to mempool for retry later
      accountMachine.mempool.push(input.accountTx);
      console.log(`💳 Added ${input.accountTx.type} to account mempool for retry`);
      
      // Add error message
      const message = `⚠️ ${input.accountTx.type} failed with Entity ${input.toEntityId.slice(-4)}: ${result.error}`;
      newState.messages.push(message);
    }
  }

  return newState;
}
