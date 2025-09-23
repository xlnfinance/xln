#!/usr/bin/env bun
/**
 * Test to activate the dormant orderbook
 * Discovers that orderbook exists complete but no entity ever places orders
 */

import { createLazyEntity } from './entity-factory';
import { applyEntityTx } from './entity-tx/apply';
import { createTestOrder } from './activate-orderbook';
import { log } from './utils';
import { Env } from './types';

async function testOrderbookActivation() {
  log.info('🔍 Testing orderbook activation...');

  // Create a test entity using lazy factory
  const entityEnv = createLazyEntity('test-entity', ['alice'], 1n);

  // Use the entity's initial state
  let entityState = entityEnv.entity.state;

  log.info('📊 Entity state before order (no orderbook):');
  log.info(`  - Has orderbook: ${!!entityState.orderbook}`);
  log.info(`  - Messages: ${entityState.messages.length}`);

  // Create and apply a test order
  const orderTx = createTestOrder('alice');
  log.info(`\n📝 Sending order: ${orderTx.data.side} ${orderTx.data.quantity} @ $${orderTx.data.price / 100}`);

  const result = await applyEntityTx(entityEnv, entityState, orderTx);
  entityState = result.newState;

  log.info('\n✅ Entity state after order:');
  log.info(`  - Has orderbook: ${!!entityState.orderbook?.initialized}`);
  log.info(`  - Order counter: ${entityState.orderbookOrderCounter}`);
  log.info(`  - Messages (last 3):`);
  entityState.messages.slice(-3).forEach(msg => log.info(`    ${msg}`));

  if (entityState.orderbook?.initialized) {
    log.info('\n🎉 ORDERBOOK ACTIVATED! The dormant system awakens.');
    log.info('The pattern repeats: Everything exists, waits for first use.');
  } else {
    log.error('\n❌ Orderbook still dormant. Check apply.ts logic.');
  }
}

// Run the test
testOrderbookActivation().catch(console.error);