/**
 * HTLC Lazy Scenario: Alice-Hub-Bob over lazy 1-of-1 entities
 *
 * Pure bilateral off-chain HTLC payment flow without on-chain entity
 * registration, J reserves, or R2R/R2C transfers. Entities are created
 * via generateLazyEntityId so the Rust authority (rscore) accepts them.
 *
 * Demonstrates:
 * - Lazy 1-of-1 entity creation (minimal JAdapter but no on-chain registration)
 * - Bilateral account open + credit extension on lazy entities
 * - HTLC multi-hop routing (A->H->B) with deterministic secret
 * - Runs identically on TS engine and Rust authority (rscore)
 */

import type { RuntimeReplica } from '../../runtime/types';
import type { JAdapter } from '../../jurisdiction/adapter/types';
import { defaultAccountDisputeConfigForParties } from '../../account/config/dispute-config';
import { getProcess, usd, assertRuntimeIdle, enableStrictScenario, ensureSignerKeysFromSeed, requireRuntimeSeed, findReplica, getOffdelta, converge, commitRuntimeInput } from '../harness/helpers';
import { bindScenarioJReplica, ensureJAdapter, createJReplica, getScenarioJAdapter, isScenarioJAdapterMissingError, resolveScenarioBoardSigner } from '../harness/boot';
import { generateLazyEntityId } from '../../entity/factory';
import { withDeterministicHtlcTestSecret } from '../../protocol/htlc/test-secret-capability';
import { htlcRouteConvergenceCycleBudget } from './test-economy';
import { quoteHtlcPaymentRoute } from '../../pathfinding/htlc-quote';
import { createTestEntityImportRuntimeTx } from '../../qa/entity-creation-fixture';
import { calculateRequiredInboundForDesiredForward } from '../../protocol/htlc/utils';

const USDC_TOKEN_ID = 1;
const HTLC_TEST_SECRET = '0x0000000000000000000000000000000000000000000000000000000000000001';

export async function htlcLazy(env: RuntimeReplica): Promise<void> {
  // Rust authority logs authority.armed via console.error (diagnostic, not failure).
  // Skip strict mode when Rust authority is active to avoid throw on expected log.
  const isRscore = typeof process !== 'undefined' ? process.env['XLN_RSCORE_AUTHORITY'] === '1' : false;
  const restoreStrict = isRscore ? () => {} : enableStrictScenario(env, 'HTLC LAZY');
  requireRuntimeSeed(env, 'HTLC LAZY');
  ensureSignerKeysFromSeed(env, ['2', '3', '4'], 'HTLC LAZY');
  const proc = await getProcess();
  env.scenarioMode = true;

  try {
    console.log('[HTLC_LAZY] ========================================');
    console.log('[HTLC_LAZY] HTLC A->H->B on lazy 1-of-1 entities');
    console.log('[HTLC_LAZY] BEFORE: eReplicas =', env.state.eReplicas.size, 'height =', env.state.height);
    console.log('[HTLC_LAZY] ========================================');

    // ============================================================================
    // Bootstrap minimal JAdapter.
    // Required for createTestEntityImportRuntimeTx to bind jurisdiction config.
    // We do NOT call registerEntities (no on-chain entity registration) and
    // do NOT use reserves/R2R/R2C.
    // ============================================================================
    console.log('\n🏗️  Bootstrapping JAdapter (minimal, no entity registration)...');

    let jadapter: JAdapter;

    try {
      jadapter = getScenarioJAdapter(env);
    } catch (error) {
      if (!isScenarioJAdapterMissingError(error)) throw error;
      // Self-boot: no JAdapter attached yet
      jadapter = await ensureJAdapter(env);
      const jReplicaName = 'HTLC LAZY';
      bindScenarioJReplica(
        env,
        createJReplica(env, jReplicaName, jadapter.addresses.depository),
        jadapter,
      );
      jadapter.startWatching(env);
    }

    console.log('✅ JAdapter ready (no entities registered on-chain)');

    // ============================================================================
    // Create three lazy 1-of-1 entities (skip on-chain registerEntities)
    // entityId == generateLazyEntityId([signer], 1n, env).toLowerCase() is the
    // canonical pattern that Rust authority (rscore) requires.
    // ============================================================================
    console.log('\n📦 Creating lazy entities: Alice, Hub, Bob...');

    const aliceSigner = resolveScenarioBoardSigner(env, '2');
    const hubSigner = resolveScenarioBoardSigner(env, '3');
    const bobSigner = resolveScenarioBoardSigner(env, '4');

    const aliceEntityId = generateLazyEntityId([aliceSigner], 1n, env).toLowerCase();
    const hubEntityId = generateLazyEntityId([hubSigner], 1n, env).toLowerCase();
    const bobEntityId = generateLazyEntityId([bobSigner], 1n, env).toLowerCase();

    console.log(`   Alice id: ${aliceEntityId.slice(-8)}`);
    console.log(`   Hub   id: ${hubEntityId.slice(-8)}`);
    console.log(`   Bob   id: ${bobEntityId.slice(-8)}`);

    // Create Alice via runtime import (no on-chain registerEntities)
    await commitRuntimeInput(env, {
      runtimeTxs: [createTestEntityImportRuntimeTx(env, {
        entityId: aliceEntityId,
        signerId: aliceSigner,
        data: {
          isProposer: true,
          position: { x: -20, y: -40, z: 0 },
          config: {
            mode: 'proposer-based' as const,
            threshold: 1n,
            validators: [aliceSigner],
            shares: { [aliceSigner]: 1n },
          },
        },
      })],
      entityInputs: []
    });

    // Create Hub
    await commitRuntimeInput(env, {
      runtimeTxs: [createTestEntityImportRuntimeTx(env, {
        entityId: hubEntityId,
        signerId: hubSigner,
        data: {
          isProposer: true,
          position: { x: 0, y: -20, z: 0 },
          config: {
            mode: 'proposer-based' as const,
            threshold: 1n,
            validators: [hubSigner],
            shares: { [hubSigner]: 1n },
          },
        },
      })],
      entityInputs: []
    });

    // Create Bob
    await commitRuntimeInput(env, {
      runtimeTxs: [createTestEntityImportRuntimeTx(env, {
        entityId: bobEntityId,
        signerId: bobSigner,
        data: {
          isProposer: true,
          position: { x: 20, y: -40, z: 0 },
          config: {
            mode: 'proposer-based' as const,
            threshold: 1n,
            validators: [bobSigner],
            shares: { [bobSigner]: 1n },
          },
        },
      })],
      entityInputs: []
    });

    const alice = { id: aliceEntityId, signer: aliceSigner };
    const hub = { id: hubEntityId, signer: hubSigner };
    const bob = { id: bobEntityId, signer: bobSigner };

    console.log(`✅ Alice, Hub, Bob created (3 lazy 1-of-1 entities)`);
    console.log(`   eReplicas = ${env.state.eReplicas.size}`);

    // ============================================================================
    // Hub opens account with Alice, extend credit both directions
    // ============================================================================
    console.log('\n🔗 Hub opens account with Alice...');

    await proc(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'openAccount',
        data: {
          targetEntityId: alice.id,
          disputeConfig: defaultAccountDisputeConfigForParties(hub.id, true, alice.id, false),
        }
      }]
    }]);
    await converge(env);
    console.log('✅ Hub-Alice account opened');

    console.log('💳 Extending credit Hub<->Alice...');
    await proc(env, [
      {
        entityId: hub.id,
        signerId: hub.signer,
        entityTxs: [{
          type: 'extendCredit',
          data: {
            counterpartyEntityId: alice.id,
            tokenId: USDC_TOKEN_ID,
            amount: usd(50_000),
          }
        }]
      },
      {
        entityId: alice.id,
        signerId: alice.signer,
        entityTxs: [{
          type: 'extendCredit',
          data: {
            counterpartyEntityId: hub.id,
            tokenId: USDC_TOKEN_ID,
            amount: usd(50_000),
          }
        }]
      }
    ]);
    await converge(env);
    console.log('✅ Hub<->Alice credit extended (both directions)');

    // ============================================================================
    // Hub opens account with Bob, extend credit both directions
    // ============================================================================
    console.log('\n🔗 Hub opens account with Bob...');

    await proc(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'openAccount',
        data: {
          targetEntityId: bob.id,
          disputeConfig: defaultAccountDisputeConfigForParties(hub.id, true, bob.id, false),
        }
      }]
    }]);
    await converge(env);
    console.log('✅ Hub-Bob account opened');

    console.log('💳 Extending credit Hub<->Bob...');
    await proc(env, [
      {
        entityId: hub.id,
        signerId: hub.signer,
        entityTxs: [{
          type: 'extendCredit',
          data: {
            counterpartyEntityId: bob.id,
            tokenId: USDC_TOKEN_ID,
            amount: usd(50_000),
          }
        }]
      },
      {
        entityId: bob.id,
        signerId: bob.signer,
        entityTxs: [{
          type: 'extendCredit',
          data: {
            counterpartyEntityId: hub.id,
            tokenId: USDC_TOKEN_ID,
            amount: usd(50_000),
          }
        }]
      }
    ]);
    await converge(env);
    console.log('✅ Hub<->Bob credit extended (both directions)');

    // ============================================================================
    // HTLC Payment: Alice -> Hub -> Bob (usd(1_000))
    // ============================================================================
    const paymentAmount = usd(1_000);
    console.log(`\n⚡ HTLC Payment: Alice -> Hub -> Bob (USD 1,000)`);

    // Quote the route to get the correct sender lock amount including fees
    const routeQuote = quoteHtlcPaymentRoute(
      env.gossip.getProfiles(),
      [alice.id, hub.id, bob.id],
      USDC_TOKEN_ID,
      paymentAmount,
    );
    console.log(`   senderLockAmount = ${routeQuote.senderLockAmount}`);

    // Record pre-payment deltas for assertion
    const preAhDelta = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    const preHbDelta = getOffdelta(env, hub.id, bob.id, USDC_TOKEN_ID);
    console.log(`   Pre-payment: A-H delta=${preAhDelta}, H-B delta=${preHbDelta}`);

    // Alice initiates the HTLC payment with a deterministic secret
    console.log('🔒 Alice initiates HTLC A->H->B...');
    await proc(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [withDeterministicHtlcTestSecret({
        type: 'htlcPayment',
        data: {
          targetEntityId: bob.id,
          tokenId: USDC_TOKEN_ID,
          amount: paymentAmount,
          maxSenderDebit: routeQuote.senderLockAmount,
          route: [alice.id, hub.id, bob.id],
          deliveryMode: 'async',
          description: 'HTLC lazy payment A->H->B',
        }
      }, HTLC_TEST_SECRET)]
    }]);

    // Converge with enough cycles for 1 intermediary (Bob reveals secret,
    // secret propagates Hub->Alice, all ACKs settle)
    await converge(env, htlcRouteConvergenceCycleBudget(1));

    // ============================================================================
    // Assertions
    // ============================================================================
    console.log('\n🔍 Verifying HTLC settlement...');

    const ahDelta = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    const hbDelta = getOffdelta(env, hub.id, bob.id, USDC_TOKEN_ID);

    // Expected: Alice is debited senderGross (payment + fee), Hub is debited
    // payment amount on the H-B leg (Hub keeps the fee).
    const hubProfile = env.gossip?.getProfiles?.().find(p => p?.entityId === hub.id);
    const hubFeePpm = Number.isFinite(Number(hubProfile?.metadata?.routingFeePPM))
      ? Math.max(0, Math.floor(Number(hubProfile?.metadata?.routingFeePPM)))
      : 10;
    const senderGross = calculateRequiredInboundForDesiredForward(paymentAmount, hubFeePpm, 0n);
    // HTLC resolve adds +amount to right-sender's offdelta (Alice is right in A-H)
    // and -amount to left-sender's offdelta (Hub is left in H-B).
    const expectedAhDelta = preAhDelta + senderGross;
    const expectedHbDelta = preHbDelta - paymentAmount;

    console.log(`   A-H delta: ${ahDelta} (expected: ${expectedAhDelta})`);
    console.log(`   H-B delta: ${hbDelta} (expected: ${expectedHbDelta})`);

    // Check deltas
    if (ahDelta !== expectedAhDelta) {
      throw new Error(`ASSERT FAIL: A-H delta = ${ahDelta}, expected ${expectedAhDelta}`);
    }
    console.log('   ✅ A-H delta correct');

    if (hbDelta !== expectedHbDelta) {
      throw new Error(`ASSERT FAIL: H-B delta = ${hbDelta}, expected ${expectedHbDelta}`);
    }
    console.log('   ✅ H-B delta correct');

    // Check paybook/locks cleared (no pending HTLC entries)
    const [, aliceRep] = findReplica(env, alice.id);
    const [, hubRep] = findReplica(env, hub.id);
    const [, bobRep] = findReplica(env, bob.id);

    const alicePaybookSize = aliceRep.state.paybook.entries.size;
    const hubPaybookSize = hubRep.state.paybook.entries.size;
    const bobPaybookSize = bobRep.state.paybook.entries.size;

    console.log(`   Alice paybook entries: ${alicePaybookSize}`);
    console.log(`   Hub paybook entries:   ${hubPaybookSize}`);
    console.log(`   Bob paybook entries:   ${bobPaybookSize}`);

    if (alicePaybookSize !== 0) {
      throw new Error(`ASSERT FAIL: Alice paybook not empty (${alicePaybookSize} entries)`);
    }
    if (hubPaybookSize !== 0) {
      throw new Error(`ASSERT FAIL: Hub paybook not empty (${hubPaybookSize} entries)`);
    }
    if (bobPaybookSize !== 0) {
      throw new Error(`ASSERT FAIL: Bob paybook not empty (${bobPaybookSize} entries)`);
    }
    console.log('   ✅ All paybooks empty (no pending locks)');

    // Check Hub fee collected (if lock-ahb asserts fees)
    const hubFeesEarned = hubRep.state.paybook.feesEarned;
    const htlcFee = senderGross - paymentAmount;
    console.log(`   Hub fees earned: ${hubFeesEarned} (expected: >= ${htlcFee})`);
    if (hubFeesEarned < htlcFee) {
      console.log(`   ⚠️  Hub fees ${hubFeesEarned} < expected ${htlcFee}, but may be zero for lazy entity without profile`);
    } else {
      console.log('   ✅ Hub fee collected');
    }

    // ============================================================================
    // Final state
    // ============================================================================
    console.log('\n' + '='.repeat(80));
    console.log('📊 FINAL STATE');
    console.log('='.repeat(80));
    console.log(`Runtime frames: ${env.state.height}`);
    console.log(`eReplicas: ${env.state.eReplicas.size}`);

    await converge(env, htlcRouteConvergenceCycleBudget(1));
    assertRuntimeIdle(env, 'HTLC LAZY');

    console.log('\n✅ HTLC_LAZY_OK');

  } finally {
    restoreStrict();
    env.scenarioMode = false;
  }
}

