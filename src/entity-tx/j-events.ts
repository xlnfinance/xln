import { EntityState } from '../types';
import { DEBUG } from '../utils';
import { cloneEntityState } from '../state-helpers';
import { getTokenInfo } from '../account-utils';
import { safeStringify } from '../serialization-utils';

/**
 * Jurisdiction event transaction data structure
 * These events come from blockchain watchers observing on-chain activity
 */
export interface JEventEntityTxData {
  from: string;  // Entity ID that observed the event
  event: {
    type: string;  // Event name (e.g., "ReserveUpdated", "SettlementProcessed")
    data: Record<string, unknown>;  // Event-specific data from blockchain
  };
  observedAt: number;  // Timestamp when event was observed (ms)
  blockNumber: number;  // Blockchain block number where event occurred
  transactionHash: string;  // Blockchain transaction hash
}

const getTokenSymbol = (tokenId: number): string => {
  return getTokenInfo(tokenId).symbol;
};

const getTokenDecimals = (tokenId: number): number => {
  return getTokenInfo(tokenId).decimals;
};

/**
 * Handle jurisdiction (blockchain) events
 * @param entityState - Current entity state
 * @param entityTxData - Validated J-event transaction data
 */
export const handleJEvent = (entityState: EntityState, entityTxData: JEventEntityTxData): EntityState => {
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
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const amountDisplay = (Number(amount) / (10 ** decimals)).toFixed(4);

    if (direction === 'sent') {
      elaborateMessage = `💸 ${from} observed RESERVE TRANSFER: Sent ${amountDisplay} ${tokenSymbol} to Entity ${(toEntity as string).slice(-1)}
📍 Block: ${blockNumber} | ⏰ ${timestamp} | 🔗 Tx: ${txHashShort}
🎯 Event: ReserveTransferred | 🔢 TokenID: ${tokenId} | 💰 Amount: ${amount} (raw)`;
    } else {
      elaborateMessage = `💰 ${from} observed RESERVE TRANSFER: Received ${amountDisplay} ${tokenSymbol} from Entity ${(fromEntity as string).slice(-1)}
📍 Block: ${blockNumber} | ⏰ ${timestamp} | 🔗 Tx: ${txHashShort}
🎯 Event: ReserveTransferred | 🔢 TokenID: ${tokenId} | 💰 Amount: ${amount} (raw)`;
    }
  } else if (event.type === 'ReserveUpdated') {
    const { tokenId, newBalance } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const balanceDisplay = (Number(newBalance) / (10 ** decimals)).toFixed(4);
    
    elaborateMessage = `📊 ${from} observed RESERVE UPDATE: ${tokenSymbol} balance now ${balanceDisplay} (accepted: event.block=${blockNumber} > entity.jBlock=${currentJBlock})
📍 Block: ${blockNumber} | ⏰ ${timestamp} | 🔗 Tx: ${txHashShort}
🎯 Event: ReserveUpdated | 🔢 TokenID: ${tokenId} | 💰 New Balance: ${newBalance} (raw)
🏦 Decimals: ${decimals} | 🔤 Symbol: ${tokenSymbol}`;
  } else if (event.type === 'SettlementProcessed') {
    const { counterpartyEntityId, tokenId, ownReserve, counterpartyReserve, collateral, ondelta, side } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const ownBalanceDisplay = (Number(ownReserve) / (10 ** decimals)).toFixed(4);
    const counterpartyBalanceDisplay = (Number(counterpartyReserve) / (10 ** decimals)).toFixed(4);
    const collateralDisplay = (Number(collateral) / (10 ** decimals)).toFixed(4);

    elaborateMessage = `⚖️ ${from} observed SETTLEMENT: ${tokenSymbol} settled with Entity ${(counterpartyEntityId as string).slice(-4)}
📍 Block: ${blockNumber} | ⏰ ${timestamp} | 🔗 Tx: ${txHashShort}
🎯 Event: SettlementProcessed | 🔢 TokenID: ${tokenId} | 👤 Side: ${side}
💰 Own Reserve: ${ownBalanceDisplay} | 🤝 Counterparty: ${counterpartyBalanceDisplay}
🔒 Collateral: ${collateralDisplay} | 📊 OnDelta: ${ondelta}`;
  } else {
    elaborateMessage = `🔍 ${from} observed J-EVENT: ${event.type}
📍 Block: ${blockNumber} | ⏰ ${timestamp} | 🔗 Tx: ${txHashShort}
📋 Data: ${safeStringify(event.data, 2)}`;
  }
  
  newEntityState.messages.push(elaborateMessage);

  if (event.type === 'ReserveUpdated') {
    const { entity, tokenId, newBalance } = event.data;

    if (entity === entityState.entityId) {
      newEntityState.reserves.set(String(tokenId), BigInt(newBalance as string | number | bigint));
      if (DEBUG) console.log(`✅ Reserve updated for ${(entity as string).slice(0,10)}...: Token ${tokenId} new balance is ${newBalance}`);
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
      const newAmount = actualReserve - BigInt(amount as string | number | bigint);
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
      newEntityState.reserves.set(String(tokenId), actualReserve + BigInt(amount as string | number | bigint));
      // Message already added above
    }
    
    if (DEBUG) console.log(`✅ Reserve transfer processed: ${direction} ${amount} token ${tokenId}`);
  } else if (event.type === 'SettlementProcessed') {
    const { counterpartyEntityId, tokenId, ownReserve, counterpartyReserve, collateral, ondelta, side } = event.data;

    // Update own reserves based on the settlement
    newEntityState.reserves.set(String(tokenId), BigInt(ownReserve as string | number | bigint));

    // Create accountInput to feed into a-machine for bilateral consensus
    // This enables the settlement event to be processed by the account machine
    const accountInput = {
      fromEntityId: entityState.entityId,
      toEntityId: counterpartyEntityId as string,
      accountTx: {
        type: 'account_settle' as const,
        data: {
          tokenId: Number(tokenId),
          ownReserve: ownReserve as unknown,
          counterpartyReserve: counterpartyReserve as unknown,
          collateral: collateral as unknown,
          ondelta: ondelta as unknown,
          side: side as unknown,
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
    newEntityState.accountInputQueue.push(accountInput as any);

    if (DEBUG) console.log(`✅ SettlementProcessed: Created accountInput for token ${tokenId} with counterparty ${(counterpartyEntityId as string).slice(0,10)}...`);
  } else if (event.type === 'TransferReserveToCollateral') {
    const { receivingEntity, counterentity, collateral, ondelta, tokenId, side } = event.data;

    // Determine counterparty from our perspective
    const counterpartyEntityId = (side === 'receiving' ? counterentity : receivingEntity) as string;

    // Note: Reserve updates happen via separate ReserveUpdated event, so we don't update reserves here

    // Create accountInput to update bilateral account state
    const accountInput = {
      fromEntityId: entityState.entityId,
      toEntityId: counterpartyEntityId,
      accountTx: {
        type: 'reserve_to_collateral' as const,
        data: {
          tokenId: Number(tokenId),
          collateral: collateral as unknown, // Absolute collateral value from contract
          ondelta: ondelta as unknown,       // Absolute ondelta value from contract
          side: side as unknown,             // 'receiving' or 'counterparty'
          blockNumber: blockNumber,
          transactionHash: transactionHash
        }
      },
      metadata: {
        purpose: 'r2c_consensus',
        description: `R→C event from j-machine for token ${tokenId}`
      }
    };

    // Add to entity's account inputs queue
    if (!newEntityState.accountInputQueue) {
      newEntityState.accountInputQueue = [];
    }
    newEntityState.accountInputQueue.push(accountInput as any);

    if (DEBUG) console.log(`✅ TransferReserveToCollateral: Created accountInput for token ${tokenId} with counterparty ${counterpartyEntityId.slice(0,10)}...`);
  } else {
    newEntityState.messages.push(`⚠️ Unhandled j-event type: ${event.type}`);
  }

  return newEntityState;
};
