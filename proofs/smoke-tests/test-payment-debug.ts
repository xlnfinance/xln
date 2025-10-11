import { main, applyServerInput, processUntilEmpty } from './src/server';
import { prepopulate } from './src/prepopulate';

async function testPayment() {
  console.log('🧪 Starting payment test...');

  // Initialize environment
  const env = await main();
  console.log(`✅ Env initialized with ${env.replicas.size} replicas`);

  // Prepopulate if empty
  if (env.replicas.size === 0) {
    console.log('🔄 Prepopulating environment...');
    // Temporarily silence logs
    const originalLog = console.log;
    console.log = () => {};
    await prepopulate(env, processUntilEmpty);
    console.log = originalLog;
    console.log(`\n✅ Prepopulated with ${env.replicas.size} replicas\n`);
  }

  // Find two entities
  const replicaKeys = Array.from(env.replicas.keys());
  console.log(`📋 Available replica keys (${replicaKeys.length}):`);
  replicaKeys.slice(0, 5).forEach(k => console.log(`   - ${k}`));

  const entity1Key = replicaKeys.find(k => k.includes(':alice')) || replicaKeys.find(k => k.includes(':s1'));
  const entity2Key = replicaKeys.find(k => k.includes(':bob')) || replicaKeys.find(k => k.includes(':s2'));

  if (!entity1Key || !entity2Key) {
    console.error('❌ Could not find two entities');
    console.log('Looking for keys with :alice or :s1, and :bob or :s2');
    process.exit(1);
  }

  const e1 = env.replicas.get(entity1Key);
  const e2 = env.replicas.get(entity2Key);
  const e1_id = e1!.state.entityId;
  const e2_id = e2!.state.entityId;

  console.log(`\n💰 Entity 1: ${e1_id.slice(0, 10)}...`);
  console.log(`💰 Entity 2: ${e2_id.slice(0, 10)}...`);

  // Check if account exists
  let hasAccount = e1!.state.accounts.has(e2_id);
  console.log(`\n🔍 Account exists: ${hasAccount}`);

  if (!hasAccount) {
    console.log('🔄 Creating account between entities...');

    const openAccountInput = {
      entityId: e1_id,
      signerId: 's1',
      entityTxs: [{
        type: 'openAccount' as const,
        data: {
          targetEntityId: e2_id
        }
      }]
    };

    const openResult = await applyServerInput(env, { serverTxs: [], entityInputs: [openAccountInput] });
    await processUntilEmpty(env, openResult.entityOutbox);

    // Refresh and check
    const e1_refreshed = env.replicas.get(entity1Key);
    hasAccount = e1_refreshed!.state.accounts.has(e2_id);
    console.log(`✅ Account created: ${hasAccount}`);

    if (!hasAccount) {
      console.error('❌ Failed to create account');
      process.exit(1);
    }
  }

  // Send payment
  console.log(`\n💸 Sending 100 from Entity 1 → Entity 2...`);

  const paymentInput = {
    entityId: e1_id,
    signerId: 's1',
    entityTxs: [{
      type: 'directPayment' as const,
      data: {
        targetEntityId: e2_id,
        tokenId: 2,
        amount: 10000n, // 100.00 in cents
        description: 'Test payment'
      }
    }]
  };

  const initialResult = await applyServerInput(env, { serverTxs: [], entityInputs: [paymentInput] });
  console.log(`✅ Payment initiated - ${initialResult.entityOutbox.length} outputs generated`);

  if (initialResult.entityOutbox.length > 0) {
    console.log('📤 Generated outputs:');
    initialResult.entityOutbox.forEach((output, i) => {
      console.log(`   ${i + 1}. Entity: ${output.entityId.slice(0, 10)}..., Signer: ${output.signerId}, Txs: ${output.entityTxs?.length || 0}`);
      if (output.entityTxs && output.entityTxs.length > 0) {
        output.entityTxs.forEach((tx, j) => {
          console.log(`      - Tx ${j + 1}: ${tx.type}`);
        });
      }
    });
  }

  // Check account state BEFORE processUntilEmpty
  let account = e1!.state.accounts.get(e2_id);
  console.log(`\n📊 Account state BEFORE cascade:`);
  console.log(`   Mempool: ${account?.mempool.length || 0} txs`);
  console.log(`   Pending frame: ${account?.pendingFrame ? 'YES' : 'NO'}`);
  console.log(`   Current frame ID: ${account?.currentFrameId || 0}`);

  // Process until empty WITH THE OUTPUTS
  console.log(`\n🔄 Processing cascade with ${initialResult.entityOutbox.length} initial outputs...`);
  await processUntilEmpty(env, initialResult.entityOutbox);

  // Refresh replica reference after processing
  const e1_updated = env.replicas.get(entity1Key);
  account = e1_updated!.state.accounts.get(e2_id);

  console.log(`\n📊 Account state AFTER cascade:`);
  console.log(`   Mempool: ${account?.mempool.length || 0} txs`);
  console.log(`   Pending frame: ${account?.pendingFrame ? 'YES' : 'NO'}`);
  console.log(`   Current frame ID: ${account?.currentFrameId || 0}`);
  console.log(`   Frame history: ${account?.frameHistory.length || 0} frames`);

  if (account?.pendingFrame) {
    console.log(`\n⚠️ PROBLEM: Frame ${account.pendingFrame.frameId} is STUCK`);
    console.log(`   Frame has ${account.pendingFrame.accountTxs.length} transactions`);
    console.log(`   Frame state hash: ${account.pendingFrame.stateHash?.slice(0, 16)}...`);
  }

  if (account?.frameHistory && account.frameHistory.length > 0) {
    console.log(`\n✅ SUCCESS: Frames committed to history`);
    const lastFrame = account.frameHistory[account.frameHistory.length - 1];
    console.log(`   Last frame ID: ${lastFrame?.frameId}`);
    console.log(`   Last frame txs: ${lastFrame?.accountTxs.length}`);
  }

  process.exit(0);
}

// Timeout after 25 seconds
setTimeout(() => {
  console.error('❌ Test timeout after 25 seconds');
  process.exit(1);
}, 25000);

testPayment().catch(err => {
  console.error('❌ Test failed:', err);
  console.error(err.stack);
  process.exit(1);
});