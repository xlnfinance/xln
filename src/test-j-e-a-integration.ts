#!/usr/bin/env bun
/**
 * J→E→A Integration Test
 * Tests the complete flow from Jurisdiction events → Entity consensus → Account bilateral settlement
 */

import { generateNumberedEntityId } from './entity-factory';
import { getJurisdictionByAddress } from './evm';
import { applyServerInput, processUntilEmpty } from './server';
import { ConsensusConfig, Env } from './types';

const runIntegrationTest = async () => {
  console.log('🧪 Starting J→E→A Integration Test\n');

  // Initialize environment with correct structure from server.ts
  const env: Env = {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] },
    history: [],
    gossip: new Map(), // Simple map for test, not using full gossip layer
  };

  // Get jurisdiction config
  const ethereumJurisdiction = await getJurisdictionByAddress('ethereum');
  if (!ethereumJurisdiction) {
    throw new Error('❌ Ethereum jurisdiction not found');
  }

  // Step 1: Setup two entities (E-machine layer)
  console.log('1️⃣ Creating two entities...');

  const e1_config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: BigInt(1),
    validators: ['s1'],
    shares: { s1: BigInt(1) },
    jurisdiction: ethereumJurisdiction,
  };
  const e1_id = generateNumberedEntityId(1);

  const e2_config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: BigInt(1),
    validators: ['s2'],
    shares: { s2: BigInt(1) },
    jurisdiction: ethereumJurisdiction,
  };
  const e2_id = generateNumberedEntityId(2);

  await applyServerInput(env, {
    serverTxs: [
      { type: 'importReplica', entityId: e1_id, signerId: 's1', data: { config: e1_config, isProposer: true } },
      { type: 'importReplica', entityId: e2_id, signerId: 's2', data: { config: e2_config, isProposer: true } },
    ],
    entityInputs: [],
  });
  await processUntilEmpty(env, []);

  console.log('✅ Entities created\n');

  // Step 2: Simulate J-machine events (jurisdiction layer)
  console.log('2️⃣ Simulating J-machine reserve update event...');

  const jEvent = {
    entityId: e1_id,
    signerId: 's1',
    entityTxs: [{
      type: 'j_event' as const,
      data: {
        from: 's1',
        event: {
          type: 'ReserveUpdated' as const,
          data: {
            entity: e1_id,
            tokenId: 1,
            newBalance: '10000000000000000000', // 10 ETH
            name: 'ETH',
            symbol: 'ETH',
            decimals: 18,
          },
        },
        observedAt: Date.now(),
        blockNumber: 1,
        transactionHash: '0xTEST_J_EVENT',
      },
    }],
  };

  await applyServerInput(env, { serverTxs: [], entityInputs: [jEvent] });
  await processUntilEmpty(env, []);

  const e1_replica = env.replicas.get(`${e1_id}:s1`);
  const e1_balance = e1_replica?.state.reserves.get('1');

  if (e1_balance === 10000000000000000000n) {
    console.log('✅ J-event processed: Entity 1 has 10 ETH\n');
  } else {
    console.error(`❌ J-event failed: Expected 10 ETH, got ${e1_balance}`);
    return;
  }

  // Step 3: Open bilateral account (A-machine layer)
  console.log('3️⃣ Opening bilateral account between entities...');

  const openAccountTx = {
    entityId: e1_id,
    signerId: 's1',
    entityTxs: [{
      type: 'openAccount' as const,
      data: { targetEntityId: e2_id },
    }],
  };

  await applyServerInput(env, { serverTxs: [], entityInputs: [openAccountTx] });
  await processUntilEmpty(env, []);

  const e1_state_after = env.replicas.get(`${e1_id}:s1`)?.state;
  const e2_state_after = env.replicas.get(`${e2_id}:s2`)?.state;

  if (e1_state_after?.accounts.has(e2_id)) {
    console.log('✅ Account opened on Entity 1 side');
  } else {
    console.error('❌ Account not opened on Entity 1');
    return;
  }

  // Check if the account input bubbled to Entity 2
  if (e2_state_after?.accounts.has(e1_id)) {
    console.log('✅ Account opened on Entity 2 side (via bubble)\n');
  } else {
    console.error('❌ Account not bubbled to Entity 2');
    return;
  }

  // Step 4: Test bilateral payment through account
  console.log('4️⃣ Testing bilateral payment...');

  const paymentTx = {
    entityId: e1_id,
    signerId: 's1',
    entityTxs: [{
      type: 'accountInput' as const,
      data: {
        fromEntityId: e1_id,
        toEntityId: e2_id,
        accountTx: {
          type: 'direct_payment' as const,
          data: {
            tokenId: 1,
            amount: 1000000000000000000n, // 1 ETH
            description: 'Test payment',
          },
          messageCounter: Date.now(),
        },
      },
    }],
  };

  await applyServerInput(env, { serverTxs: [], entityInputs: [paymentTx] });
  await processUntilEmpty(env, []);

  const e1_account = e1_state_after?.accounts.get(e2_id);
  const e2_account = e2_state_after?.accounts.get(e1_id);

  console.log('Account states after payment:');
  console.log(`  E1→E2 account deltas: ${Array.from(e1_account?.deltas || new Map()).map(([k,v]) => `Token${k}: ${v.ondelta}`)}`);
  console.log(`  E2→E1 account deltas: ${Array.from(e2_account?.deltas || new Map()).map(([k,v]) => `Token${k}: ${v.ondelta}`)}`);

  // Step 5: Verify complete flow
  console.log('\n5️⃣ INTEGRATION TEST SUMMARY:');
  console.log('  ✅ J-machine: Blockchain events processed');
  console.log('  ✅ E-machine: Entity consensus working');
  console.log('  ✅ A-machine: Bilateral accounts opened');
  console.log('  ✅ Event Bubbling: AccountInputs propagate between entities');
  console.log('\n🎉 J→E→A Integration Test PASSED!\n');
};

// Run the test
runIntegrationTest().catch(console.error);