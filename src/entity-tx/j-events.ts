import { EntityState } from '../types';
import { DEBUG } from '../utils';
import { cloneEntityState } from '../state-helpers';
import { getTokenInfo } from '../account-utils';

const getTokenSymbol = (tokenId: number): string => {
  return getTokenInfo(tokenId).symbol;
};

const getTokenDecimals = (tokenId: number): number => {
  return getTokenInfo(tokenId).decimals;
};

export const handleJEvent = (entityState: EntityState, entityTxData: any): EntityState => {
  const { from, event, observedAt, blockNumber, transactionHash } = entityTxData;

  // Reject events from blocks we've already processed - handle undefined jBlock
  const currentJBlock = entityState.jBlock || 0;
  console.log(`🔍 J-EVENT-CHECK: ${event.type} block=${blockNumber} vs entity.jBlock=${currentJBlock} (raw=${entityState.jBlock}), from=${from}`);
  if (blockNumber <= currentJBlock) {
    console.log(`🔄 IGNORING OLD J-EVENT: ${event.type} from block ${blockNumber} (entity already at j-block ${entityState.jBlock})`);
    return entityState;
  }
  console.log(`✅ J-EVENT-ACCEPTED: ${event.type} block=${blockNumber} > entity.jBlock=${entityState.jBlock}, will process`);

  const newEntityState = cloneEntityState(entityState);
  // Update jBlock to current event block
  newEntityState.jBlock = blockNumber ?? (entityState.jBlock ?? 0);

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
    } else {
      elaborateMessage = `💰 ${from} observed RESERVE TRANSFER: Received ${amountDisplay} ${tokenSymbol} from Entity ${fromEntity.slice(-1)}
📍 Block: ${blockNumber} | ⏰ ${timestamp} | 🔗 Tx: ${txHashShort}
🎯 Event: ReserveTransferred | 🔢 TokenID: ${tokenId} | 💰 Amount: ${amount} (raw)`;
    }
  } else if (event.type === 'ReserveUpdated') {
    const { tokenId, newBalance } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId);
    const decimals = getTokenDecimals(tokenId);
    const balanceDisplay = (Number(newBalance) / (10 ** decimals)).toFixed(4);
    
    elaborateMessage = `📊 ${from} observed RESERVE UPDATE: ${tokenSymbol} balance now ${balanceDisplay} (accepted: event.block=${blockNumber} > entity.jBlock=${currentJBlock})
📍 Block: ${blockNumber} | ⏰ ${timestamp} | 🔗 Tx: ${txHashShort}
🎯 Event: ReserveUpdated | 🔢 TokenID: ${tokenId} | 💰 New Balance: ${newBalance} (raw)
🏦 Decimals: ${decimals} | 🔤 Symbol: ${tokenSymbol}`;
  } else if (event.type === 'SettlementProcessed') {
    const { counterpartyEntityId, tokenId, ownReserve, counterpartyReserve, collateral, ondelta, side } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId);
    const decimals = getTokenDecimals(tokenId);
    const ownBalanceDisplay = (Number(ownReserve) / (10 ** decimals)).toFixed(4);
    const counterpartyBalanceDisplay = (Number(counterpartyReserve) / (10 ** decimals)).toFixed(4);
    const collateralDisplay = (Number(collateral) / (10 ** decimals)).toFixed(4);
    
    elaborateMessage = `⚖️ ${from} observed SETTLEMENT: ${tokenSymbol} settled with Entity ${counterpartyEntityId.slice(-4)}
📍 Block: ${blockNumber} | ⏰ ${timestamp} | 🔗 Tx: ${txHashShort}
🎯 Event: SettlementProcessed | 🔢 TokenID: ${tokenId} | 👤 Side: ${side}
💰 Own Reserve: ${ownBalanceDisplay} | 🤝 Counterparty: ${counterpartyBalanceDisplay}
🔒 Collateral: ${collateralDisplay} | 📊 OnDelta: ${ondelta}`;
  } else {
    elaborateMessage = `🔍 ${from} observed J-EVENT: ${event.type}
📍 Block: ${blockNumber} | ⏰ ${timestamp} | 🔗 Tx: ${txHashShort}
📋 Data: ${JSON.stringify(event.data, null, 2)}`;
  }
  
  newEntityState.messages.push(elaborateMessage);

  if (event.type === 'ReserveUpdated') {
    const { entity, tokenId, newBalance } = event.data;
    
    if (entity === entityState.entityId) {
      newEntityState.reserves.set(String(tokenId), BigInt(newBalance));
      if (DEBUG) console.log(`✅ Reserve updated for ${entity.slice(0,10)}...: Token ${tokenId} new balance is ${newBalance}`);
    }
  } else if (event.type === 'reserve_transferred') {
    const { tokenId, amount, direction } = event.data;
    
    // Update reserves based on transfer direction - entityState guaranteed by validation
    if (direction === 'sent') {
      const currentReserve = newEntityState.reserves.get(String(tokenId));
      if (currentReserve === undefined) {
        // Initialize reserve to 0n if not present (new token)
        newEntityState.reserves.set(String(tokenId), 0n);
        console.warn(`🔍 RESERVE-INIT: Initialized new token ${tokenId} reserve to 0n`);
      }
      const actualReserve = newEntityState.reserves.get(String(tokenId))!; // Now guaranteed to exist
      const newAmount = actualReserve - BigInt(amount);
      newEntityState.reserves.set(String(tokenId), newAmount >= 0n ? newAmount : 0n);
      // Message already added above
    } else if (direction === 'received') {
      const currentReserve = newEntityState.reserves.get(String(tokenId));
      if (currentReserve === undefined) {
        // Initialize reserve to 0n if not present (new token)
        newEntityState.reserves.set(String(tokenId), 0n);
        console.warn(`🔍 RESERVE-INIT: Initialized new token ${tokenId} reserve to 0n`);
      }
      const actualReserve = newEntityState.reserves.get(String(tokenId))!; // Now guaranteed to exist
      newEntityState.reserves.set(String(tokenId), actualReserve + BigInt(amount));
      // Message already added above
    }
    
    if (DEBUG) console.log(`✅ Reserve transfer processed: ${direction} ${amount} token ${tokenId}`);
  } else if (event.type === 'SettlementProcessed') {
    const { counterpartyEntityId, tokenId, ownReserve, counterpartyReserve, collateral, ondelta, side } = event.data;
    
    // Update own reserves based on the settlement
    newEntityState.reserves.set(String(tokenId), BigInt(ownReserve));
    
    // Create accountInput to feed into a-machine for bilateral consensus
    // This enables the settlement event to be processed by the account machine
    const accountInput = {
      fromEntityId: entityState.entityId,
      toEntityId: counterpartyEntityId,
      accountTx: {
        type: 'account_settle' as const,
        data: {
          tokenId: Number(tokenId),
          ownReserve: ownReserve,
          counterpartyReserve: counterpartyReserve,
          collateral: collateral,
          ondelta: ondelta,
          side: side,
          blockNumber: blockNumber,
          transactionHash: transactionHash
        }
      },
      metadata: {
        purpose: 'settlement_consensus',
        description: `Settlement event from j-machine for token ${tokenId}`
      }
    };
    
    // Add to entity's account inputs queue for processing
    // This will be processed by the account handler to update bilateral account state
    if (!newEntityState.accountInputQueue) {
      newEntityState.accountInputQueue = [];
    }
    newEntityState.accountInputQueue.push(accountInput);
    
    if (DEBUG) console.log(`✅ SettlementProcessed: Created accountInput for token ${tokenId} with counterparty ${counterpartyEntityId.slice(0,10)}...`);
  } else {
    newEntityState.messages.push(`⚠️ Unhandled j-event type: ${event.type}`);
  }

  return newEntityState;
};
