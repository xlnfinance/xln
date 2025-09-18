import { DEBUG } from '../utils';
// Token registry for consistent naming (matches contract prefunding)
const TOKEN_REGISTRY = {
    0: { symbol: 'NULL', name: 'Null Token', decimals: 18 }, // Contract reserves slot 0 but doesn't prefund
    1: { symbol: 'ETH', name: 'Ethereum', decimals: 18 }, // Contract prefunds token 1
    2: { symbol: 'USDT', name: 'Tether USD', decimals: 18 }, // Contract prefunds token 2  
    3: { symbol: 'USDC', name: 'USD Coin', decimals: 18 }, // Contract prefunds token 3
    4: { symbol: 'ACME', name: 'ACME Corp Shares', decimals: 18 },
    5: { symbol: 'BTC', name: 'Bitcoin Shares', decimals: 8 },
};
const getTokenSymbol = (tokenId) => {
    return TOKEN_REGISTRY[tokenId]?.symbol || `TKN${tokenId}`;
};
const getTokenDecimals = (tokenId) => {
    return TOKEN_REGISTRY[tokenId]?.decimals || 18;
};
export const handleJEvent = (entityState, entityTxData) => {
    const { from, event, observedAt, blockNumber, transactionHash } = entityTxData;
    // Reject events from blocks we've already processed  
    if (blockNumber <= entityState.jBlock) {
        console.log(`🔄 Ignoring old j-event: ${event.type} from block ${blockNumber} (entity already at j-block ${entityState.jBlock})`);
        return entityState;
    }
    const newEntityState = {
        ...entityState,
        messages: [...entityState.messages],
        reserves: new Map(entityState.reserves),
        nonces: new Map(entityState.nonces),
        proposals: new Map(entityState.proposals),
        accounts: new Map(entityState.accounts),
        collaterals: new Map(entityState.collaterals),
        jBlock: blockNumber || entityState.jBlock,
    };
    // Create elaborate j-event message with full details
    const timestamp = new Date(observedAt).toLocaleTimeString();
    const txHashShort = transactionHash ? transactionHash.slice(0, 10) + '...' : 'unknown';
    let elaborateMessage = '';
    if (event.type === 'reserve_transferred') {
        const { from: fromEntity, to: toEntity, tokenId, amount, direction } = event.data;
        const tokenSymbol = getTokenSymbol(tokenId);
        const decimals = getTokenDecimals(tokenId);
        const amountDisplay = (Number(amount) / (10 ** decimals)).toFixed(4);
        if (direction === 'sent') {
            elaborateMessage = `💸 ${from} observed RESERVE TRANSFER: Sent ${amountDisplay} ${tokenSymbol} to Entity ${toEntity.slice(-1)}
📍 Block: ${blockNumber} | ⏰ ${timestamp} | 🔗 Tx: ${txHashShort}
🎯 Event: ReserveTransferred | 🔢 TokenID: ${tokenId} | 💰 Amount: ${amount} (raw)`;
        }
        else {
            elaborateMessage = `💰 ${from} observed RESERVE TRANSFER: Received ${amountDisplay} ${tokenSymbol} from Entity ${fromEntity.slice(-1)}
📍 Block: ${blockNumber} | ⏰ ${timestamp} | 🔗 Tx: ${txHashShort}
🎯 Event: ReserveTransferred | 🔢 TokenID: ${tokenId} | 💰 Amount: ${amount} (raw)`;
        }
    }
    else if (event.type === 'ReserveUpdated') {
        const { tokenId, newBalance } = event.data;
        const tokenSymbol = getTokenSymbol(tokenId);
        const decimals = getTokenDecimals(tokenId);
        const balanceDisplay = (Number(newBalance) / (10 ** decimals)).toFixed(4);
        elaborateMessage = `📊 ${from} observed RESERVE UPDATE: ${tokenSymbol} balance now ${balanceDisplay}
📍 Block: ${blockNumber} | ⏰ ${timestamp} | 🔗 Tx: ${txHashShort}
🎯 Event: ReserveUpdated | 🔢 TokenID: ${tokenId} | 💰 New Balance: ${newBalance} (raw)
🏦 Decimals: ${decimals} | 🔤 Symbol: ${tokenSymbol}`;
    }
    else {
        elaborateMessage = `🔍 ${from} observed J-EVENT: ${event.type}
📍 Block: ${blockNumber} | ⏰ ${timestamp} | 🔗 Tx: ${txHashShort}
📋 Data: ${JSON.stringify(event.data, null, 2)}`;
    }
    newEntityState.messages.push(elaborateMessage);
    if (event.type === 'ReserveUpdated') {
        const { entity, tokenId, newBalance, name, symbol, decimals } = event.data;
        if (entity === entityState.entityId) {
            newEntityState.reserves.set(String(tokenId), {
                amount: BigInt(newBalance),
            });
            if (DEBUG)
                console.log(`✅ Reserve updated for ${entity.slice(0, 10)}...: Token ${tokenId} new balance is ${newBalance}`);
        }
    }
    else if (event.type === 'reserve_transferred') {
        const { from, to, tokenId, amount, direction } = event.data;
        // Update reserves based on transfer direction
        if (direction === 'sent') {
            const currentReserve = newEntityState.reserves.get(String(tokenId));
            if (currentReserve) {
                const newAmount = currentReserve.amount - BigInt(amount);
                newEntityState.reserves.set(String(tokenId), {
                    amount: newAmount >= 0n ? newAmount : 0n
                });
            }
            // Message already added above
        }
        else if (direction === 'received') {
            const currentReserve = newEntityState.reserves.get(String(tokenId)) || {
                amount: 0n
            };
            newEntityState.reserves.set(String(tokenId), {
                amount: currentReserve.amount + BigInt(amount)
            });
            // Message already added above
        }
        if (DEBUG)
            console.log(`✅ Reserve transfer processed: ${direction} ${amount} token ${tokenId}`);
    }
    else {
        newEntityState.messages.push(`⚠️ Unhandled j-event type: ${event.type}`);
    }
    return newEntityState;
};
