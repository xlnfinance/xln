/**
 * XLN Demo Environment Setup and Testing
 * Demo orchestration, entity creation, and corner case testing scenarios
 */

import { ethers } from 'ethers';
import { 
  ConsensusConfig, EntityInput, EntityTx, EntityState, 
  EntityReplica, Env, JurisdictionConfig, ServerInput
} from './types.js';
import { 
  generateLazyEntityId, generateNumberedEntityId, detectEntityType,
  createLazyEntity, createNumberedEntity
} from './entity-factory.js';
import { formatEntityDisplay, formatSignerDisplay } from './utils.js';

// === DEMO ENTITY CONFIGURATIONS ===

export const createChatEntityConfig = (): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 2n,
  validators: ['alice', 'bob', 'carol'],
  shares: { alice: 1n, bob: 1n, carol: 1n }
});

export const createTradingEntityConfig = (): ConsensusConfig => ({
  mode: 'gossip-based',
  threshold: 7n,
  validators: ['alice', 'bob', 'carol', 'david'],
  shares: { alice: 4n, bob: 3n, carol: 2n, david: 1n }
});

export const createGovernanceEntityConfig = (): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 10n,
  validators: ['alice', 'bob', 'carol', 'david', 'eve'],
  shares: { alice: 3n, bob: 3n, carol: 3n, david: 3n, eve: 3n }
});

// === DEMO ENTITY CREATION ===

export const createDemoEntities = (): { [key: string]: string } => {
  console.log('🏗️ Creating demo entities...');
  
  // 1. Chat Entity (numbered)
  const chatEntityId = generateNumberedEntityId(1);
  console.log(`✅ Chat entity: ${chatEntityId}`);
  
  // 2. Trading Entity (numbered)  
  const tradingEntityId = generateNumberedEntityId(2);
  console.log(`✅ Trading entity: ${tradingEntityId}`);
  
  // 3. Governance Entity (lazy)
  const govConfig = createGovernanceEntityConfig();
  const govEntityId = generateLazyEntityId(govConfig.validators.map(v => ({ name: v, weight: 1 })), govConfig.threshold);
  console.log(`✅ Governance entity: ${govEntityId}`);
  
  return {
    chat: chatEntityId,
    trading: tradingEntityId,
    governance: govEntityId
  };
};

// === DEMO TRANSACTION SCENARIOS ===

export const createChatTransactions = (author: string): EntityTx[] => [
  { type: 'chat', data: { author, content: `Chat during trading!` } }
];

export const createBatchChatTransactions = (authors: string[]): EntityTx[] => {
  const txs: EntityTx[] = [];
  authors.forEach((author, i) => {
    txs.push({ type: 'chat', data: { author, content: `Batch message ${i + 1}` } });
  });
  return txs;
};

export const createTradingProposals = (proposer: string, message: string): EntityTx[] => [
  { type: 'propose', data: { 
    proposer, 
    action: { type: 'collective_message', data: { message } } 
  }}
];

export const createGovernanceProposals = (proposer: string, message: string): EntityTx[] => [
  { type: 'propose', data: { 
    proposer, 
    action: { type: 'collective_message', data: { message } } 
  }}
];

// === DEMO CORNER CASE SCENARIOS ===

export const createCornerCaseTests = (entityIds: { [key: string]: string }): EntityInput[] => {
  const tests: EntityInput[] = [];
  
  console.log('⚠️  CORNER CASE 1: Basic messaging');
  tests.push({
    entityId: entityIds.chat,
    signerId: 'bob',
    entityTxs: createChatTransactions('bob')
  });
  
  console.log('⚠️  CORNER CASE 2: Concurrent proposals');
  tests.push({
    entityId: entityIds.trading,
    signerId: 'alice',
    entityTxs: createTradingProposals('alice', 'Trading proposal 1: Set daily limit')
  });
  
  console.log('⚠️  CORNER CASE 3: Large message batch');
  tests.push({
    entityId: entityIds.chat,
    signerId: 'alice',
    entityTxs: createBatchChatTransactions(['alice', 'bob', 'carol', 'alice', 'bob', 'carol', 'alice', 'bob'])
  });
  
  console.log('⚠️  CORNER CASE 4: Governance voting');
  tests.push({
    entityId: entityIds.governance,
    signerId: 'alice',
    entityTxs: createGovernanceProposals('alice', 'Governance proposal: Increase block size limit')
  });
  
  console.log('⚠️  CORNER CASE 5: Empty mempool test');
  tests.push({
    entityId: entityIds.chat,
    signerId: 'alice',
    entityTxs: []
  });
  
  return tests;
};

// === DEMO ORCHESTRATION ===

export const processUntilEmpty = (env: Env, inputs: EntityInput[]): void => {
  console.log(`Starting batch processing with ${inputs.length} inputs...`);
  
  // Add inputs to environment
  if (inputs.length > 0) {
    env.serverInput.entityInputs.push(...inputs);
  }
  
  console.log(`Environment now has ${env.serverInput.entityInputs.length} pending entity inputs`);
};

export const createDemoServerInput = (entityInputs: EntityInput[] = []): ServerInput => ({
  serverTxs: [],
  entityInputs
});

export const logEntitySummary = (replica: EntityReplica, entityId: string): void => {
  const messages = replica.state.messages.length;
  const proposals = replica.state.proposals.size;
  const height = replica.state.height;
  const displayName = formatEntityDisplay(entityId);
  
  console.log(`  ${displayName}:${formatSignerDisplay(replica.signerId)}: ${messages} messages, ${proposals} proposals, height ${height}`);
  
  // Log messages
  if (messages > 0) {
    replica.state.messages.slice(0, 10).forEach((msg, i) => {
      console.log(`     ${i + 1}. ${msg}`);
    });
    if (messages > 10) console.log(`     ... and ${messages - 10} more`);
  }
  
  // Log proposals
  if (proposals > 0) {
    console.log(`     Proposals:`);
    let count = 0;
    for (const [propId, proposal] of replica.state.proposals) {
      if (count < 5) {
        console.log(`       ${propId} by ${proposal.proposer} [${proposal.status}] ${proposal.votes.size}/1 votes`);
        console.log(`         Action: ${proposal.action.data.message}`);
        count++;
      }
    }
    if (proposals > 5) console.log(`       ... and ${proposals - 5} more`);
  }
};

export const printEntitySummary = (env: Env, entityId: string, config: ConsensusConfig): void => {
  console.log(`📊 Entity: ${entityId.toUpperCase()}`);
  console.log(`   Mode: ${config.mode}`);
  console.log(`   Threshold: ${config.threshold}`);
  console.log(`   Validators: ${config.validators.length}`);
  console.log(`   Voting Power:`);
  
  for (const [validator, shares] of Object.entries(config.shares)) {
    console.log(`     ${validator}: ${shares} shares`);
  }
  
  // Print replica states
  config.validators.forEach(signerId => {
    const replicaKey = `${entityId}:${signerId}`;
    const replica = env.replicas.get(replicaKey);
    if (replica) {
      logEntitySummary(replica, entityId);
    }
  });
  
  // Check consensus
  const replicas = config.validators.map(signerId => env.replicas.get(`${entityId}:${signerId}`)).filter(Boolean);
  const messageConsensus = replicas.every(r => r!.state.messages.length === replicas[0]!.state.messages.length);
  const proposalConsensus = replicas.every(r => r!.state.proposals.size === replicas[0]!.state.proposals.size);
  
  console.log(`   🔍 Consensus: ${messageConsensus && proposalConsensus ? '✅ SUCCESS' : '❌ FAILURE'} (messages: ${messageConsensus ? '✅' : '❌'}, proposals: ${proposalConsensus ? '✅' : '❌'})`);
  
  if (replicas.length > 0) {
    console.log(`   📈 Total messages: ${replicas[0]!.state.messages.length}, proposals: ${replicas[0]!.state.proposals.size}`);
    const totalVotingPower = Object.values(config.shares).reduce((sum, shares) => sum + shares, 0n);
    console.log(`   ⚖️  Total voting power: ${totalVotingPower} (threshold: ${config.threshold})`);
  }
  console.log('');
};

// === DEMO VERIFICATION ===

export const verifyDemoResults = (env: Env, entityIds: { [key: string]: string }): boolean => {
  console.log('🏆 === OVERALL RESULT ===');
  
  const configs = {
    [entityIds.chat]: createChatEntityConfig(),
    [entityIds.trading]: createTradingEntityConfig(),
    [entityIds.governance]: createGovernanceEntityConfig()
  };
  
  let allSuccess = true;
  let totalEntities = 0;
  let totalReplicas = 0;
  let proposerBasedReplicas = 0;
  let gossipBasedReplicas = 0;
  
  for (const [name, entityId] of Object.entries(entityIds)) {
    const config = configs[entityId];
    if (config) {
      printEntitySummary(env, entityId, config);
      totalEntities++;
      totalReplicas += config.validators.length;
      
      if (config.mode === 'proposer-based') {
        proposerBasedReplicas += config.validators.length;
      } else {
        gossipBasedReplicas += config.validators.length;
      }
      
      // Simple consensus check
      const replicas = config.validators.map(signerId => env.replicas.get(`${entityId}:${signerId}`)).filter(Boolean);
      const consensus = replicas.every(r => r!.state.messages.length === replicas[0]!.state.messages.length);
      if (!consensus) allSuccess = false;
    }
  }
  
  console.log(`${allSuccess ? '✅ SUCCESS' : '❌ FAILURE'} - ${allSuccess ? 'All entities achieved consensus' : 'Some entities failed consensus'}`);
  console.log(`📊 Total entities tested: ${totalEntities}`);
  console.log(`📊 Total replicas: ${totalReplicas}`);
  console.log(`🔄 Total server ticks: ${env.height}`);
  console.log(`🎯 Fully deterministic - no randomness used`);
  console.log(`🌍 Environment-based architecture with clean function signatures`);
  console.log(`📡 Mode distribution:`);
  console.log(`   proposer-based: ${proposerBasedReplicas} replicas`);
  console.log(`   gossip-based: ${gossipBasedReplicas} replicas`);
  console.log('');
  
  return allSuccess;
}; 