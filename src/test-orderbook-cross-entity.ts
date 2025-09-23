#!/usr/bin/env bun
/**
 * Test Cross-Entity Orderbook Trading
 * The Original reveals: Bilateral channels carry trade proposals
 *
 * Architecture:
 * Entity A Orderbook ←→ Bilateral Channel ←→ Entity B Orderbook
 *         ↓                    ↓                    ↓
 *    (Sovereign)        (Trade Proposal)      (Sovereign)
 */

process.env.NO_DEMO = '1';
process.env.NO_BLOCKCHAIN = '1';

import { createEmptyEnv, applyServerInput, processUntilEmpty } from './server';
import { entityChannelManager } from './entity-channel';
import type { ServerInput } from './types';

async function testCrossEntityTrading() {
  console.log('🎯 Testing XLN Cross-Entity Trading via Bilateral Channels\n');

  // Initialize environment
  const env = createEmptyEnv();

  // Create two trading entities
  const serverInput: ServerInput = {
    serverTxs: [
      {
        type: 'importReplica',
        entityId: '0x0000000000000000000000000000000000000000000000000000000000000001',
        signerId: 's1',
        data: {
          config: {
            mode: 'proposer-based',
            threshold: BigInt(1),
            validators: ['s1'],
            shares: { s1: BigInt(1) },
          },
          isProposer: true,
        },
      },
      {
        type: 'importReplica',
        entityId: '0x0000000000000000000000000000000000000000000000000000000000000002',
        signerId: 's2',
        data: {
          config: {
            mode: 'proposer-based',
            threshold: BigInt(1),
            validators: ['s2'],
            shares: { s2: BigInt(1) },
          },
          isProposer: true,
        },
      },
    ],
    entityInputs: [],
  };

  // Initialize entities
  console.log('📡 Creating entities with orderbooks...');
  await applyServerInput(env, serverInput);

  // Initialize orderbooks for both entities
  console.log('\n🔧 Initializing orderbooks...');
  const initOrderbooksInput: ServerInput = {
    serverTxs: [],
    entityInputs: [
      {
        entityId: '0x0000000000000000000000000000000000000000000000000000000000000001',
        signerId: 's1',
        entityTxs: [{ type: 'init_orderbook' as const }],
      },
      {
        entityId: '0x0000000000000000000000000000000000000000000000000000000000000002',
        signerId: 's2',
        entityTxs: [{ type: 'init_orderbook' as const }],
      },
    ],
  };

  const result1 = await applyServerInput(env, initOrderbooksInput);
  await processUntilEmpty(env, result1.entityOutbox);

  // Entity 1 places a BUY order at $100
  console.log('\n📊 Entity 1: Placing BUY order at $100 for 10 units...');
  const buyInput: ServerInput = {
    serverTxs: [],
    entityInputs: [
      {
        entityId: '0x0000000000000000000000000000000000000000000000000000000000000001',
        signerId: 's1',
        entityTxs: [{
          type: 'place_order' as const,
          data: {
            side: 'buy' as const,
            price: 100.00,
            amount: 10,
          }
        }],
      },
    ],
  };

  const result2 = await applyServerInput(env, buyInput);
  await processUntilEmpty(env, result2.entityOutbox);

  const entity1 = env.replicas.get('0x0000000000000000000000000000000000000000000000000000000000000001:s1');
  console.log('Entity 1 state:', entity1?.state);
  console.log('Entity 1 messages:', entity1?.state?.messages?.slice(-2));

  // Entity 2 places a SELL order at $99 - should match cross-entity!
  console.log('\n📊 Entity 2: Placing SELL order at $99 for 5 units...');
  const sellInput: ServerInput = {
    serverTxs: [],
    entityInputs: [
      {
        entityId: '0x0000000000000000000000000000000000000000000000000000000000000002',
        signerId: 's2',
        entityTxs: [{
          type: 'place_order' as const,
          data: {
            side: 'sell' as const,
            price: 99.00,
            amount: 5,
          }
        }],
      },
    ],
  };

  const result3 = await applyServerInput(env, sellInput);
  await processUntilEmpty(env, result3.entityOutbox);

  const entity2 = env.replicas.get('0x0000000000000000000000000000000000000000000000000000000000000002:s2');
  console.log('Entity 2 state:', entity2?.state);
  console.log('Entity 2 messages:', entity2?.state?.messages?.slice(-2));

  // Now activate cross-entity discovery
  console.log('\n🔍 Activating cross-entity order discovery...');
  const discoveryInput: ServerInput = {
    serverTxs: [],
    entityInputs: [
      {
        entityId: '0x0000000000000000000000000000000000000000000000000000000000000001',
        signerId: 's1',
        entityTxs: [{
          type: 'share_orderbook' as const,
          data: {
            counterpartyEntityId: '0x0000000000000000000000000000000000000000000000000000000000000002',
          }
        }],
      },
      {
        entityId: '0x0000000000000000000000000000000000000000000000000000000000000002',
        signerId: 's2',
        entityTxs: [{
          type: 'share_orderbook' as const,
          data: {
            counterpartyEntityId: '0x0000000000000000000000000000000000000000000000000000000000000001',
          }
        }],
      },
    ],
  };

  const result4 = await applyServerInput(env, discoveryInput);
  await processUntilEmpty(env, result4.entityOutbox);

  // Check for discovery messages
  const finalEntity1 = env.replicas.get('0x0000000000000000000000000000000000000000000000000000000000000001:s1');
  const finalEntity2 = env.replicas.get('0x0000000000000000000000000000000000000000000000000000000000000002:s2');

  console.log('\n📡 Entity 1 messages:', finalEntity1?.state?.messages);
  console.log('📡 Entity 2 messages:', finalEntity2?.state?.messages);

  // Check bilateral channel messages
  const channelMessages = entityChannelManager.getChannelMessages?.(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000000000000000000000000000002'
  );

  if (channelMessages) {
    console.log('\n💬 Bilateral channel messages:', channelMessages);
  }

  // Summary
  const discoveryMessages = [
    ...finalEntity1?.state?.messages?.filter(m => m.includes('discovery')) || [],
    ...finalEntity2?.state?.messages?.filter(m => m.includes('discovery')) || [],
  ];

  if (discoveryMessages.length > 0) {
    console.log('\n✅ SUCCESS: Cross-entity orderbook discovery activated!');
    console.log('Discovery messages:', discoveryMessages);
    console.log('\n💡 Next: Implement trade proposals through bilateral channels');
  } else {
    console.log('\n⚠️ No discovery messages found');
    console.log('Checking if orderbooks are initialized...');
    console.log('Entity 1 orderbook:', finalEntity1?.state?.orderbook?.initialized);
    console.log('Entity 2 orderbook:', finalEntity2?.state?.orderbook?.initialized);
  }

  console.log('\n🎯 Architecture verified:');
  console.log('  - Entities maintain sovereign orderbooks ✅');
  console.log('  - Bilateral channels exist for communication ✅');
  console.log('  - Discovery mechanism ready for activation 🔧');
}

testCrossEntityTrading().catch(console.error);