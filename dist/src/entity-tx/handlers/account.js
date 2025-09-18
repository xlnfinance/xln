import { createDemoDelta } from '../../account-utils';
export function handleAccountInput(state, input, env) {
    console.log(`🚀 APPLY accountInput: ${input.fromEntityId} → ${input.toEntityId}`, input.accountTx);
    // Create immutable copy of current state
    const newState = {
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
    // Add the account transaction to mempool
    accountMachine.mempool.push(input.accountTx);
    console.log(`💳 Added ${input.accountTx.type} to account mempool for ${input.toEntityId}`);
    // Add a chat message about the account activity
    const message = `💳 Account activity: ${input.accountTx.type} with Entity ${input.toEntityId.slice(-4)}`;
    newState.messages.push(message);
    return newState;
}
