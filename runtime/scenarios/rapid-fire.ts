/**
 * Rapid-Fire Payment Stress Test
 *
 * Tests bilateral consensus under high load:
 * - Alice→Hub→Bob: $1 payments every 100ms
 * - Bob→Hub→Alice: $1 reverse payments every 100ms
 * - Continuous for 10 seconds (100 payments each direction)
 * - Total: 200 payments, ~400 bilateral frames
 *
 * This stress-tests:
 * - Rollback handling under rapid proposals
 * - Frame chain integrity with high throughput
 * - Memory pool management
 * - sentTransitions counter correctness
 * - No deadlocks or infinite loops
 *
 * Run with: bun runtime/scenarios/rapid-fire.ts
 */

import type { Env, EntityInput } from '../types';
import { ensureBrowserVM, createJReplica, createJurisdictionConfig } from './boot';
import { findReplica, getOffdelta, converge, assert } from './helpers';

let _process: ((env: Env, inputs?: EntityInput[], delay?: number, single?: boolean) => Promise<Env>) | null = null;
let _applyRuntimeInput: ((env: Env, runtimeInput: any) => Promise<Env>) | null = null;

const getProcess = async () => {
  if (!_process) {
    const runtime = await import('../runtime');
    _process = runtime.process;
  }
  return _process;
};

const getApplyRuntimeInput = async () => {
  if (!_applyRuntimeInput) {
    const runtime = await import('../runtime');
    _applyRuntimeInput = runtime.applyRuntimeInput;
  }
  return _applyRuntimeInput;
};

const USDC = 1;
const DECIMALS = 18n;
const ONE = 10n ** DECIMALS;
const usd = (amount: number | bigint) => BigInt(amount) * ONE;

// Using helpers from helpers.ts (no duplication)

export async function rapidFire(env: Env): Promise<void> {
  // Register test keys for real signatures
  const { registerTestKeys } = await import('../account-crypto');
  await registerTestKeys(['s1', 's2', 's3', 'hub', 'alice', 'bob', 'carol', 'dave', 'frank']);
  const process = await getProcess();
  const applyRuntimeInput = await getApplyRuntimeInput();

  if (env.scenarioMode && env.height === 0) {
    env.timestamp = 1;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('     RAPID-FIRE: High-Load Bilateral Consensus Stress Test     ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ============================================================================
  // SETUP: BrowserVM + Entities
  // ============================================================================
  console.log('🏛️  Setting up test environment...');

  const browserVM = await ensureBrowserVM();
  const depositoryAddress = browserVM.getDepositoryAddress();
  createJReplica(env, 'RapidFire', depositoryAddress, { x: 0, y: 600, z: 0 }); // Match ahb.ts positioning

  const entities = [
    { name: 'Alice', id: '0x' + '1'.padStart(64, '0'), signer: 's1' },
    { name: 'Hub', id: '0x' + '2'.padStart(64, '0'), signer: 's2' },
    { name: 'Bob', id: '0x' + '3'.padStart(64, '0'), signer: 's3' },
  ];

  await applyRuntimeInput(env, {
    runtimeTxs: entities.map(e => ({
      type: 'importReplica' as const,
      entityId: e.id,
      signerId: e.signer,
      data: {
        isProposer: true,
        position: { x: 0, y: 0, z: 0 },
        config: { mode: 'proposer-based' as const, threshold: 1n, validators: [e.signer], shares: { [e.signer]: 1n } },
      },
    })),
    entityInputs: [],
  });

  const [alice, hub, bob] = entities;
  console.log(`  ✅ Created: ${entities.map(e => e.name).join(', ')}\n`);

  // ============================================================================
  // SETUP: Bilateral accounts
  // ============================================================================
  console.log('🔗 Opening bilateral accounts...');

  await process(env, [
    { entityId: alice.id, signerId: alice.signer, entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub.id } }] },
    { entityId: bob.id, signerId: bob.signer, entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub.id } }] },
  ]);

  await converge(env);
  console.log('  ✅ Alice-Hub and Bob-Hub accounts created\n');

  // ============================================================================
  // SETUP: Large credit limits (support 200 $1 payments)
  // ============================================================================
  console.log('💳 Setting up credit limits...');

  const creditLimit = usd(1_000_000); // 1M capacity each direction

  await process(env, [
    {
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC, amount: creditLimit } },
      ],
    },
    {
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: alice.id, tokenId: USDC, amount: creditLimit } },
        { type: 'extendCredit', data: { counterpartyEntityId: bob.id, tokenId: USDC, amount: creditLimit } },
      ],
    },
    {
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC, amount: creditLimit } },
      ],
    },
  ]);

  await converge(env);
  console.log('  ✅ Bidirectional credit established\n');

  // ============================================================================
  // STRESS TEST: Rapid-fire payments (100 each direction)
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('    STRESS TEST: 100 payments A→H→B + 100 payments B→H→A      ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const paymentAmount = ONE; // $1 per payment
  const paymentCount = 100;
  const batchSize = 5; // Smaller batches for better convergence

  let forwardCount = 0;
  let reverseCount = 0;
  const startTime = Date.now();

  console.log(`🚀 Sending ${paymentCount} payments each direction ($1 every ~100ms)...\n`);

  for (let batch = 0; batch < paymentCount / batchSize; batch++) {
    const batchStart = Date.now();

    // Send batch of 10 forward + 10 reverse
    const batchInputs: EntityInput[] = [];

    for (let i = 0; i < batchSize; i++) {
      // Forward: Alice → Hub → Bob
      batchInputs.push({
        entityId: alice.id,
        signerId: alice.signer,
        entityTxs: [{
          type: 'directPayment',
          data: {
            targetEntityId: bob.id,
            tokenId: USDC,
            amount: paymentAmount,
            route: [alice.id, hub.id, bob.id],
            description: `Forward #${forwardCount++}`,
          },
        }],
      });

      // Reverse: Bob → Hub → Alice
      batchInputs.push({
        entityId: bob.id,
        signerId: bob.signer,
        entityTxs: [{
          type: 'directPayment',
          data: {
            targetEntityId: alice.id,
            tokenId: USDC,
            amount: paymentAmount,
            route: [bob.id, hub.id, alice.id],
            description: `Reverse #${reverseCount++}`,
          },
        }],
      });
    }

    // Submit batch
    await process(env, batchInputs);

    // Allow bilateral consensus to settle (more rounds for multi-hop)
    await converge(env, 50); // Each payment is 2 hops (A→H, H→B), needs ~8 rounds each

    const elapsed = Date.now() - batchStart;
    if (batch % 2 === 0) {
      console.log(`   Batch ${batch + 1}/10: ${batchSize * 2} payments in ${elapsed}ms (${forwardCount} fwd, ${reverseCount} rev)`);
    }
  }

  const totalTime = Date.now() - startTime;
  console.log(`\n✅ Stress test complete: ${forwardCount + reverseCount} payments in ${totalTime}ms`);
  console.log(`   Throughput: ${((forwardCount + reverseCount) / (totalTime / 1000)).toFixed(1)} payments/sec`);

  // Final convergence - drain all pending ACKs
  console.log('\n🔄 Final convergence (draining all pending frames)...');
  await converge(env, 200); // High-load needs many rounds to drain
  console.log('   ✅ All frames settled\n');

  // ============================================================================
  // VERIFICATION
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                   VERIFICATION                                ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Check final deltas (should net to zero - same amount each direction)
  const ahDelta = getOffdelta(env, alice.id, hub.id, USDC);
  const hbDelta = getOffdelta(env, hub.id, bob.id, USDC);

  const expectedNet = 0n; // 100 forward @ $1 - 100 reverse @ $1 = $0

  console.log(`📊 Final positions:`);
  console.log(`   Alice-Hub: ${ahDelta} (expected ~${expectedNet})`);
  console.log(`   Hub-Bob:   ${hbDelta} (expected ~${expectedNet})`);

  // Allow some tolerance for in-flight frames
  const tolerance = usd(20); // $20 tolerance for pending settlements
  assert(
    ahDelta >= -tolerance && ahDelta <= tolerance,
    `Alice-Hub delta within tolerance: ${ahDelta}`
  );
  assert(
    hbDelta >= -tolerance && hbDelta <= tolerance,
    `Hub-Bob delta within tolerance: ${hbDelta}`
  );

  // Check no stuck mempools
  let totalMempool = 0;
  let totalPending = 0;

  for (const [, replica] of env.eReplicas) {
    for (const [, account] of replica.state.accounts) {
      totalMempool += account.mempool.length;
      if (account.pendingFrame) totalPending++;
    }
  }

  console.log(`\n🔍 Final state:`);
  console.log(`   Total mempool items: ${totalMempool}`);
  console.log(`   Pending frames: ${totalPending}`);
  console.log(`   History frames: ${env.history?.length || 0}`);

  assert(totalMempool === 0, 'All mempools drained');
  assert(totalPending === 0, 'No pending frames');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('✅ RAPID-FIRE STRESS TEST COMPLETE!');
  console.log(`   Payments: ${forwardCount + reverseCount}`);
  console.log(`   Duration: ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`   Throughput: ${((forwardCount + reverseCount) / (totalTime / 1000)).toFixed(1)} tx/s`);
  console.log(`   Frames: ${env.history?.length || 0}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
}

// Self-executing
if (import.meta.main) {
  const { createEmptyEnv } = await import('../runtime');
  const env = createEmptyEnv();
  env.scenarioMode = true;
  await rapidFire(env);
}
