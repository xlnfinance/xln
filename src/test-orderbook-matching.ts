#!/usr/bin/env bun
/**
 * Test Orderbook MATCHING - Buy meets Sell within same entity
 * The Original knows: matching happens WITHIN entity sovereignty
 */

process.env.NO_DEMO = '1';
process.env.NO_BLOCKCHAIN = '1';

import { applyEntityTx } from './entity-tx/apply';
import { cloneEntityState } from './state-helpers';
import type { EntityState, Env } from './types';

async function testOrderbookMatching() {
  console.log('🎯 Testing XLN Orderbook MATCHING (within entity)\n');

  // Single entity with its sovereign orderbook
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

  // First, place a BUY order at $100
  console.log('📊 Placing BUY order at $100 for 10 units...');
  const buyTx = {
    type: 'place_order' as const,
    data: {
      side: 'buy' as const,
      price: 100.00,
      amount: 10,
    }
  };

  const { newState: stateAfterBuy } = await applyEntityTx(env, entityState, buyTx);
  console.log('Messages after buy:', stateAfterBuy.messages);

  // Now place a SELL order at $100 - should match!
  console.log('\n📊 Placing SELL order at $100 for 5 units (should match!)...');
  const sellTx = {
    type: 'place_order' as const,
    data: {
      side: 'sell' as const,
      price: 100.00,
      amount: 5,
    }
  };

  const { newState: stateAfterSell } = await applyEntityTx(env, stateAfterBuy, sellTx);
  console.log('Messages after sell:', stateAfterSell.messages);

  // Check for trades
  const tradeMessages = stateAfterSell.messages.filter(m => m.includes('Trade'));
  if (tradeMessages.length > 0) {
    console.log('\n💰 TRADES DETECTED:');
    tradeMessages.forEach(t => console.log(`  ${t}`));
    console.log('\n✅ SUCCESS: Orderbook matching works within entity!');
  } else {
    console.log('\n⚠️ No trades detected - checking order acceptance...');
    const acceptedOrders = stateAfterSell.messages.filter(m => m.includes('accepted'));
    console.log('Accepted orders:', acceptedOrders);
  }

  // Test crossing orders
  console.log('\n📊 Testing crossing orders (sell below buy)...');
  const crossBuyTx = {
    type: 'place_order' as const,
    data: {
      side: 'buy' as const,
      price: 110.00,  // Buy at $110
      amount: 3,
    }
  };

  const { newState: stateWithHighBuy } = await applyEntityTx(env, stateAfterSell, crossBuyTx);

  // This sell should immediately match with the $110 buy
  const crossSellTx = {
    type: 'place_order' as const,
    data: {
      side: 'sell' as const,
      price: 105.00,  // Sell at $105 (below buy at $110)
      amount: 3,
    }
  };

  const { newState: finalState } = await applyEntityTx(env, stateWithHighBuy, crossSellTx);
  console.log('Final messages:', finalState.messages.slice(-5)); // Last 5 messages

  // Summary
  const allTrades = finalState.messages.filter(m => m.includes('Trade'));
  console.log(`\n🎯 SUMMARY: ${allTrades.length} trades executed`);

  if (allTrades.length > 0) {
    console.log('✅ Orderbook matching ACTIVATED and WORKING!');
    console.log('\n💡 Next: Cross-entity trading via bilateral channels');
  }
}

testOrderbookMatching().catch(console.error);