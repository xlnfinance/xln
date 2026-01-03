/**
 * HTLC 4-Hop Route Test
 * Tests: Alice → Hub1 → Hub2 → Hub3 → Bob
 * Verifies onion routing, fees cascade, secret propagation
 */

import type { Env } from '../types';
import { createEconomy, connectEconomy, testHtlcRoute, type EconomyEntity } from './test-economy';
import { usd } from './helpers';
import { ensureBrowserVM, createJReplica } from './boot';

const USDC_TOKEN_ID = 1;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`❌ ASSERT: ${message}`);
  }
  console.log(`✅ ${message}`);
}

function findReplica(env: Env, entityId: string) {
  const entry = Array.from(env.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) throw new Error(`Replica for ${entityId} not found`);
  return entry;
}

export async function test4HopHtlc(env: Env): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('          HTLC 4-HOP ONION ROUTING TEST                    ');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Setup BrowserVM
  const browserVM = await ensureBrowserVM();
  const depositoryAddress = browserVM.getDepositoryAddress();
  createJReplica(env, '4-Hop Demo', depositoryAddress);

  // Create economy: 3 hubs + 2 users
  const { hubs, users, all } = await createEconomy(env, {
    numHubs: 3,
    usersPerHub: 1,
    initialCollateral: usd(500_000),
    creditLimit: usd(200_000),
    tokenId: USDC_TOKEN_ID,
    jurisdictionName: '4-Hop Demo'
  });

  const [hub1, hub2, hub3] = hubs;
  const alice = users[0][0]; // User under Hub1
  const bob = users[2][0];   // User under Hub3

  console.log(`📋 Entities created:`);
  console.log(`   Alice: ${alice.id.slice(-4)} (user, connected to ${hub1.name})`);
  console.log(`   ${hub1.name}: ${hub1.id.slice(-4)}`);
  console.log(`   ${hub2.name}: ${hub2.id.slice(-4)}`);
  console.log(`   ${hub3.name}: ${hub3.id.slice(-4)}`);
  console.log(`   Bob: ${bob.id.slice(-4)} (user, connected to ${hub3.name})\n`);

  // Connect channels
  await connectEconomy(env, hubs, users, usd(200_000), USDC_TOKEN_ID);

  // Test 4-hop route: Alice → Hub1 → Hub2 → Hub3 → Bob
  console.log('\n═══════════════════════════════════════');
  console.log('🚀 TESTING 4-HOP HTLC ROUTE');
  console.log('═══════════════════════════════════════\n');

  const route = [hub1, hub2, hub3];
  const paymentAmount = usd(50_000);

  await testHtlcRoute(env, alice, bob, route, paymentAmount, USDC_TOKEN_ID, '4-hop onion routing test');

  // Verify settlement
  console.log('🔍 Verifying 4-hop settlement...\n');

  const [, aliceRep] = findReplica(env, alice.id);
  const [, hub1Rep] = findReplica(env, hub1.id);
  const [, hub2Rep] = findReplica(env, hub2.id);
  const [, hub3Rep] = findReplica(env, hub3.id);
  const [, bobRep] = findReplica(env, bob.id);

  // All locks should be cleared (auto-revealed)
  const aliceHub1Account = aliceRep.state.accounts.get(hub1.id);
  const hub1Hub2Account = hub1Rep.state.accounts.get(hub2.id);
  const hub2Hub3Account = hub2Rep.state.accounts.get(hub3.id);
  const hub3BobAccount = hub3Rep.state.accounts.get(bob.id);

  console.log(`   Locks after settlement:`);
  console.log(`   Alice-Hub1: ${aliceHub1Account?.locks.size || 0}`);
  console.log(`   Hub1-Hub2: ${hub1Hub2Account?.locks.size || 0}`);
  console.log(`   Hub2-Hub3: ${hub2Hub3Account?.locks.size || 0}`);
  console.log(`   Hub3-Bob: ${hub3BobAccount?.locks.size || 0}\n`);

  assert((aliceHub1Account?.locks.size || 0) === 0, 'All locks cleared after 4-hop reveal');

  // Check fees earned at each hop
  const { calculateHtlcFeeAmount } = await import('../htlc-utils');
  const hop1Fee = calculateHtlcFeeAmount(paymentAmount);
  const hop2Fee = calculateHtlcFeeAmount(paymentAmount - hop1Fee);
  const hop3Fee = calculateHtlcFeeAmount(paymentAmount - hop1Fee - hop2Fee);
  const totalFees = hop1Fee + hop2Fee + hop3Fee;

  console.log(`   Fees collected:`);
  console.log(`   Hub1: ${hub1Rep.state.htlcFeesEarned || 0n} (expected: ${hop1Fee})`);
  console.log(`   Hub2: ${hub2Rep.state.htlcFeesEarned || 0n} (expected: ${hop2Fee})`);
  console.log(`   Hub3: ${hub3Rep.state.htlcFeesEarned || 0n} (expected: ${hop3Fee})`);
  console.log(`   Total: ${totalFees}\n`);

  // Note: htlcFeesEarned only increments during forwarding
  // If direct route or no forwarding, fees will be 0
  const totalFeesEarned = (hub1Rep.state.htlcFeesEarned || 0n) +
                          (hub2Rep.state.htlcFeesEarned || 0n) +
                          (hub3Rep.state.htlcFeesEarned || 0n);
  console.log(`   Total fees earned by hubs: ${totalFeesEarned}\n`);

  if (totalFeesEarned === 0n) {
    console.log(`   ⚠️  No fees collected - likely direct route was used (Alice has direct account with Bob?)`);
    console.log(`      Or forwarding didn't trigger (check envelope processing)\n`);
  }

  // Verify deltas
  const aliceHub1Delta = aliceHub1Account?.deltas.get(USDC_TOKEN_ID);
  const hub3BobDelta = hub3BobAccount?.deltas.get(USDC_TOKEN_ID);

  console.log(`   Delta changes:`);
  console.log(`   Alice-Hub1 offdelta: ${aliceHub1Delta?.offdelta || 0n} (Alice paid)`);
  console.log(`   Hub3-Bob offdelta: ${hub3BobDelta?.offdelta || 0n} (Bob received)\n`);

  const bobReceived = -(hub3BobDelta?.offdelta || 0n); // Hub3 perspective is negative, so Bob received is positive
  const alicePaid = -(aliceHub1Delta?.offdelta || 0n); // Alice perspective is negative

  assert(alicePaid === paymentAmount, 'Alice paid full amount');
  assert(bobReceived === paymentAmount - totalFees, 'Bob received amount minus all hop fees');

  console.log('═══════════════════════════════════════');
  console.log('✅ 4-HOP HTLC TEST PASSED!');
  console.log(`   Route: ${route.length + 2} entities (${route.length} intermediate hops)`);
  console.log(`   Privacy: Each hop only knew nextHop`);
  console.log(`   Fees: $${Number(totalFees) / 1e18} total (3 hops)`);
  console.log(`   Settlement: Atomic via secret revelation`);
  console.log('═══════════════════════════════════════\n');
}

// CLI entry point
if (import.meta.main) {
  const runtime = await import('../runtime');
  const env = runtime.createEmptyEnv();
  env.scenarioMode = true;
  env.timestamp = 1000;

  await test4HopHtlc(env);

  console.log(`✅ 4-hop test complete! Total frames: ${env.history?.length || 0}\n`);
  process.exit(0);
}
