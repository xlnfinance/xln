#!/usr/bin/env bun
/**
 * ACTIVATE J-MACHINE TRADE REPORTING
 *
 * J-Machine has ZERO dependents.
 * It watches blockchain, creates EntityInputs.
 * But nothing connects it to trading.
 * This script activates that connection.
 */

import { jMachine, JMachineEvent } from './j-machine';
import type { EntityInput, Env } from './types';
import { log } from './utils';

interface TradeReport {
  entityA: string;
  entityB: string;
  symbol: string;
  price: number;
  quantity: number;
  timestamp: number;
  txHash?: string;
}

/**
 * Report a completed trade to J-Machine
 * This would normally write to blockchain
 */
export function reportTradeToJurisdiction(
  env: Env,
  trade: TradeReport
): void {
  // In production, this would submit to blockchain
  // For now, we create a mock J-event
  const jEvent: JMachineEvent = {
    type: 'entity_registered', // Reusing existing type for now
    blockNumber: Date.now(),  // Mock block number
    data: {
      eventType: 'TRADE_EXECUTED',
      entityA: trade.entityA,
      entityB: trade.entityB,
      symbol: trade.symbol,
      price: trade.price,
      quantity: trade.quantity,
      timestamp: trade.timestamp,
    },
  };

  log.info(`⛓️ J-MACHINE: Trade reported to jurisdiction`);
  log.info(`   ${trade.entityA.slice(0,8)}... ⟷ ${trade.entityB.slice(0,8)}...`);
  log.info(`   ${trade.quantity} ${trade.symbol} @ $${(trade.price/100).toFixed(2)}`);

  // Process the event through J-Machine
  const entityInputs = jMachine.createEntityInputsFromEvents([jEvent]);

  // Add to environment for processing
  if (entityInputs.length > 0) {
    env.serverInput.entityInputs.push(...entityInputs);
    log.trace(`📨 J-Machine created ${entityInputs.length} entity inputs from trade`);
  }
}

/**
 * Connect J-Machine to entity state updates
 */
export function connectJMachineToEntities(env: Env): void {
  // Subscribe to J-Machine events
  jMachine.onEvent((event: JMachineEvent) => {
    log.trace(`🔔 J-EVENT: ${event.type} at block ${event.blockNumber}`);

    // Create entity inputs from the event
    const inputs = jMachine.createEntityInputsFromEvents([event]);

    // Route to entities
    for (const input of inputs) {
      env.serverInput.entityInputs.push(input);
      log.trace(`→ Routed to entity ${input.entityId.slice(0,8)}...`);
    }
  });
}

/**
 * Activate J-Machine trade reporting
 */
export async function activateJMachineTrading(env: Env): Promise<void> {
  log.info('⛓️ ACTIVATING J-MACHINE TRADE REPORTING');
  log.info('   J-Machine watches blockchain events');
  log.info('   Converts them to entity inputs');
  log.info('   Routes to relevant entities');

  // Initialize J-Machine with environment
  await jMachine.initialize(env);

  // Connect to entity routing
  connectJMachineToEntities(env);

  // Start periodic sync (optional)
  jMachine.startPeriodicSync(5000);

  // Get current state
  const state = jMachine.getState();

  log.info(`✅ J-Machine activated`);
  log.info(`   Block Height: ${state.blockHeight}`);
  log.info(`   Reserves Tracked: ${state.reserves.size}`);
  log.info(`   Collateral Locked: ${state.collateral.size}`);
  log.info(`   Disputes: ${state.disputes.size}`);
}

/**
 * Monitor J-Machine state
 */
export function getJMachineStatus(): any {
  const state = jMachine.getState();

  return {
    blockHeight: state.blockHeight,
    lastSync: new Date(state.lastSyncTimestamp).toISOString(),
    reserves: Array.from(state.reserves.entries()).map(([entity, amount]) => ({
      entity: entity.slice(0,8) + '...',
      amount: amount.toString(),
    })),
    collateral: Array.from(state.collateral.entries()).map(([channel, amount]) => ({
      channel: channel.slice(0,8) + '...',
      amount: amount.toString(),
    })),
    disputes: state.disputes.size,
  };
}

// If run directly, show usage
if (import.meta.main) {
  console.log('⛓️ J-Machine Trade Reporting Activation');
  console.log('');
  console.log('Usage:');
  console.log('  import { activateJMachineTrading } from "./activate-j-machine-trades";');
  console.log('  await activateJMachineTrading(env);');
  console.log('');
  console.log('This will:');
  console.log('  1. Initialize J-Machine blockchain watcher');
  console.log('  2. Connect J-events to entity inputs');
  console.log('  3. Report trades to jurisdiction');
  console.log('  4. Track reserves and collateral on-chain');
  console.log('');
  console.log('The J-Machine bridges on-chain and off-chain:');
  console.log('  - Reads blockchain events');
  console.log('  - Updates entity reserves');
  console.log('  - Tracks dispute states');
  console.log('  - Reports trade completions');
}