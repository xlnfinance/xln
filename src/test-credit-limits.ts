#!/usr/bin/env bun
/**
 * Test credit limits implementation
 */

import { existsSync, rmSync } from 'fs';
import { generateNumberedEntityId } from './entity-factory';
import { getJurisdictionByAddress } from './evm';
import { applyServerInput, processUntilEmpty } from './server';
import { ConsensusConfig, Env } from './types';

const testCreditLimits = async () => {
  // Clean DB
  if (existsSync('db')) {
    rmSync('db', { recursive: true, force: true });
  }

  console.log('🧪 Testing Credit Limits\n');

  const env: Env = {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] },
    history: [],
    gossip: new Map(),
  };

  const ethereumJurisdiction = await getJurisdictionByAddress('ethereum');
  if (!ethereumJurisdiction) throw new Error('Ethereum jurisdiction not found');

  // Create two entities
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

  // Open bilateral account
  await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [{
      entityId: e1_id,
      signerId: 's1',
      entityTxs: [{
        type: 'openAccount' as const,
        data: { targetEntityId: e2_id },
      }],
    }],
  });
  await processUntilEmpty(env, []);

  // Set credit limit from E1 to E2
  console.log('📊 Setting credit limit: E1 extends 50,000 USDC credit to E2');

  await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [{
      entityId: e1_id,
      signerId: 's1',
      entityTxs: [{
        type: 'accountInput' as const,
        data: {
          fromEntityId: e1_id,
          toEntityId: e2_id,
          accountTx: {
            type: 'set_credit_limit' as const,
            data: {
              tokenId: 3, // USDC
              amount: 50000000000n, // 50,000 USDC (6 decimals)
              isForSelf: true, // E1 is setting their own limit
            },
          },
        },
      }],
    }],
  });
  await processUntilEmpty(env, []);

  // Check the account state
  const e1_replica = env.replicas.get(`${e1_id}:s1`);
  const e1_account = e1_replica?.state.accounts.get(e2_id);

  if (e1_account) {
    console.log('✅ Credit limit set successfully!');
    console.log(`   Own limit: ${e1_account.globalCreditLimits.ownLimit}`);
    console.log(`   Peer limit: ${e1_account.globalCreditLimits.peerLimit}`);
  } else {
    console.log('❌ Account not found');
  }

  // Now E2 sets their credit limit to E1
  console.log('\n📊 Setting credit limit: E2 extends 25,000 USDC credit to E1');

  await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [{
      entityId: e2_id,
      signerId: 's2',
      entityTxs: [{
        type: 'accountInput' as const,
        data: {
          fromEntityId: e2_id,
          toEntityId: e1_id,
          accountTx: {
            type: 'set_credit_limit' as const,
            data: {
              tokenId: 3, // USDC
              amount: 25000000000n, // 25,000 USDC
              isForSelf: true,
            },
          },
        },
      }],
    }],
  });
  await processUntilEmpty(env, []);

  const e2_replica = env.replicas.get(`${e2_id}:s2`);
  const e2_account = e2_replica?.state.accounts.get(e1_id);

  if (e2_account) {
    console.log('✅ E2 credit limit set successfully!');
    console.log(`   Own limit: ${e2_account.globalCreditLimits.ownLimit}`);
    console.log(`   Peer limit: ${e2_account.globalCreditLimits.peerLimit}`);
  }

  console.log('\n🎉 Credit Limits Test Complete!');
};

testCreditLimits().catch(console.error);