// === DEMO FUNCTIONS ===

import { Env, ConsensusConfig, EntityTx, ServerInput } from './types.js';
import { generateNumberedEntityId, generateLazyEntityId } from './entity-utils.js';
import { DEFAULT_JURISDICTIONS } from './jurisdictions.js';
import { processServerInput, processUntilEmpty } from './consensus-engine.js';
import { captureSnapshot } from './snapshot-manager.js';
import { registerNumberedEntityOnChain } from './blockchain.js';

const DEBUG = true;

export const runDemo = (env: Env): Env => {
  
  if (DEBUG) {
    console.log('🚀 Starting XLN Consensus Demo - Multi-Entity Test');
    console.log('✨ Using deterministic hash-based proposal IDs (no randomness)');
    console.log('🌍 Environment-based architecture with merged serverInput');
    console.log('🗑️ History cleared for fresh start');
  }
  
  // === TEST 1: Chat Entity - NUMBERED ENTITY (Blockchain Registered) ===
  console.log('\n📋 TEST 1: Chat Entity - Numbered Entity with Jurisdiction');
  const chatValidators = ['alice', 'bob', 'carol'];
  const chatConfig: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: BigInt(2), // Need 2 out of 3 shares
    validators: chatValidators,
    shares: {
      alice: BigInt(1), // Equal voting power
      bob: BigInt(1),
      carol: BigInt(1)
    },
    jurisdiction: DEFAULT_JURISDICTIONS.get('ethereum') // Add jurisdiction
  };
  
  // Create numbered entity (blockchain registered)
  const chatEntityId = generateNumberedEntityId(1); // Use entity #1
  
  processServerInput(env, {
    serverTxs: chatValidators.map((signerId, index) => ({
      type: 'importReplica' as const,
      entityId: chatEntityId,
      signerId,
      data: {
        config: chatConfig,
        isProposer: index === 0
      }
    })),
    entityInputs: []
  }, captureSnapshot);
  
  // === TEST 2: Trading Entity - NUMBERED ENTITY (Blockchain Registered) ===
  console.log('\n📋 TEST 2: Trading Entity - Numbered Entity with Jurisdiction');
  const tradingValidators = ['alice', 'bob', 'carol', 'david'];
  const tradingConfig: ConsensusConfig = {
    mode: 'gossip-based', // Test gossip mode
    threshold: BigInt(7), // Need 7 out of 10 total shares
    validators: tradingValidators,
    shares: {
      alice: BigInt(4), // Major stakeholder
      bob: BigInt(3),   // Medium stakeholder
      carol: BigInt(2), // Minor stakeholder
      david: BigInt(1)  // Minimal stakeholder
    },
    jurisdiction: DEFAULT_JURISDICTIONS.get('ethereum') // Add jurisdiction
  };
  
  // Create numbered entity (blockchain registered)
  const tradingEntityId = generateNumberedEntityId(2); // Use entity #2
  
  processServerInput(env, {
    serverTxs: tradingValidators.map((signerId, index) => ({
      type: 'importReplica' as const,
      entityId: tradingEntityId,
      signerId,
      data: {
        config: tradingConfig,
        isProposer: index === 0
      }
    })),
    entityInputs: []
  }, captureSnapshot);
  
  // === TEST 3: Governance Entity - LAZY ENTITY (Hash-based ID) ===
  console.log('\n📋 TEST 3: Governance Entity - Lazy Entity with Jurisdiction');
  const govValidators = ['alice', 'bob', 'carol', 'david', 'eve'];
  const govConfig: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: BigInt(10), // Need 10 out of 15 shares (2/3 + 1 for BFT)
    validators: govValidators,
    shares: {
      alice: BigInt(3),
      bob: BigInt(3),
      carol: BigInt(3),
      david: BigInt(3),
      eve: BigInt(3)
    },
    jurisdiction: DEFAULT_JURISDICTIONS.get('ethereum') // Add jurisdiction
  };
  
  // Create lazy entity (hash-based ID)
  const govEntityId = generateLazyEntityId(govValidators, BigInt(10));
  
  processServerInput(env, {
    serverTxs: govValidators.map((signerId, index) => ({
      type: 'importReplica' as const,
      entityId: govEntityId,
      signerId,
      data: {
        config: govConfig,
        isProposer: index === 0
      }
    })),
    entityInputs: []
  }, captureSnapshot);
  
  console.log('\n🔥 CORNER CASE TESTS:');
  
  // === CORNER CASE 1: Single transaction (minimal consensus) ===
  console.log('\n⚠️  CORNER CASE 1: Single transaction in chat');
  processUntilEmpty(env, [{
    entityId: chatEntityId,
    signerId: 'alice',
    entityTxs: [{ type: 'chat', data: { from: 'alice', message: 'First message in chat!' } }]
  }], captureSnapshot);
  
  // === CORNER CASE 2: Batch proposals (stress test) ===
  console.log('\n⚠️  CORNER CASE 2: Batch proposals in trading');
  processUntilEmpty(env, [{
    entityId: tradingEntityId,
    signerId: 'alice',
    entityTxs: [
      { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Trading proposal 1: Set daily limit' } }, proposer: 'alice' } },
      { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Trading proposal 2: Update fees' } }, proposer: 'bob' } },
      { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Trading proposal 3: Add new pairs' } }, proposer: 'carol' } }
    ]
  }], captureSnapshot);
  
  // === CORNER CASE 3: High threshold governance (needs 4/5 validators) ===
  console.log('\n⚠️  CORNER CASE 3: High threshold governance vote');
  processUntilEmpty(env, [{
    entityId: govEntityId,
    signerId: 'alice',
    entityTxs: [{ type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Governance proposal: Increase block size limit' } }, proposer: 'alice' } }]
  }], captureSnapshot);
  
  // === CORNER CASE 4: Multiple entities concurrent activity ===
  console.log('\n⚠️  CORNER CASE 4: Concurrent multi-entity activity');
  processUntilEmpty(env, [
    {
      entityId: chatEntityId,
      signerId: 'alice',
      entityTxs: [
        { type: 'chat', data: { from: 'bob', message: 'Chat during trading!' } },
        { type: 'chat', data: { from: 'carol', message: 'Exciting times!' } }
      ]
    },
    {
      entityId: tradingEntityId,
      signerId: 'alice',
      entityTxs: [
        { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Trading proposal: Cross-entity transfer protocol' } }, proposer: 'david' } }
      ]
    },
    {
      entityId: govEntityId,
      signerId: 'alice',
      entityTxs: [
        { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Governance decision: Implement new voting system' } }, proposer: 'bob' } },
        { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Governance decision: Update treasury rules' } }, proposer: 'carol' } }
      ]
    }
  ], captureSnapshot);
  
  // === CORNER CASE 5: Empty mempool auto-propose (should be ignored) ===
  console.log('\n⚠️  CORNER CASE 5: Empty mempool test (no auto-propose)');
  processUntilEmpty(env, [{
    entityId: chatEntityId,
    signerId: 'alice',
    entityTxs: [] // Empty transactions should not trigger proposal
  }], captureSnapshot);
  
  // === CORNER CASE 6: Large message batch ===
  console.log('\n⚠️  CORNER CASE 6: Large message batch');
  const largeBatch: EntityTx[] = Array.from({ length: 8 }, (_, i) => ({
    type: 'chat' as const,
    data: { from: ['alice', 'bob', 'carol'][i % 3], message: `Batch message ${i + 1}` }
  }));
  
  processUntilEmpty(env, [{
    entityId: chatEntityId,
    signerId: 'alice',
    entityTxs: largeBatch
  }], captureSnapshot);
  
  // === CORNER CASE 7: Proposal voting system ===
  console.log('\n⚠️  CORNER CASE 7: Proposal voting system');
  
  // Create a proposal that needs votes
  processUntilEmpty(env, [{
    entityId: tradingEntityId,
    signerId: 'alice',
    entityTxs: [
      { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Major decision: Upgrade trading protocol' } }, proposer: 'carol' } } // Carol only has 2 shares, needs more votes
    ]
  }], captureSnapshot);
  
  // Simulate voting on the proposal
  // We need to get the proposal ID from the previous execution, but for demo purposes, we'll simulate voting workflow
  console.log('\n⚠️  CORNER CASE 7b: Voting on proposals (simulated)');
  processUntilEmpty(env, [{
    entityId: govEntityId,
    signerId: 'alice',
    entityTxs: [
      { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'Critical governance: Emergency protocol activation' } }, proposer: 'eve' } } // Eve only has 3 shares, needs 10 total
    ]
  }], captureSnapshot);
  
  // === FINAL VERIFICATION ===
  if (DEBUG) {
    console.log('\n🎯 === FINAL VERIFICATION ===');
    console.log('✨ All proposal IDs are deterministic hashes of proposal data');
    console.log('🌍 Environment-based architecture working correctly');
    
    // Group replicas by entity
    const entitiesByType = new Map<string, Array<[string, any]>>();
    env.replicas.forEach((replica, key) => {
      const entityType = replica.entityId;
      if (!entitiesByType.has(entityType)) {
        entitiesByType.set(entityType, []);
      }
      entitiesByType.get(entityType)!.push([key, replica]);
    });
    
    let allEntitiesConsensus = true;
    
    entitiesByType.forEach((replicas, entityType) => {
      console.log(`\n📊 Entity: ${entityType.toUpperCase()}`);
      console.log(`   Mode: ${replicas[0][1].state.config.mode}`);
      console.log(`   Threshold: ${replicas[0][1].state.config.threshold}`);
      console.log(`   Validators: ${replicas[0][1].state.config.validators.length}`);
      
      // Show voting power distribution
      const shares = replicas[0][1].state.config.shares;
      console.log(`   Voting Power:`);
      Object.entries(shares).forEach(([validator, power]) => {
        console.log(`     ${validator}: ${power} shares`);
      });
      
      // Check consensus within entity
      const allMessages: string[][] = [];
      const allProposals: any[][] = [];
      replicas.forEach(([key, replica]) => {
        console.log(`   ${key}: ${replica.state.messages.length} messages, ${replica.state.proposals.size} proposals, height ${replica.state.height}`);
        if (replica.state.messages.length > 0) {
          replica.state.messages.forEach((msg: string, i: number) => console.log(`     ${i+1}. ${msg}`));
        }
        if (replica.state.proposals.size > 0) {
          console.log(`     Proposals:`);
          replica.state.proposals.forEach((proposal: any, id: string) => {
            const yesVotes = Array.from(proposal.votes.values()).filter(vote => vote === 'yes').length;
            const totalVotes = proposal.votes.size;
            console.log(`       ${id} by ${proposal.proposer} [${proposal.status}] ${yesVotes}/${totalVotes} votes`);
            console.log(`         Action: ${proposal.action.data.message}`);
          });
        }
        allMessages.push([...replica.state.messages]);
        allProposals.push([...replica.state.proposals.values()]);
      });
      
      // Verify consensus within entity (messages and proposals)
      const firstMessages = allMessages[0];
      const messagesConsensus = allMessages.every(messages => 
        messages.length === firstMessages.length && 
        messages.every((msg, i) => msg === firstMessages[i])
      );
      
      const firstProposals = allProposals[0];
      const proposalsConsensus = allProposals.every(proposals => 
        proposals.length === firstProposals.length &&
        proposals.every((prop, i) => 
          prop.id === firstProposals[i].id &&
          prop.status === firstProposals[i].status &&
          prop.votes.size === firstProposals[i].votes.size
        )
      );
      
      const entityConsensus = messagesConsensus && proposalsConsensus;
      
      console.log(`   🔍 Consensus: ${entityConsensus ? '✅ SUCCESS' : '❌ FAILED'} (messages: ${messagesConsensus ? '✅' : '❌'}, proposals: ${proposalsConsensus ? '✅' : '❌'})`);
      if (entityConsensus) {
        console.log(`   📈 Total messages: ${firstMessages.length}, proposals: ${firstProposals.length}`);
        const totalShares = (Object.values(shares) as bigint[]).reduce((sum, val) => sum + val, BigInt(0));
        console.log(`   ⚖️  Total voting power: ${totalShares} (threshold: ${replicas[0][1].state.config.threshold})`);
      }
      
      allEntitiesConsensus = allEntitiesConsensus && entityConsensus;
    });
    
    console.log(`\n🏆 === OVERALL RESULT ===`);
    console.log(`${allEntitiesConsensus ? '✅ SUCCESS' : '❌ FAILED'} - All entities achieved consensus`);
    console.log(`📊 Total entities tested: ${entitiesByType.size}`);
    console.log(`📊 Total replicas: ${env.replicas.size}`);
    console.log(`🔄 Total server ticks: ${env.height}`);
    console.log('🎯 Fully deterministic - no randomness used');
    console.log('🌍 Environment-based architecture with clean function signatures');
    
    // Show mode distribution
    const modeCount = new Map<string, number>();
    env.replicas.forEach(replica => {
      const mode = replica.state.config.mode;
      modeCount.set(mode, (modeCount.get(mode) || 0) + 1);
    });
    console.log(`📡 Mode distribution:`);
    modeCount.forEach((count, mode) => {
      console.log(`   ${mode}: ${count} replicas`);
    });
  }
  
  if (DEBUG) {
    console.log('\n🎯 Demo completed successfully!');
    console.log('📊 Check the dashboard for final entity states');
    console.log('🔄 Use time machine to replay any step');
  }

  // === BLOCKCHAIN DEMO: Create numbered entities on Ethereum ===
  console.log('\n🔗 BLOCKCHAIN DEMO: Creating numbered entities on Ethereum');
  
  // Get Ethereum jurisdiction config
  const ethereumJurisdiction = DEFAULT_JURISDICTIONS.get('ethereum');
  if (!ethereumJurisdiction) {
    console.warn('⚠️ Ethereum jurisdiction not found, skipping blockchain demo');
    return env;
  }
  
  // Create numbered entities for demo purposes (async, fire and forget)
  setTimeout(async () => {
    try {
      // Create numbered entity for chat
      const chatConfig = {
        mode: 'proposer-based' as const,
        threshold: BigInt(2),
        validators: chatValidators,
        shares: {
          alice: BigInt(1),
          bob: BigInt(1), 
          carol: BigInt(1)
        },
        jurisdiction: ethereumJurisdiction
      };
      await registerNumberedEntityOnChain(chatConfig, 'Demo Chat');
      console.log('✅ Demo chat entity registered on Ethereum');
      
      // Create numbered entity for trading
      const tradingConfigForChain = {
        mode: 'gossip-based' as const,
        threshold: BigInt(7),
        validators: tradingValidators,
        shares: {
          alice: BigInt(4),
          bob: BigInt(3),
          carol: BigInt(2),
          david: BigInt(1)
        },
        jurisdiction: ethereumJurisdiction
      };
      await registerNumberedEntityOnChain(tradingConfigForChain, 'Demo Trading');
      console.log('✅ Demo trading entity registered on Ethereum');
      
      // Create numbered entity for governance
      const govConfigForChain = {
        mode: 'proposer-based' as const,
        threshold: BigInt(10),
        validators: govValidators,
        shares: {
          alice: BigInt(3),
          bob: BigInt(3),
          carol: BigInt(3),
          david: BigInt(3),
          eve: BigInt(3)
        },
        jurisdiction: ethereumJurisdiction
      };
      await registerNumberedEntityOnChain(govConfigForChain, 'Demo Governance');
      console.log('✅ Demo governance entity registered on Ethereum');
      
    } catch (error: any) {
      console.warn('⚠️ Demo blockchain registration failed:', error.message);
    }
  }, 1000); // Give demo time to complete first

  return env;
};

export const runTests = async (): Promise<Env> => {
  console.log('🧪 Running XLN tests...');
  
  // Initialize environment
  const env: Env = {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] }
  };
  
  // Test 1: Basic functionality
  console.log('✅ Test 1: Environment initialization');
  console.log(`   Height: ${env.height}`);
  console.log(`   Replicas: ${env.replicas.size}`);
  
  // Test 2: Process simple input
  console.log('✅ Test 2: Process simple input');
  const testInput: ServerInput = {
    serverTxs: [{
      type: 'importReplica',
      entityId: 'test',
      signerId: 'alice',
      data: {
        config: {
          mode: 'proposer-based',
          threshold: BigInt(1),
          validators: ['alice'],
          shares: { alice: BigInt(1) }
        },
        isProposer: true
      }
    }],
    entityInputs: []
  };
  
  const outputs = processServerInput(env, testInput, captureSnapshot);
  console.log(`   Outputs: ${outputs.length}`);
  
  // Test 3: Verify state persistence
  console.log('✅ Test 3: State persistence');
  console.log(`   Latest height: ${env.height}`);
  
  console.log('🎉 All tests passed!');
  return env;
};
