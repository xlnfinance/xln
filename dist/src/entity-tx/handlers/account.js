export function handleAccountInput(state, input, env) {
    console.log(`🚀 APPLY accountInput: ${input.fromEntityId} → ${input.toEntityId}`);
    // 1. Prevent self-joins: An entity should not be able to join its own hub
    if (input.fromEntityId === input.toEntityId) {
        console.log(`⚠️ Reject accountInput: cannot join own hub`);
        return state; // Return unchanged state
    }
    // 2. Validate hub capability: Only entities with "hub" capability should be joinable
    const targetProfile = env.gossip?.profiles?.get(input.toEntityId);
    if (!targetProfile) {
        console.log(`⚠️ Reject accountInput: target profile not found for ${input.toEntityId}`);
        return state;
    }
    const isHub = targetProfile.capabilities?.includes('hub') || targetProfile.capabilities?.includes('router');
    if (!isHub) {
        console.log(`⚠️ Reject accountInput: target is not a hub (capabilities: ${targetProfile.capabilities})`);
        return state;
    }
    // Create immutable copy of current state
    const newState = {
        ...state,
        nonces: new Map(state.nonces),
        messages: [...state.messages],
        proposals: new Map(state.proposals),
        reserves: new Map(state.reserves),
        channels: new Map(state.channels),
        collaterals: new Map(state.collaterals),
    };
    // If channel already exists, just log and return
    if (newState.channels.has(input.toEntityId)) {
        console.log(`⚠️ Account already exists between ${input.fromEntityId} and ${input.toEntityId}`);
        return newState;
    }
    // Create the channel on the source entity (current state)
    const timestamp = Date.now();
    newState.channels.set(input.toEntityId, {
        counterparty: input.toEntityId,
        myBalance: 0n,
        theirBalance: 0n,
        collateral: [],
        nonce: 1,
        isActive: true,
        lastUpdate: timestamp,
    });
    // Now create the symmetric channel on the target entity
    // Find target entity replicas and update their channel state
    let targetEntityUpdated = false;
    for (const [replicaKey, replica] of env.replicas) {
        if (replica.entityId === input.toEntityId) {
            // Check if channel already exists on target side
            if (!replica.state.channels.has(input.fromEntityId)) {
                // Create immutable copy of target state
                const updatedTargetState = {
                    ...replica.state,
                    nonces: new Map(replica.state.nonces),
                    messages: [...replica.state.messages],
                    proposals: new Map(replica.state.proposals),
                    reserves: new Map(replica.state.reserves),
                    channels: new Map(replica.state.channels),
                    collaterals: new Map(replica.state.collaterals),
                };
                // Add symmetric channel
                updatedTargetState.channels.set(input.fromEntityId, {
                    counterparty: input.fromEntityId,
                    myBalance: 0n,
                    theirBalance: 0n,
                    collateral: [],
                    nonce: 1,
                    isActive: true,
                    lastUpdate: timestamp,
                });
                // Update the replica in the environment
                env.replicas.set(replicaKey, {
                    ...replica,
                    state: updatedTargetState,
                });
                targetEntityUpdated = true;
            }
        }
    }
    if (targetEntityUpdated) {
        console.log(`🚀 APPLY accountInput: ${input.fromEntityId} → ${input.toEntityId} (channel created in both states)`);
    }
    else {
        console.log(`⚠️ Target entity ${input.toEntityId} not found or channel already exists`);
    }
    return newState;
}
