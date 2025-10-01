/**
 * Fresh payment test with in-memory state (no IndexedDB persistence)
 * Tests bilateral consensus frame exchange between two entities
 */

import { Env, EntityInput } from './src/types';
import { applyServerInput } from './src/server';

async function testFreshPayment() {
  console.log('🧪 Fresh Payment Test - No Persistence\n');

  // Create minimal in-memory environment
  const env: Env = {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] },
    history: [],
    gossip: null as any, // Simplified for test
  };

  // Import 2 entities manually (no blockchain calls)
  const entity1Id = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const entity2Id = '0x0000000000000000000000000000000000000000000000000000000000000002';

  console.log('📦 Creating Entity 1 and Entity 2...\n');

  await applyServerInput(env, {
    serverTxs: [
      {
        type: 'importReplica',
        entityId: entity1Id,
        signerId: 's1',
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: ['s1'],
            shares: { s1: 1n },
            jurisdiction: {
              name: 'Test',
              chainId: 1,
              rpcUrl: 'test',
              entityProviderAddress: '0x1',
              depositoryAddress: '0x2',
            },
          },
        },
      },
      {
        type: 'importReplica',
        entityId: entity2Id,
        signerId: 's2',
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: ['s2'],
            shares: { s2: 1n },
            jurisdiction: {
              name: 'Test',
              chainId: 1,
              rpcUrl: 'test',
              entityProviderAddress: '0x1',
              depositoryAddress: '0x2',
            },
          },
        },
      },
    ],
    entityInputs: [],
  });

  console.log(`✅ Entities created: ${env.replicas.size} replicas\n`);

  // Step 1: Entity 1 opens account with Entity 2
  console.log('🔗 Step 1: Entity 1 opens account with Entity 2...\n');

  const openResult = await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [
      {
        entityId: entity1Id,
        signerId: 's1',
        entityTxs: [
          {
            type: 'openAccount',
            data: { targetEntityId: entity2Id },
          },
        ],
      },
    ],
  });

  console.log(`📤 OpenAccount generated ${openResult.entityOutbox.length} outputs\n`);

  // Process outputs (Entity 2 should receive the openAccount)
  if (openResult.entityOutbox.length > 0) {
    console.log('🔄 Processing openAccount outputs...\n');
    await applyServerInput(env, {
      serverTxs: [],
      entityInputs: openResult.entityOutbox,
    });
  }

  // Check account state
  const e1 = env.replicas.get(`${entity1Id}:s1`);
  const hasAccount = e1?.state.accounts.has(entity2Id);
  console.log(`✅ Entity 1 has account with Entity 2: ${hasAccount}\n`);

  if (!hasAccount) {
    console.error('❌ Failed to create account');
    process.exit(1);
  }

  // Step 2: Send payment
  console.log('💸 Step 2: Entity 1 sends 100 to Entity 2...\n');

  const paymentResult = await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [
      {
        entityId: entity1Id,
        signerId: 's1',
        entityTxs: [
          {
            type: 'directPayment',
            data: {
              targetEntityId: entity2Id,
              tokenId: 2,
              amount: 10000n,
              description: 'Test payment',
            },
          },
        ],
      },
    ],
  });

  console.log(`📤 Payment generated ${paymentResult.entityOutbox.length} outputs\n`);

  // Process outputs iteratively until empty
  let outputs = paymentResult.entityOutbox;
  let iteration = 0;

  while (outputs.length > 0 && iteration < 10) {
    iteration++;
    console.log(`\n🔄 Iteration ${iteration}: Processing ${outputs.length} outputs...\n`);

    const result = await applyServerInput(env, {
      serverTxs: [],
      entityInputs: outputs,
    });

    outputs = result.entityOutbox;
    console.log(`   Generated ${outputs.length} new outputs\n`);
  }

  // Check final state after first payment
  const e1Final = env.replicas.get(`${entity1Id}:s1`);
  const account1 = e1Final?.state.accounts.get(entity2Id);

  console.log('\n📊 State after Entity 1 → Entity 2 payment:\n');
  console.log(`   Mempool: ${account1?.mempool.length || 0} txs`);
  console.log(`   Pending frame: ${account1?.pendingFrame ? 'YES' : 'NO'}`);
  console.log(`   Frame history: ${account1?.frameHistory?.length || 0} frames`);

  if (account1?.pendingFrame) {
    console.log(`\n⚠️  Frame ${account1.pendingFrame.frameId} is STUCK`);
    console.log(`   This indicates bilateral consensus failure\n`);
    process.exit(1);
  }

  if (!account1?.frameHistory || account1.frameHistory.length === 0) {
    console.log('\n❌ FAILURE: No frames committed after first payment\n');
    process.exit(1);
  }

  console.log('\n✅ First payment successful!\n');

  // Step 3: Reverse payment (Entity 2 → Entity 1)
  console.log('💸 Step 3: Entity 2 sends 50 back to Entity 1...\n');

  const reverseResult = await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [
      {
        entityId: entity2Id,
        signerId: 's2',
        entityTxs: [
          {
            type: 'directPayment',
            data: {
              targetEntityId: entity1Id,
              tokenId: 2,
              amount: 5000n,
              description: 'Reverse payment',
            },
          },
        ],
      },
    ],
  });

  console.log(`📤 Reverse payment generated ${reverseResult.entityOutbox.length} outputs\n`);

  // Process reverse payment outputs
  outputs = reverseResult.entityOutbox;
  iteration = 0;

  while (outputs.length > 0 && iteration < 10) {
    iteration++;
    console.log(`\n🔄 Reverse Iteration ${iteration}: Processing ${outputs.length} outputs...\n`);

    const result = await applyServerInput(env, {
      serverTxs: [],
      entityInputs: outputs,
    });

    outputs = result.entityOutbox;
    console.log(`   Generated ${outputs.length} new outputs\n`);
  }

  // Check final state after both payments
  const e2Final = env.replicas.get(`${entity2Id}:s2`);
  const account2 = e2Final?.state.accounts.get(entity1Id);

  console.log('\n📊 Final State after both payments:\n');
  console.log(`   Entity 1 account: ${account1?.frameHistory?.length || 0} frames`);
  console.log(`   Entity 2 account: ${account2?.frameHistory?.length || 0} frames`);
  console.log(`   Entity 1 pending: ${account1?.pendingFrame ? 'YES' : 'NO'}`);
  console.log(`   Entity 2 pending: ${account2?.pendingFrame ? 'YES' : 'NO'}`);

  if (account1?.pendingFrame || account2?.pendingFrame) {
    console.log('\n⚠️  Frame stuck after reverse payment\n');
    process.exit(1);
  }

  if ((account1?.frameHistory?.length || 0) >= 2 && (account2?.frameHistory?.length || 0) >= 2) {
    console.log('\n✅ SUCCESS: Both payments completed with bilateral consensus!');
    console.log('   Payments work like a swiss clock ⏰\n');
    process.exit(0);
  }

  console.log('\n❌ FAILURE: Bilateral consensus incomplete\n');
  process.exit(1);
}

testFreshPayment().catch((err) => {
  console.error('❌ Test failed:', err);
  console.error(err.stack);
  process.exit(1);
});
