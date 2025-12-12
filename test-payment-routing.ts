#!/usr/bin/env bun
/**
 * Smoke test: Multi-hop payment routing (no BrowserVM, no browser)
 * Tests the core R-E-A payment flow without blockchain dependencies
 */

// Mock browser globals
global.window = { frontendLogs: { enabled: false } } as any;
global.document = { querySelectorAll: () => [], querySelector: () => null, body: {} } as any;

const { createEmptyEnv, applyRuntimeInput, process } = await import('./runtime/runtime.ts');

console.log('🧪 Testing multi-hop payment routing...\n');

const env = createEmptyEnv();

// Entity IDs (simple numbered for test)
const alice = '0x' + '1'.padStart(64, '0');
const hub = '0x' + '2'.padStart(64, '0');
const bob = '0x' + '3'.padStart(64, '0');

// Create entities
await applyRuntimeInput(env, {
  runtimeTxs: [
    { type: 'importReplica', entityId: alice, signerId: 's1', data: {
      isProposer: true,
      config: { mode: 'proposer-based', threshold: 1n, validators: ['s1'], shares: { s1: 1n } }
    }},
    { type: 'importReplica', entityId: hub, signerId: 's2', data: {
      isProposer: true,
      config: { mode: 'proposer-based', threshold: 1n, validators: ['s2'], shares: { s2: 1n } }
    }},
    { type: 'importReplica', entityId: bob, signerId: 's3', data: {
      isProposer: true,
      config: { mode: 'proposer-based', threshold: 1n, validators: ['s3'], shares: { s3: 1n } }
    }},
  ],
  entityInputs: []
});

console.log('✅ Created 3 entities\n');

// Open accounts: Alice↔Hub, Hub↔Bob
await process(env, [
  { entityId: alice, signerId: 's1', entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub } }] },
  { entityId: bob, signerId: 's3', entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub } }] }
]);

console.log('✅ Opened bilateral accounts\n');

// Give Alice collateral ($500k)
const aliceReplica = Array.from(env.eReplicas.values()).find(r => r.entityId === alice);
if (aliceReplica) {
  const aliceHubAccount = aliceReplica.state.accounts.get(hub);
  if (aliceHubAccount) {
    const delta = { tokenId: 1, collateral: 500_000n * 10n**18n, ondelta: 0n, offdelta: 0n,
      leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n };
    aliceHubAccount.deltas.set(1, delta);

    // Also set on Hub's view
    const hubReplica = Array.from(env.eReplicas.values()).find(r => r.entityId === hub);
    if (hubReplica) {
      const hubAliceAccount = hubReplica.state.accounts.get(alice);
      if (hubAliceAccount) {
        hubAliceAccount.deltas.set(1, delta);
      }
    }
  }
}

// Give Bob credit to Hub ($500k)
const bobReplica = Array.from(env.eReplicas.values()).find(r => r.entityId === bob);
if (bobReplica) {
  await process(env, [{
    entityId: bob, signerId: 's3',
    entityTxs: [{ type: 'extendCredit', data: { counterpartyEntityId: hub, tokenId: 1, amount: 500_000n * 10n**18n } }]
  }]);
}

console.log('✅ Set up capacity: Alice 500k collateral, Bob 500k credit\n');

// Send multi-hop payment: Alice → Hub → Bob ($125k)
console.log('🚀 Sending Alice→Hub→Bob payment ($125k)...\n');

try {
  // Import process with single-iteration support
  const { process: processRaw } = await import('./runtime/runtime.ts');

  // FRAME 1: Alice initiates payment
  console.log('\n═══ FRAME 1: Alice initiates ═══');
  let outputs = [{
    entityId: alice,
    signerId: 's1',
    entityTxs: [{
      type: 'directPayment',
      data: {
        targetEntityId: bob,
        tokenId: 1,
        amount: 125_000n * 10n**18n,
        route: [alice, hub, bob],
        description: 'Test payment'
      }
    }]
  }];

  await processRaw(env, outputs, 0, true); // Single iteration
  outputs = env.pendingOutputs || [];

  let aliceHubDelta = Array.from(env.eReplicas.values()).find(r => r.entityId === alice)?.state.accounts.get(hub)?.deltas.get(1);
  let hubBobDelta = Array.from(env.eReplicas.values()).find(r => r.entityId === hub)?.state.accounts.get(bob)?.deltas.get(1);
  let hubBobPending = Array.from(env.eReplicas.values()).find(r => r.entityId === hub)?.state.accounts.get(bob)?.pendingFrame;

  console.log(`✓ Alice-Hub offdelta: ${aliceHubDelta?.offdelta} (expect: 0 - not yet processed)`);
  console.log(`✓ Hub-Bob offdelta: ${hubBobDelta?.offdelta} (expect: 0)`);
  console.log(`✓ Remaining outputs: ${outputs.length}\n`);

  // FRAME 2: Hub processes Alice's payment
  console.log('═══ FRAME 2: Hub processes Alice payment ═══');
  await processRaw(env, outputs, 0, true);
  outputs = env.pendingOutputs || [];

  aliceHubDelta = Array.from(env.eReplicas.values()).find(r => r.entityId === alice)?.state.accounts.get(hub)?.deltas.get(1);
  hubBobDelta = Array.from(env.eReplicas.values()).find(r => r.entityId === hub)?.state.accounts.get(bob)?.deltas.get(1);
  hubBobPending = Array.from(env.eReplicas.values()).find(r => r.entityId === hub)?.state.accounts.get(bob)?.pendingFrame;

  console.log(`✓ Alice-Hub offdelta: ${aliceHubDelta?.offdelta} (expect: 125k - committed)`);
  console.log(`✓ Hub-Bob offdelta: ${hubBobDelta?.offdelta} (expect: 0 - not yet committed)`);
  console.log(`✓ Hub-Bob pendingFrame: ${hubBobPending ? 'YES' : 'NO'} (expect: YES - proposed)`);
  console.log(`✓ Remaining outputs: ${outputs.length}\n`);

  // FRAME 3: Bob processes Hub's payment
  console.log('═══ FRAME 3: Bob processes Hub payment ═══');
  await processRaw(env, outputs, 0, true);
  outputs = env.pendingOutputs || [];

  aliceHubDelta = Array.from(env.eReplicas.values()).find(r => r.entityId === alice)?.state.accounts.get(hub)?.deltas.get(1);
  hubBobDelta = Array.from(env.eReplicas.values()).find(r => r.entityId === hub)?.state.accounts.get(bob)?.deltas.get(1);
  hubBobPending = Array.from(env.eReplicas.values()).find(r => r.entityId === hub)?.state.accounts.get(bob)?.pendingFrame;

  console.log(`✓ Alice-Hub offdelta: ${aliceHubDelta?.offdelta} (expect: 125k)`);
  console.log(`✓ Hub-Bob offdelta: ${hubBobDelta?.offdelta} (expect: 0 - ACK not processed yet)`);
  console.log(`✓ Hub-Bob pendingFrame: ${hubBobPending ? 'YES' : 'NO'} (expect: YES)`);
  console.log(`✓ Remaining outputs: ${outputs.length}\n`);

  // FRAME 4: Hub receives Bob's ACK and commits
  console.log('═══ FRAME 4: Hub commits (receives Bob ACK) ═══');
  await processRaw(env, outputs, 0, true);

  aliceHubDelta = Array.from(env.eReplicas.values()).find(r => r.entityId === alice)?.state.accounts.get(hub)?.deltas.get(1);
  hubBobDelta = Array.from(env.eReplicas.values()).find(r => r.entityId === hub)?.state.accounts.get(bob)?.deltas.get(1);
  hubBobPending = Array.from(env.eReplicas.values()).find(r => r.entityId === hub)?.state.accounts.get(bob)?.pendingFrame;

  console.log(`✓ Alice-Hub offdelta: ${aliceHubDelta?.offdelta} (expect: 125k)`);
  console.log(`✓ Hub-Bob offdelta: ${hubBobDelta?.offdelta} (expect: -124.875k - NOW committed)`);
  console.log(`✓ Hub-Bob pendingFrame: ${hubBobPending ? 'YES' : 'NO'} (expect: NO - committed)`);

  // Verify final state
  const success = aliceHubDelta && aliceHubDelta.offdelta !== 0n && hubBobDelta && hubBobDelta.offdelta !== 0n;

  if (success) {
    console.log('\n✅ ✅ ✅ DISTRIBUTED MULTI-HOP WORKS! (3 separate frames)');
  } else {
    console.log('\n❌ Payment incomplete');
    console.log(`Alice-Hub=${aliceHubDelta?.offdelta}, Hub-Bob=${hubBobDelta?.offdelta}`);
  }
} catch (error: any) {
  console.error('\n❌ ❌ ❌ PAYMENT FAILED:', error.message);
  console.error(error.stack);
}
