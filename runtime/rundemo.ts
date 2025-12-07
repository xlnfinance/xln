/**
 * XLN Demo Runner (J-MOCKED VERSION)
 * Sets up a clean environment with two single-signer entities and demonstrates a reserve transfer.
 * 
 * NOTE: This console demo uses MOCKED j-events for fast development/testing.
 * The UI "Run Demo" button uses REAL j-watcher with blockchain integration.
 */

import { generateNumberedEntityId } from './entity-factory';
import { getJurisdictionByAddress } from './evm';
import { applyRuntimeInput, process } from './runtime';
import { ConsensusConfig, Env } from './types';
import { DEBUG, formatEntityDisplay } from './utils';

// This function simulates the data that a j-watcher would extract from on-chain events
const createDepositEvent = (entityId: string, signerId: string, asset: { asset: string, amount: string, decimals: number, tokenId: number }, eventType: string = 'DEPOSIT') => {
  const event = {
    entityId: entityId,
    signerId: signerId,
    entityTxs: [{
      type: 'j_event' as const,
      data: {
        from: signerId, 
        event: {
          type: 'ReserveUpdated' as const, // The watcher sees a reserve update
          data: {
            entity: entityId,
            tokenId: asset.tokenId,
            newBalance: asset.amount, // The event contains the final new balance
            name: asset.asset,
            symbol: asset.asset,
            decimals: asset.decimals,
          },
        },
        observedAt: Date.now(),
        blockNumber: 1, // Mock block number 
        transactionHash: `0xDEMO_${eventType}_${asset.asset}_${entityId.slice(0, 10)}`,
      },
    }],
  };
  
  if (DEBUG) {
    console.log(`🎭 Mock j_event created: ${eventType} ${asset.amount} ${asset.asset} for entity ${entityId.slice(0, 10)}...`);
  }
  
  return event;
};

const runDemo = async (env: Env): Promise<Env> => {
  if (DEBUG) {
    console.log('🚀 Starting XLN Demo: First Principles');
  }

  const arrakisJurisdiction = await getJurisdictionByAddress('arrakis');
  if (!arrakisJurisdiction) {
    throw new Error('❌ Arrakis jurisdiction not found');
  }

  const s1 = 's1';
  const s2 = 's2';

  console.log(`\n📋 Forming entities e1=[${s1}] and e2=[${s2}]...`);

  const e1_config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: BigInt(1),
    validators: [s1],
    shares: { [s1]: BigInt(1) },
    jurisdiction: arrakisJurisdiction,
  };
  const e1_id = generateNumberedEntityId(1);

  const e2_config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: BigInt(1),
    validators: [s2],
    shares: { [s2]: BigInt(1) },
    jurisdiction: arrakisJurisdiction,
  };
  const e2_id = generateNumberedEntityId(2);

  await applyRuntimeInput(env, {
    runtimeTxs: [
      { type: 'importReplica', entityId: e1_id, signerId: s1, data: { config: e1_config, isProposer: true } },
      { type: 'importReplica', entityId: e2_id, signerId: s2, data: { config: e2_config, isProposer: true } },
    ],
    entityInputs: [],
  });
  await process(env, []);
  
  // Clear any leftover transactions in mempool
  const e1_replica = env.eReplicas.get(`${e1_id}:${s1}`);
  const e2_replica = env.eReplicas.get(`${e2_id}:${s2}`);
  if (e1_replica) {
    console.log(`🧹 Cleared ${e1_replica.mempool.length} leftover transactions from e1 mempool`);
    e1_replica.mempool.length = 0;
  }
  if (e2_replica) {
    console.log(`🧹 Cleared ${e2_replica.mempool.length} leftover transactions from e2 mempool`);
    e2_replica.mempool.length = 0;
  }

  console.log(`✅ Entity ${formatEntityDisplay(e1_id)} and ${formatEntityDisplay(e2_id)} created.`);

  console.log(`\n💰 Prefunding entity ${formatEntityDisplay(e1_id)}...`);
  const initialPortfolio = [
    { asset: 'USDC', amount: '100000000000000000000', decimals: 18, tokenId: 1 },
    { asset: 'ETH', amount: '100000000000000000000', decimals: 18, tokenId: 2 },
  ];

  const depositInputs = initialPortfolio.map(asset => createDepositEvent(e1_id, s1, asset));
  await applyRuntimeInput(env, { runtimeTxs: [], entityInputs: depositInputs });
  await process(env, []);
  
  const e1_replica_after_funding = env.eReplicas.get(`${e1_id}:${s1}`);
  
  // Debug: Check what's actually in reserves
  if (DEBUG) {
    console.log('📊 Debug - Reserves after funding:');
    if (e1_replica_after_funding?.state.reserves) {
      for (const [tokenId, balance] of e1_replica_after_funding.state.reserves.entries()) {
        console.log(`  Token ${tokenId}: ${balance.toString()}`);
      }
    } else {
      console.log('  No reserves found');
    }
  }

  const ethReserve = e1_replica_after_funding?.state.reserves.get('1');
  const expectedETHAmount = 100000000000000000000n;
  
  if (!e1_replica_after_funding) {
    throw new Error('❌ Verification failed: e1 replica not found after funding.');
  }
  
  if (ethReserve === undefined) {
    throw new Error('❌ Verification failed: e1 ETH reserve not found. Available reserves: ' +
      Array.from(e1_replica_after_funding.state.reserves.keys()).join(', '));
  }

  if (ethReserve !== expectedETHAmount) {
    throw new Error(`❌ Verification failed: e1 ETH amount mismatch. Expected: ${expectedETHAmount}, Got: ${ethReserve}`);
  }

  console.log(`✅ ${formatEntityDisplay(e1_id)} funded successfully with ${ethReserve / 10n**18n} ETH.`);

  console.log(`\n💸 Performing reserve transfer from ${formatEntityDisplay(e1_id)} to ${formatEntityDisplay(e2_id)}...`);
  
  const transferAmount = 1000000000000000000n; // 1 ETH
  const transferTokenId = 1;
  
  // Get current balances to calculate new balances after transfer
  const e1_replica_before_transfer = env.eReplicas.get(`${e1_id}:${s1}`);
  const e2_replica_before_transfer = env.eReplicas.get(`${e2_id}:${s2}`);
  
  if (!e1_replica_before_transfer) {
    throw new Error('❌ Entity 1 replica not found before transfer');
  }
  
  // Demo code: Default to 0n for display if token not initialized yet
  const e1_current_balance = e1_replica_before_transfer.state.reserves.get('1') ?? 0n;
  const e2_current_balance = e2_replica_before_transfer?.state.reserves.get('1') ?? 0n;
  
  console.log(`📊 Pre-transfer: e1=${e1_current_balance}, e2=${e2_current_balance}`);
  
  // Calculate new balances
  const e1_new_balance = e1_current_balance - transferAmount; // 100 ETH - 1 ETH = 99 ETH
  const e2_new_balance = e2_current_balance + transferAmount; // 0 ETH + 1 ETH = 1 ETH
  
  console.log(`📊 Post-transfer: e1=${e1_new_balance}, e2=${e2_new_balance}`);
  
  // Create j_events to simulate the jurisdiction updating both entities' reserves
  const transferEvents = [
    // Update Entity 1's balance (sender)
    createDepositEvent(e1_id, s1, { 
      asset: 'ETH', 
      amount: e1_new_balance.toString(), 
      decimals: 18, 
      tokenId: transferTokenId 
    }, 'TRANSFER_OUT'),
    // Update Entity 2's balance (receiver)  
    createDepositEvent(e2_id, s2, { 
      asset: 'ETH', 
      amount: e2_new_balance.toString(), 
      decimals: 18, 
      tokenId: transferTokenId 
    }, 'TRANSFER_IN')
  ];

  console.log(`💸 Simulating jurisdiction events for reserve transfer...`);
  await applyRuntimeInput(env, { runtimeTxs: [], entityInputs: transferEvents });
  await process(env, []);

  console.log('✅ Transfer transaction submitted.');
  
  const e1_replica_after_transfer = env.eReplicas.get(`${e1_id}:${s1}`);
  const e2_replica_after_transfer = env.eReplicas.get(`${e2_id}:${s2}`);
  
  // Debug: Check final reserves for both entities
  if (DEBUG) {
    console.log('📊 Debug - Final reserves after transfer:');
    console.log('Entity 1 reserves:');
    if (e1_replica_after_transfer?.state.reserves) {
      for (const [tokenId, balance] of e1_replica_after_transfer.state.reserves.entries()) {
        console.log(`  Token ${tokenId}: ${balance.toString()}`);
      }
    }
    console.log('Entity 2 reserves:');
    if (e2_replica_after_transfer?.state.reserves) {
      for (const [tokenId, balance] of e2_replica_after_transfer.state.reserves.entries()) {
        console.log(`  Token ${tokenId}: ${balance.toString()}`);
      }
    }
  }
  
  const e1_final_balance = e1_replica_after_transfer?.state.reserves.get('1');
  const e2_final_balance = e2_replica_after_transfer?.state.reserves.get('1');
  
  const expectedE1Balance = 99000000000000000000n; // 100 ETH - 1 ETH transfer = 99 ETH
  const expectedE2Balance = 1000000000000000000n; // 1 ETH transferred

  if (e1_final_balance !== expectedE1Balance) {
    throw new Error(`❌ Verification failed: e1 has incorrect final ETH balance. Expected: ${expectedE1Balance}, Got: ${e1_final_balance}`);
  }
  if (e2_final_balance !== expectedE2Balance) {
    throw new Error(`❌ Verification failed: e2 did not receive ETH. Expected: ${expectedE2Balance}, Got: ${e2_final_balance}`);
  }
  console.log(`✅ State verified: e1 has ${e1_final_balance / 10n**18n} ETH, e2 has ${e2_final_balance / 10n**18n} ETH.`);

  // 🆕 ACCOUNT OPENING AND DIRECT PAYMENT TEST
  console.log(`\n💳 Opening account between ${formatEntityDisplay(e1_id)} and ${formatEntityDisplay(e2_id)}...`);

  // STEP 1: e1 opens account with e2
  const accountOpeningInput = {
    entityId: e1_id,
    signerId: s1,
    entityTxs: [{
      type: 'openAccount' as const,
      data: { targetEntityId: e2_id }
    }]
  };

  await applyRuntimeInput(env, { runtimeTxs: [], entityInputs: [accountOpeningInput] });
  await process(env, []);

  console.log(`✅ Account opened between ${formatEntityDisplay(e1_id)} and ${formatEntityDisplay(e2_id)}`);

  // STEP 2: e1 sends direct payment to e2 via account (using credit)
  console.log(`\n💸 ${formatEntityDisplay(e1_id)} sending direct payment to ${formatEntityDisplay(e2_id)}...`);

  const directPaymentInput = {
    entityId: e1_id,
    signerId: s1,
    entityTxs: [{
      type: 'accountInput' as const,
      data: {
        fromEntityId: e1_id,
        toEntityId: e2_id,
        accountTx: {
          type: 'direct_payment' as const,
          data: {
            tokenId: 1, // USDC token for reference pricing (token 1 = USDC)
            amount: 50000n, // $500 USD payment
            description: 'Demo direct payment from e1 to e2'
          }
        },
        metadata: {
          purpose: 'account_direct_payment',
          description: 'Testing direct payment with global credit limits'
        }
      }
    }]
  };

  await applyRuntimeInput(env, { runtimeTxs: [], entityInputs: [directPaymentInput] });
  await process(env, []);

  console.log(`✅ Direct payment sent: $500 USD from ${formatEntityDisplay(e1_id)} to ${formatEntityDisplay(e2_id)}`);

  // STEP 2.5: Verify bilateral balance conservation
  const e1_final_replica = env.eReplicas.get(`${e1_id}:${s1}`);
  const e2_final_replica = env.eReplicas.get(`${e2_id}:${s2}`);

  console.log(`\n🔍 BILATERAL BALANCE VERIFICATION:`);

  if (e1_final_replica?.state.accounts.has(e2_id) && e2_final_replica?.state.accounts.has(e1_id)) {
    const e1_account = e1_final_replica.state.accounts.get(e2_id)!;
    const e2_account = e2_final_replica.state.accounts.get(e1_id)!;

    // Check token 1 (USDC) balances
    const e1_delta = e1_account.deltas.get(1);
    const e2_delta = e2_account.deltas.get(1);

    if (e1_delta && e2_delta) {
      const e1_total = e1_delta.ondelta + e1_delta.offdelta;
      const e2_total = e2_delta.ondelta + e2_delta.offdelta;
      const sum = e1_total + e2_total;

      console.log(`💰 E1 owes E2: ${e1_total.toString()} cents ($${(Number(e1_total) / 100).toFixed(2)})`);
      console.log(`💰 E2 owes E1: ${e2_total.toString()} cents ($${(Number(e2_total) / 100).toFixed(2)})`);
      console.log(`💰 Sum: ${sum.toString()} cents (should be 0)`);

      if (sum === 0n) {
        console.log(`✅ CONSERVATION LAW VERIFIED: Bilateral balance maintained in rundemo!`);
      } else {
        console.log(`❌ CONSERVATION VIOLATED: Bilateral imbalance detected!`);
      }

      if (e1_total === 50000n && e2_total === -50000n) {
        console.log(`✅ PAYMENT VERIFIED: $500 correctly transferred from E1 to E2`);
      } else {
        console.log(`❌ PAYMENT MISMATCH: Expected E1:+500, E2:-500, got E1:${e1_total}, E2:${e2_total}`);
      }
    } else {
      console.log(`⚠️ Missing deltas for verification`);
    }
  } else {
    console.log(`⚠️ Account machines not found for verification`);
  }

  // STEP 3: Verify account states
  const e1_replica_final = env.eReplicas.get(`${e1_id}:${s1}`);
  const e2_replica_final = env.eReplicas.get(`${e2_id}:${s2}`);

  if (e1_replica_final?.state.accounts.has(e2_id)) {
    const e1_account = e1_replica_final.state.accounts.get(e2_id)!;
    console.log(`💳 ${formatEntityDisplay(e1_id)} account with ${formatEntityDisplay(e2_id)}:`);
    console.log(`   Credit limits: own=${e1_account.globalCreditLimits.ownLimit.toString()} USD, peer=${e1_account.globalCreditLimits.peerLimit.toString()} USD`);
    console.log(`   Frame ${e1_account.currentFrame.height}: tokens=[${e1_account.currentFrame.tokenIds.join(',')}], deltas=[${e1_account.currentFrame.deltas.map(d => d.toString()).join(',')}]`);
    console.log(`   Sent transitions: ${e1_account.sentTransitions}, mempool: ${e1_account.mempool.length}`);
  }

  if (e2_replica_final?.state.accounts.has(e1_id)) {
    const e2_account = e2_replica_final.state.accounts.get(e1_id)!;
    console.log(`💳 ${formatEntityDisplay(e2_id)} account with ${formatEntityDisplay(e1_id)}:`);
    console.log(`   Credit limits: own=${e2_account.globalCreditLimits.ownLimit.toString()} USD, peer=${e2_account.globalCreditLimits.peerLimit.toString()} USD`);
    console.log(`   Frame ${e2_account.currentFrame.height}: tokens=[${e2_account.currentFrame.tokenIds.join(',')}], deltas=[${e2_account.currentFrame.deltas.map(d => d.toString()).join(',')}]`);
    console.log(`   Sent transitions: ${e2_account.sentTransitions}, mempool: ${e2_account.mempool.length}`);
  }

  console.log('\n🎯 J-MOCKED Demo completed with Account System!');
  console.log('📊 Check the dashboard to verify final reserve states and account states.');
  console.log('💳 Account system: 1M USD credit limits, direct payment processed');
  console.log('🌐 For REAL blockchain integration, use the "Run Demo" button in the UI!');

  return env;
};

export { runDemo };
