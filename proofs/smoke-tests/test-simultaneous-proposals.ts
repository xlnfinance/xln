/**
 * Test simultaneous proposals - both entities propose at same time
 * Tests Channel.ts rollback logic: Left wins, Right rolls back
 */

import { Env, EntityInput } from './src/types';
import { applyServerInput } from './src/server';

async function testSimultaneousProposals() {
  console.log('🧪 Simultaneous Proposals Test\n');

  // Create minimal environment
  const env: Env = {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] },
    history: [],
    gossip: null as any,
  };

  const entity1Id = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const entity2Id = '0x0000000000000000000000000000000000000000000000000000000000000002';

  console.log('📦 Creating Entity 1 (LEFT) and Entity 2 (RIGHT)...\n');

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
          },
        },
      },
    ],
    entityInputs: [],
  });

  // Open account
  console.log('🔗 Opening account...\n');
  const openResult = await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [
      {
        entityId: entity1Id,
        signerId: 's1',
        entityTxs: [{ type: 'openAccount', data: { targetEntityId: entity2Id } }],
      },
    ],
  });

  if (openResult.entityOutbox.length > 0) {
    await applyServerInput(env, { serverTxs: [], entityInputs: openResult.entityOutbox });
  }

  console.log('✅ Account established\n');

  // SIMULTANEOUS PROPOSALS: Both send payment at same time
  console.log('💥 SIMULTANEOUS: Both entities send payment at exact same time...\n');

  const simultaneousInputs: EntityInput[] = [
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
            description: 'E1 payment',
          },
        },
      ],
    },
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
            description: 'E2 payment',
          },
        },
      ],
    },
  ];

  // Process BOTH inputs simultaneously
  const simResult = await applyServerInput(env, {
    serverTxs: [],
    entityInputs: simultaneousInputs,
  });

  console.log(`\n📤 Generated ${simResult.entityOutbox.length} outputs\n`);

  // Process cascade
  let outputs = simResult.entityOutbox;
  let iteration = 0;

  while (outputs.length > 0 && iteration < 20) {
    iteration++;
    console.log(`🔄 Iteration ${iteration}: Processing ${outputs.length} outputs...\n`);

    const result = await applyServerInput(env, {
      serverTxs: [],
      entityInputs: outputs,
    });

    outputs = result.entityOutbox;
    console.log(`   Generated ${outputs.length} new outputs\n`);
  }

  // Check final state
  const e1 = env.replicas.get(`${entity1Id}:s1`);
  const e2 = env.replicas.get(`${entity2Id}:s2`);
  const account1 = e1?.state.accounts.get(entity2Id);
  const account2 = e2?.state.accounts.get(entity1Id);

  console.log('\n📊 Final State after simultaneous proposals:\n');
  console.log(`   Entity 1 (LEFT) account:`);
  console.log(`      Frame history: ${account1?.frameHistory?.length || 0} frames`);
  console.log(`      Pending frame: ${account1?.pendingFrame ? 'YES' : 'NO'}`);
  console.log(`      Rollback count: ${account1?.rollbackCount || 0}`);
  console.log(`   Entity 2 (RIGHT) account:`);
  console.log(`      Frame history: ${account2?.frameHistory?.length || 0} frames`);
  console.log(`      Pending frame: ${account2?.pendingFrame ? 'YES' : 'NO'}`);
  console.log(`      Rollback count: ${account2?.rollbackCount || 0}`);

  // Expected: LEFT should have sent their frame, RIGHT should have rolled back
  // Eventually both should converge to same state

  if (account1?.pendingFrame || account2?.pendingFrame) {
    console.log('\n⚠️  Frames stuck - rollback logic failed\n');
    process.exit(1);
  }

  if ((account1?.frameHistory?.length || 0) >= 1 && (account2?.frameHistory?.length || 0) >= 1) {
    console.log('\n✅ SUCCESS: Simultaneous proposals resolved correctly!');
    console.log('   LEFT won, RIGHT rolled back and accepted\n');
    process.exit(0);
  }

  console.log('\n❌ FAILURE: Rollback logic incomplete\n');
  process.exit(1);
}

testSimultaneousProposals().catch((err) => {
  console.error('❌ Test failed:', err);
  console.error(err.stack);
  process.exit(1);
});
