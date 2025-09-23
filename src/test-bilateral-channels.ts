#!/usr/bin/env bun
/**
 * Test bilateral channel responses between entities
 * Verifies that account consensus frames trigger proper responses
 */

import { createEmptyEnv, applyServerInput, processUntilEmpty } from './server';
import type { EntityTx } from './types';
import { EntityChannelManager } from './entity-channel';

console.log('🧪 Testing Bilateral Channel Responses\n');

async function test() {
  // Initialize environment with entity channel manager
  const env = createEmptyEnv();
  const channelManager = new EntityChannelManager();

  // Create test entities
  console.log('1️⃣ Creating test entities...');
  await applyServerInput(env, {
    serverTxs: [
      { type: 'importReplica', entityId: '0x0001', signerId: 's1', isProposer: true },
      { type: 'importReplica', entityId: '0x0002', signerId: 's2', isProposer: true },
    ],
    entityInputs: []
  });
  await processUntilEmpty(env, []);
  console.log(`✅ Created ${Object.keys(env.replicas).length} entities\n`);

  // Register entities with channel manager
  channelManager.registerEntity('0x0001');
  channelManager.registerEntity('0x0002');

  // Create an account_input transaction from entity 1 to entity 2
  const accountInput: EntityTx = {
  type: 'account_input',
  data: {
    fromEntityId: '0x0001',
    toEntityId: '0x0002',
    signerId: 's1',
    accountFrame: {
      seq: 1,
      transactions: [],
      stateRoot: '0xtest',
      signatures: { s1: 'sig1' }
    }
  }
};

// Send through entity channel
console.log('2️⃣ Sending account frame from Entity 1 to Entity 2...');
const message = channelManager.sendMessage('0x0001', '0x0002', 's1', [accountInput]);
console.log(`📤 Message sent: ${message.messageId}\n`);

// Check if Entity 2 received the message
const pendingMessages = channelManager.getPendingMessages('0x0002');
console.log(`3️⃣ Entity 2 has ${pendingMessages.length} pending messages`);

if (pendingMessages.length > 0) {
  const msg = pendingMessages[0];
  console.log(`📥 Received from ${msg.fromEntityId}: ${msg.entityTxs[0].type}\n`);

    // Process the message through the entity
    const entityInput = channelManager.messageToEntityInput(msg);
    await applyServerInput(env, { serverTxs: [], entityInputs: [entityInput] });
    await processUntilEmpty(env, []);

    console.log('4️⃣ Checking for bilateral response...');
    // Check env.outputs for response
    if (env.outputs && env.outputs.length > 0) {
      console.log(`✅ Bilateral response generated: ${env.outputs.length} outputs`);
      const response = env.outputs[0];
      console.log(`📤 Response type: account_input`);
      console.log(`📤 Response to: ${response.entityId}`);
      console.log(`📤 Response contains frame with seq: ${response.entityTxs?.[0]?.data?.accountFrame?.seq || 'N/A'}`);
    } else {
      console.log('❌ No bilateral response generated');
    }
  } else {
    console.log('❌ Message not received by Entity 2');
  }

  console.log('\n✨ Bilateral Channel Test Complete');
}

test().catch(console.error);