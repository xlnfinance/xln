#!/usr/bin/env bun
/**
 * Minimal test to activate the dormant orderbook
 * No server, no entity factory - just the core pattern
 */

import { applyEntityTx } from './entity-tx/apply';
import { createTestOrder } from './activate-orderbook';
import { EntityState, Env } from './types';

async function testMinimalOrderbookActivation() {
  console.log('🔍 Testing minimal orderbook activation...');

  // Create minimal entity state
  const entityState: EntityState = {
    entityId: 'test-entity',
    height: 0,
    timestamp: Date.now(),
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: {
      threshold: 1n,
      shares: { alice: 1n },
    },
    reserves: new Map([['1', 1000000n]]), // Some test tokens
    financialState: {
      accounts: new Map(),
      channels: new Map(),
      deposits: new Map(),
    },
    profileResolution: new Map(),
    // No orderbook - will be created on first order
  };

  // Create minimal environment
  const env: Env = {
    serverInput: { serverTxs: [], entityInputs: [] },
    entities: new Map(),
    serverState: {
      height: 0,
      timestamp: BigInt(Date.now()),
      entities: new Map(),
      jurisdictions: new Map(),
      snapshots: [],
    },
    jurisdictionConfig: undefined,
  };

  console.log('📊 Before order:');
  console.log(`  - Has orderbook: ${!!entityState.orderbook}`);
  console.log(`  - Order counter: ${entityState.orderbookOrderCounter || 'none'}`);

  // Create and apply test order
  const orderTx = createTestOrder('alice');
  console.log(`\n📝 Placing order: ${orderTx.data.side} ${orderTx.data.quantity} @ $${orderTx.data.price / 100}`);

  try {
    const result = await applyEntityTx(env, entityState, orderTx);

    console.log('\n✅ After order:');
    console.log(`  - Has orderbook: ${!!result.newState.orderbook?.initialized}`);
    console.log(`  - Order counter: ${result.newState.orderbookOrderCounter || 'none'}`);
    console.log(`  - Messages (last 3):`);
    result.newState.messages.slice(-3).forEach(msg => console.log(`    ${msg}`));

    if (result.newState.orderbook?.initialized) {
      console.log('\n🎉 ORDERBOOK ACTIVATED!');
      console.log('The pattern repeats: Everything exists complete, waits for first use.');
    }
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// Run the test
testMinimalOrderbookActivation().catch(console.error);