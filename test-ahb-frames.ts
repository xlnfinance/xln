#!/usr/bin/env bun
/**
 * Test AHB frame separation (Frame 12 vs Frame 13)
 * Verifies discrete network progression
 */

global.window = { frontendLogs: { enabled: false } } as any;
global.document = { querySelectorAll: () => [], querySelector: () => null, body: {} } as any;
global.fetch = async () => { throw new Error('No fetch in test'); };

const { createEmptyEnv, applyRuntimeInput, process } = await import('./runtime/runtime.ts');

console.log('🧪 Testing AHB frame separation (Frame 12 vs 13)...\n');

const env = createEmptyEnv();
env.skipPendingForward = false; // Will be controlled manually

const alice = '0x' + '1'.padStart(64, '0');
const hub = '0x' + '2'.padStart(64, '0');
const bob = '0x' + '3'.padStart(64, '0');
const USDC = 1;
const amount = 125_000n * 10n**18n;

// Create entities
await applyRuntimeInput(env, {
  runtimeTxs: [
    { type: 'importReplica', entityId: alice, signerId: 's1', data: {
      isProposer: true, config: { mode: 'proposer-based', threshold: 1n, validators: ['s1'], shares: { s1: 1n } }
    }},
    { type: 'importReplica', entityId: hub, signerId: 's2', data: {
      isProposer: true, config: { mode: 'proposer-based', threshold: 1n, validators: ['s2'], shares: { s2: 1n } }
    }},
    { type: 'importReplica', entityId: bob, signerId: 's3', data: {
      isProposer: true, config: { mode: 'proposer-based', threshold: 1n, validators: ['s3'], shares: { s3: 1n } }
    }},
  ],
  entityInputs: []
});

// Open accounts
await process(env, [
  { entityId: alice, signerId: 's1', entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub } }] },
  { entityId: bob, signerId: 's3', entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub } }] }
]);

// Setup: Alice 500k collateral, Bob 500k credit
const aliceRep = Array.from(env.eReplicas.values()).find(r => r.entityId === alice)!;
const hubRep = Array.from(env.eReplicas.values()).find(r => r.entityId === hub)!;
const bobRep = Array.from(env.eReplicas.values()).find(r => r.entityId === bob)!;

const delta = { tokenId: USDC, collateral: 500_000n * 10n**18n, ondelta: 0n, offdelta: 0n,
  leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n };
aliceRep.state.accounts.get(hub)!.deltas.set(USDC, delta);
hubRep.state.accounts.get(alice)!.deltas.set(USDC, delta);

await process(env, [{
  entityId: bob, signerId: 's3',
  entityTxs: [{ type: 'extendCredit', data: { counterpartyEntityId: hub, tokenId: USDC, amount: 500_000n * 10n**18n } }]
}]);

console.log('✅ Setup complete\n');

// FRAME 12: Alice → Hub (set flag to skip pendingForward processing)
console.log('═══ FRAME 12: Alice → Hub ═══');
env.skipPendingForward = true; // Skip forwarding this tick

await process(env, [{
  entityId: alice, signerId: 's1',
  entityTxs: [{
    type: 'directPayment',
    data: { targetEntityId: bob, tokenId: USDC, amount, route: [alice, hub, bob], description: 'Test' }
  }]
}]);

// Re-fetch replica after processing (state updated)
const hubRepFresh = Array.from(env.eReplicas.values()).find(r => r.entityId === hub)!;

const ahDelta12 = hubRepFresh.state.accounts.get(alice)?.deltas.get(USDC)?.offdelta ?? 0n;
const hbDelta12 = hubRepFresh.state.accounts.get(bob)?.deltas.get(USDC)?.offdelta ?? 0n;
const hubAliceAcc = hubRepFresh.state.accounts.get(alice);
const pendingForward = hubAliceAcc?.pendingForward;

console.log(`Alice-Hub: ${ahDelta12}`);
console.log(`Hub-Bob: ${hbDelta12}`);
console.log(`Hub has ${hubRepFresh.state.accounts.size} accounts`);
console.log(`Hub-Alice account exists: ${!!hubAliceAcc}`);
console.log(`pendingForward: ${pendingForward ? `SET (route=[${pendingForward.route.map((r:string) => r.slice(-4)).join(',')}])` : 'NONE'}`);

if (!pendingForward) {
  console.error('❌ pendingForward not set in Frame 12!');
  process.exit(1);
}
if (hbDelta12 !== 0n) {
  console.error(`❌ Hub-Bob changed in Frame 12! Should be 0, got ${hbDelta12}`);
  process.exit(1);
}

console.log('✅ Frame 12: Alice-Hub committed, Hub-Bob unchanged\n');

// Between frames: Process pendingForward
// CRITICAL: Mutate replica IN env.eReplicas, not stale hubRep variable
console.log('⏭️ Processing pendingForward between frames...');
const nextHop = pendingForward.route[1];

const hubReplicaKey = Array.from(env.eReplicas.keys()).find(k => k.startsWith(hub + ':'))!;
const hubReplicaLive = env.eReplicas.get(hubReplicaKey)!;
const hubBobAccLive = hubReplicaLive.state.accounts.get(nextHop!);
const hubAliceAccLive = hubReplicaLive.state.accounts.get(alice);

if (!hubBobAccLive) throw new Error('Hub-Bob account not found');

hubBobAccLive.mempool.push({
  type: 'direct_payment',
  data: {
    tokenId: pendingForward.tokenId,
    amount: pendingForward.amount,
    route: pendingForward.route.slice(1),
    description: pendingForward.description || 'Forwarded',
    fromEntityId: hub,
    toEntityId: nextHop!,
  }
});

delete hubAliceAccLive!.pendingForward;

console.log(`Hub-Bob mempool after manual add: ${hubBobAccLive.mempool.length}`);

// FRAME 13: Hub → Bob
// Send dummy input to Hub to trigger AUTO-PROPOSE
console.log('\n═══ FRAME 13: Hub → Bob ===');
env.skipPendingForward = false;

// Re-fetch after manual mutation
const hubRepFresh2 = Array.from(env.eReplicas.values()).find(r => r.entityId === hub)!;
console.log(`Hub-Bob mempool before process: ${hubRepFresh2.state.accounts.get(bob)!.mempool.length}`);

await process(env, [{
  entityId: hub,
  signerId: 's2',
  entityTxs: [] // Empty tx list triggers AUTO-PROPOSE
}]);

const hbDelta13 = hubRep.state.accounts.get(bob)?.deltas.get(USDC)?.offdelta ?? 0n;
console.log(`Hub-Bob: ${hbDelta13}`);

if (hbDelta13 === 0n) {
  console.error('❌ Hub-Bob NOT committed in Frame 13!');
  process.exit(1);
}

console.log('\n✅ ✅ ✅ FRAME SEPARATION WORKS!');
console.log(`Frame 12: Alice-Hub=${ahDelta12}`);
console.log(`Frame 13: Hub-Bob=${hbDelta13}`);
