/**
 * XLN Demo Runner
 * Sets up a clean environment with two single-signer entities and demonstrates a reserve transfer.
 */
import { generateNumberedEntityId } from './entity-factory';
import { getJurisdictionByAddress } from './evm';
import { applyServerInput, processUntilEmpty } from './server';
import { DEBUG, formatEntityDisplay } from './utils';
// This function simulates the data that a j-watcher would extract from on-chain events
const createDepositEvent = (entityId, signerId, asset, eventType = 'DEPOSIT') => {
    const event = {
        entityId: entityId,
        signerId: signerId,
        entityTxs: [{
                type: 'j_event',
                data: {
                    from: signerId,
                    event: {
                        type: 'ReserveUpdated', // The watcher sees a reserve update
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
const runDemo = async (env) => {
    if (DEBUG) {
        console.log('🚀 Starting XLN Demo: First Principles');
    }
    const ethereumJurisdiction = await getJurisdictionByAddress('ethereum');
    if (!ethereumJurisdiction) {
        throw new Error('❌ Ethereum jurisdiction not found');
    }
    const s1 = 's1';
    const s2 = 's2';
    console.log(`\n📋 Forming entities e1=[${s1}] and e2=[${s2}]...`);
    const e1_config = {
        mode: 'proposer-based',
        threshold: BigInt(1),
        validators: [s1],
        shares: { [s1]: BigInt(1) },
        jurisdiction: ethereumJurisdiction,
    };
    const e1_id = generateNumberedEntityId(1);
    const e2_config = {
        mode: 'proposer-based',
        threshold: BigInt(1),
        validators: [s2],
        shares: { [s2]: BigInt(1) },
        jurisdiction: ethereumJurisdiction,
    };
    const e2_id = generateNumberedEntityId(2);
    await applyServerInput(env, {
        serverTxs: [
            { type: 'importReplica', entityId: e1_id, signerId: s1, data: { config: e1_config, isProposer: true } },
            { type: 'importReplica', entityId: e2_id, signerId: s2, data: { config: e2_config, isProposer: true } },
        ],
        entityInputs: [],
    });
    await processUntilEmpty(env, []);
    // Clear any leftover transactions in mempool
    const e1_replica = env.replicas.get(`${e1_id}:${s1}`);
    const e2_replica = env.replicas.get(`${e2_id}:${s2}`);
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
        { asset: 'ETH', amount: '11000000000000000000', decimals: 18, tokenId: 1 },
        { asset: 'USDT', amount: '5000000000', decimals: 6, tokenId: 2 },
    ];
    const depositInputs = initialPortfolio.map(asset => createDepositEvent(e1_id, s1, asset));
    await applyServerInput(env, { serverTxs: [], entityInputs: depositInputs });
    await processUntilEmpty(env, []);
    const e1_replica_after_funding = env.replicas.get(`${e1_id}:${s1}`);
    // Debug: Check what's actually in reserves
    if (DEBUG) {
        console.log('📊 Debug - Reserves after funding:');
        if (e1_replica_after_funding?.state.reserves) {
            for (const [tokenId, balance] of e1_replica_after_funding.state.reserves.entries()) {
                console.log(`  Token ${tokenId}: ${balance.amount} ${balance.symbol} (${balance.decimals} decimals)`);
            }
        }
        else {
            console.log('  No reserves found');
        }
    }
    const ethReserve = e1_replica_after_funding?.state.reserves.get('1');
    const expectedETHAmount = 11000000000000000000n;
    if (!e1_replica_after_funding) {
        throw new Error('❌ Verification failed: e1 replica not found after funding.');
    }
    if (!ethReserve) {
        throw new Error('❌ Verification failed: e1 ETH reserve not found. Available reserves: ' +
            Array.from(e1_replica_after_funding.state.reserves.keys()).join(', '));
    }
    if (ethReserve.amount !== expectedETHAmount) {
        throw new Error(`❌ Verification failed: e1 ETH amount mismatch. Expected: ${expectedETHAmount}, Got: ${ethReserve.amount}`);
    }
    console.log(`✅ ${formatEntityDisplay(e1_id)} funded successfully with ${ethReserve.amount / 10n ** 18n} ETH.`);
    console.log(`\n💸 Performing reserve transfer from ${formatEntityDisplay(e1_id)} to ${formatEntityDisplay(e2_id)}...`);
    const transferAmount = 1000000000000000000n; // 1 ETH
    const transferTokenId = 1;
    // Get current balances to calculate new balances after transfer
    const e1_replica_before_transfer = env.replicas.get(`${e1_id}:${s1}`);
    const e2_replica_before_transfer = env.replicas.get(`${e2_id}:${s2}`);
    if (!e1_replica_before_transfer) {
        throw new Error('❌ Entity 1 replica not found before transfer');
    }
    const e1_current_balance = e1_replica_before_transfer.state.reserves.get('1')?.amount || 0n;
    const e2_current_balance = e2_replica_before_transfer?.state.reserves.get('1')?.amount || 0n;
    console.log(`📊 Pre-transfer: e1=${e1_current_balance}, e2=${e2_current_balance}`);
    // Calculate new balances
    const e1_new_balance = e1_current_balance - transferAmount; // 11 ETH - 1 ETH = 10 ETH
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
    await applyServerInput(env, { serverTxs: [], entityInputs: transferEvents });
    await processUntilEmpty(env, []);
    console.log('✅ Transfer transaction submitted.');
    const e1_replica_after_transfer = env.replicas.get(`${e1_id}:${s1}`);
    const e2_replica_after_transfer = env.replicas.get(`${e2_id}:${s2}`);
    // Debug: Check final reserves for both entities
    if (DEBUG) {
        console.log('📊 Debug - Final reserves after transfer:');
        console.log('Entity 1 reserves:');
        if (e1_replica_after_transfer?.state.reserves) {
            for (const [tokenId, balance] of e1_replica_after_transfer.state.reserves.entries()) {
                console.log(`  Token ${tokenId}: ${balance.amount} ${balance.symbol} (${balance.decimals} decimals)`);
            }
        }
        console.log('Entity 2 reserves:');
        if (e2_replica_after_transfer?.state.reserves) {
            for (const [tokenId, balance] of e2_replica_after_transfer.state.reserves.entries()) {
                console.log(`  Token ${tokenId}: ${balance.amount} ${balance.symbol} (${balance.decimals} decimals)`);
            }
        }
    }
    const e1_final_balance = e1_replica_after_transfer?.state.reserves.get('1')?.amount;
    const e2_final_balance = e2_replica_after_transfer?.state.reserves.get('1')?.amount;
    const expectedE1Balance = 10000000000000000000n; // 11 ETH - 1 ETH transfer = 10 ETH
    const expectedE2Balance = 1000000000000000000n; // 1 ETH transferred
    if (e1_final_balance !== expectedE1Balance) {
        throw new Error(`❌ Verification failed: e1 has incorrect final ETH balance. Expected: ${expectedE1Balance}, Got: ${e1_final_balance}`);
    }
    if (e2_final_balance !== expectedE2Balance) {
        throw new Error(`❌ Verification failed: e2 did not receive ETH. Expected: ${expectedE2Balance}, Got: ${e2_final_balance}`);
    }
    console.log(`✅ State verified: e1 has ${e1_final_balance / 10n ** 18n} ETH, e2 has ${e2_final_balance / 10n ** 18n} ETH.`);
    console.log('\n🎯 Demo completed!');
    console.log('📊 Check the dashboard to verify final reserve states for e1 and e2.');
    return env;
};
export { runDemo };
