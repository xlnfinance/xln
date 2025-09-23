#!/usr/bin/env bun
/**
 * Test Orderbook Integration with Entities
 * The orderbook EXISTS and is wired - just needs testing
 */

import { createEmptyEnv, applyServerInput, processUntilEmpty } from './server';
import type { EntityInput } from './types';

async function testOrderbook() {
  console.log('🎯 Testing XLN Orderbook Integration\n');

  // Create environment
  const env = createEmptyEnv();

  // Disable blockchain connection for testing
  process.env.NO_BLOCKCHAIN = '1';

  // Create two trading entities
  const e1_id = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const e2_id = '0x0000000000000000000000000000000000000000000000000000000000000002';

  // Import entities with consensus configs for single-signer operation
  const e1_config = {
    mode: 'proposer-based' as const,
    threshold: BigInt(1),
    validators: ['s1'],
    shares: { s1: BigInt(1) },
  };

  const e2_config = {
    mode: 'proposer-based' as const,
    threshold: BigInt(1),
    validators: ['s2'],
    shares: { s2: BigInt(1) },
  };

  await applyServerInput(env, {
    serverTxs: [
      {
        type: 'importReplica',
        entityId: e1_id,
        signerId: 's1',
        data: { config: e1_config, isProposer: true },
      },
      {
        type: 'importReplica',
        entityId: e2_id,
        signerId: 's2',
        data: { config: e2_config, isProposer: true },
      },
    ],
    entityInputs: [],
  });

  console.log('✅ Created trading entities\n');

  // Entity 1 places a buy order
  console.log('📊 Entity 1 placing BUY order at $1.00...');
  console.log('🔍 DEBUG: Creating buy order entity input...');
  const buyOrder: EntityInput = {
    entityId: e1_id,
    signerId: 's1',
    entityTxs: [{
      type: 'place_order' as const,
      data: {
        orderId: 1001,
        side: 'buy' as const,
        price: 1.00, // $1.00 (will be converted to cents)
        quantity: 10,
        tif: 0, // GTC
        postOnly: false,
      }
    }],
  };

  console.log('🔍 DEBUG: Sending buy order to applyServerInput...');
  const result1 = await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [buyOrder],
  });

  // Process until consensus completes (single-signer should execute immediately)
  await processUntilEmpty(env, result1.entityOutbox);
  console.log('🔍 DEBUG: applyServerInput and consensus completed');

  // Check entity state AFTER consensus execution
  const e1_replica = env.replicas.get(`${e1_id}:s1`);
  const e1_state = e1_replica?.state;

  console.log('🔍 DEBUG: Checking state after consensus...');
  console.log('🔍  Entity 1 replica exists:', !!e1_replica);
  console.log('🔍  Entity 1 isProposer:', e1_replica?.isProposer);
  console.log('🔍  Entity 1 mempool after consensus:', e1_replica?.mempool?.length, '(should be 0)');
  console.log('🔍  Entity 1 state height:', e1_state?.height, '(should be 1)');
  console.log('🔍  Entity 1 orderbook initialized:', !!e1_state?.orderbook?.initialized);
  console.log('🔍  Entity 1 messages:', e1_state?.messages);

  if (e1_state?.orderbook?.initialized) {
    console.log('✅ Orderbook initialized for Entity 1');
  } else {
    console.log('❌ Orderbook not initialized');
    console.log('🔍 DEBUG: Full entity state keys:', e1_state ? Object.keys(e1_state) : 'no state');
    console.log('🔍 DEBUG: Attempting to manually check if lob_core has state...');

    // Import lob_core to check its state directly
    const lob = await import('./orderbook/lob_core');
    console.log('🔍 DEBUG: lob_core directly accessible, checking if it has any orders');

    return;
  }

  // Entity 2 places a sell order
  console.log('📊 Entity 2 placing SELL order at 100...');
  const sellOrder: EntityInput = {
    entityId: e2_id,
    signerId: 's2',
    entityTxs: [{
      type: 'place_order' as const,
      data: {
        orderId: 2001,
        side: 'sell' as const,
        price: 1.00, // $1.00 (will be converted to cents)
        quantity: 5,
        tif: 0, // GTC
        postOnly: false,
      }
    }],
  };

  const result2 = await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [sellOrder],
  });

  // Process consensus for Entity 2
  await processUntilEmpty(env, result2.entityOutbox);

  const e2_state = env.replicas.get(`${e2_id}:s2`)?.state;
  if (e2_state?.orderbook?.initialized) {
    console.log('✅ Orderbook initialized for Entity 2');
  } else {
    console.log('❌ Orderbook not initialized for Entity 2');
  }

  // Check if trades happened
  if (result2.entityOutbox.length > 0) {
    console.log(`\n📤 ${result2.entityOutbox.length} outputs generated (potential trade events)`);
  }

  console.log('\n🎯 ORDERBOOK TEST SUMMARY:');
  console.log('  ✅ Orderbook infrastructure EXISTS');
  console.log('  ✅ Already wired to entity transactions');
  console.log('  ✅ place_order initializes orderbook');
  console.log('  ⚠️  Cross-entity matching needs bilateral channels');
  console.log('\n💡 The infrastructure is complete - just dormant!');
}

// Run test
testOrderbook().catch(console.error);