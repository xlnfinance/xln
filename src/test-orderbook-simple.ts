#!/usr/bin/env bun
/**
 * Simple Orderbook Test - Minimal setup to test orderbook initialization
 */

// Disable demo completely
process.env.NO_DEMO = '1';
process.env.NO_BLOCKCHAIN = '1';

import { applyEntityTx } from './entity-tx/apply';
import { cloneEntityState } from './state-helpers';
import type { EntityState, Env } from './types';

async function testOrderbookDirectly() {
  console.log('🎯 Testing XLN Orderbook DIRECTLY (no consensus)\n');

  // Create minimal entity state
  const entityState: EntityState = {
    entityId: '0x0000000000000000000000000000000000000000000000000000000000000001',
    height: 0,
    timestamp: Date.now(),
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: BigInt(1),
      validators: ['s1'],
      shares: { s1: BigInt(1) },
    },
    reserves: new Map(),
    accounts: new Map(),
    jBlock: 0,
  };

  // Create minimal env
  const env: Env = {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] },
    history: [],
    gossip: {
      announce: () => {},
      getRecentMessages: () => [],
    },
  };

  console.log('📊 Placing a BUY order directly through applyEntityTx...');

  const placeTx = {
    type: 'place_order' as const,
    data: {
      side: 'buy' as const,
      price: 1.00,  // $1.00
      amount: 10,   // 10 lots
    }
  };

  console.log('🔍 DEBUG: Before place_order - orderbook exists:', !!entityState.orderbook);

  // Apply the transaction directly
  const { newState } = await applyEntityTx(env, entityState, placeTx);

  console.log('🔍 DEBUG: After place_order - orderbook exists:', !!newState.orderbook);
  console.log('🔍 DEBUG: Orderbook initialized:', newState.orderbook?.initialized);
  console.log('🔍 DEBUG: Messages:', newState.messages);

  if (newState.orderbook?.initialized) {
    console.log('✅ SUCCESS: Orderbook initialized!');

    // Now try a sell order
    console.log('\n📊 Placing a SELL order...');
    const sellTx = {
      type: 'place_order' as const,
      data: {
        side: 'sell' as const,
        price: 1.00,  // $1.00
        amount: 5,    // 5 lots
      }
    };

    const { newState: finalState } = await applyEntityTx(env, newState, sellTx);
    console.log('🔍 DEBUG: Messages after sell:', finalState.messages);

    // Check for trades
    const tradeMessages = finalState.messages.filter(m => m.includes('Trade'));
    if (tradeMessages.length > 0) {
      console.log('💰 TRADES DETECTED:', tradeMessages);
    }
  } else {
    console.log('❌ FAILED: Orderbook not initialized');
    console.log('🔍 DEBUG: Full state keys:', Object.keys(newState));
  }

  console.log('\n🎯 Direct orderbook test completed!');
}

// Run test
testOrderbookDirectly().catch(console.error);