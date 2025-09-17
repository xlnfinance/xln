import { DEBUG } from '../utils';
export const handleJEvent = (entityState, entityTxData) => {
    const { from, event, observedAt, blockNumber, transactionHash } = entityTxData;
    const newEntityState = {
        ...entityState,
        messages: [...entityState.messages],
        reserves: new Map(entityState.reserves),
        nonces: new Map(entityState.nonces),
        proposals: new Map(entityState.proposals),
        channels: new Map(entityState.channels),
        collaterals: new Map(entityState.collaterals),
    };
    newEntityState.messages.push(`${from} observed j-event: ${event.type} (block ${blockNumber}, tx ${transactionHash.slice(0, 10)}...)`);
    if (event.type === 'ReserveUpdated') {
        const { entity, tokenId, newBalance, name, symbol, decimals } = event.data;
        if (entity === entityState.entityId) {
            newEntityState.reserves.set(String(tokenId), {
                symbol: symbol || name || `TKN${tokenId}`,
                amount: BigInt(newBalance),
                decimals: decimals === undefined ? 18 : decimals,
            });
            if (DEBUG)
                console.log(`✅ Reserve updated for ${entity.slice(0, 10)}...: Token ${tokenId} new balance is ${newBalance}`);
        }
    }
    else {
        newEntityState.messages.push(`⚠️ Unhandled j-event type: ${event.type}`);
    }
    return newEntityState;
};
