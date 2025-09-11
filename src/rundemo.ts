/**
 * XLN Demo Runner
 * Exact 1:1 copy of runDemo function from server.ts
 */

import { DEBUG } from './utils.js';
import { Env, EntityInput, ConsensusConfig, EntityTx, EntityReplica, Proposal, AssetBalance } from './types.js';
import { generateLazyEntityId, generateNumberedEntityId } from './entity-factory.js';
import { registerNumberedEntityOnChain, getJurisdictionByAddress } from './evm.js';
import { applyServerInput, processUntilEmpty } from './server.js';
import { formatEntityDisplay, formatSignerDisplay } from './utils.js';
import { addToReserves } from './entity-tx.js';

// Exact 1:1 copy of runDemo function from server.ts
const runDemo = async (env: Env): Promise<Env> => {
  if (DEBUG) {
    console.log('🚀 Starting XLN Consensus Demo - Multi-Entity Test');
    console.log('✨ Using deterministic hash-based proposal IDs (no randomness)');
    console.log('🌍 Environment-based architecture with merged serverInput');
    console.log('🗑️ History cleared for fresh start');
  }

  const ethereumJurisdiction = await getJurisdictionByAddress('ethereum');
  if (!ethereumJurisdiction) {
    throw new Error('❌ Ethereum jurisdiction not found');
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
      carol: BigInt(1),
    },
    jurisdiction: ethereumJurisdiction, // Add jurisdiction
  };

  // Create numbered entity (blockchain registered)
  const chatEntityId = generateNumberedEntityId(1); // Use entity #1

  await applyServerInput(env, {
    serverTxs: chatValidators.map((signerId, index) => ({
      type: 'importReplica' as const,
      entityId: chatEntityId,
      signerId,
      data: {
        config: chatConfig,
        isProposer: index === 0,
      },
    })),
    entityInputs: [],
  });

  // Store signer-specific reserves before consensus overwrites them
  const signerReserves = new Map<string, Map<string, AssetBalance>>();

  // 💰 Add demo financial data - simulate Depository.sol reserves
  console.log('💰 Adding demo financial reserves to entities...');

  // Add reserves to Alice in chat entity (CompanyA example)
  // await applyServerInput(env, {
  //   serverTxs: [],
  //   entityInputs: [
  //     {
  //       entityId: chatEntityId, // ID сущности Alice
  //       signerId: 'alice', // источник (наблюдатель/валидатор/подписант)
  //       entityTxs: [
  //         {
  //           type: 'j_event',
  //           data: {
  //             from: 'alice',
  //             event: {
  //               type: 'reserveToReserve',
  //               data: {
  //                 asset: 'ETH',
  //                 amount: '10000000000000000000', // 10 ETH
  //                 from: 'alice',
  //               },
  //             },
  //             observedAt: Date.now(),
  //             blockNumber: 1,
  //             transactionHash: '0xDEMO',
  //           },
  //         },
  //       ],
  //     },
  //   ],
  // });

  // const aliceChatReplica = env.replicas.get(`${chatEntityId}:alice`);
  // if (aliceChatReplica) {
  //   addToReserves(aliceChatReplica.state.reserves, 'ETH', 10000000000000000000n, 18); // 10 ETH
  //   addToReserves(aliceChatReplica.state.reserves, 'USDT', 23000000n, 6); // 23 USDT
  //   addToReserves(aliceChatReplica.state.reserves, 'ACME-SHARES', 1235n, 0); // 1235 shares
  //   console.log(`💰 Alice reserves: 10 ETH, 23 USDT, 1235 ACME-SHARES`);

  //   // // Store Alice's reserves
  //   // signerReserves.set('alice', new Map(aliceChatReplica.state.reserves));
  // }

  // Add different reserves to Bob (different portfolio)
  // const bobChatReplica = env.replicas.get(`${chatEntityId}:bob`);
  // if (bobChatReplica) {
  //   addToReserves(bobChatReplica.state.reserves, 'ETH', 5000000000000000000n, 18); // 5 ETH
  //   addToReserves(bobChatReplica.state.reserves, 'USDC', 50000000n, 6); // 50 USDC
  //   addToReserves(bobChatReplica.state.reserves, 'BTC-SHARES', 100n, 8); // 1.00000000 BTC shares
  //   console.log(`💰 Bob reserves: 5 ETH, 50 USDC, 1.00000000 BTC-SHARES`);

  //   // // Store Bob's reserves
  //   // signerReserves.set('bob', new Map(bobChatReplica.state.reserves));
  // }

  // === TEST 2: Trading Entity - NUMBERED ENTITY (Weighted Voting) ===
  console.log('\n📋 TEST 2: Trading Entity - Numbered Entity with Jurisdiction');
  const tradingValidators = ['alice', 'bob', 'carol', 'david'];
  const tradingConfig: ConsensusConfig = {
    mode: 'gossip-based',
    threshold: BigInt(7), // Need 7 out of 10 weighted shares
    validators: tradingValidators,
    shares: {
      alice: BigInt(4), // Weighted voting power
      bob: BigInt(3),
      carol: BigInt(2),
      david: BigInt(1),
    },
    jurisdiction: ethereumJurisdiction, // Add jurisdiction
  };

  // Create numbered entity (blockchain registered)
  const tradingEntityId = generateNumberedEntityId(2); // Use entity #2

  // Note: Governance is now automatically created when entity #2 is registered on-chain
  console.log(`✅ Entity #2 governance automatically created with fixed supply`);
  console.log(`📋 Fixed supply: 1 quadrillion control & dividend tokens (held by entity)`);
  console.log(`🔄 Distribution: Use reserveToReserve() to manually distribute tokens`);

  await applyServerInput(env, {
    serverTxs: tradingValidators.map((signerId, index) => ({
      type: 'importReplica' as const,
      entityId: tradingEntityId,
      signerId,
      data: {
        config: tradingConfig,
        isProposer: index === 0,
      },
    })),
    entityInputs: [],
  });

  // === TEST 3: Governance Entity - LAZY ENTITY (Higher Threshold) ===
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
      eve: BigInt(3),
    },
    jurisdiction: ethereumJurisdiction,
  };

  // Create lazy entity (hash-based ID)
  const govEntityId = generateLazyEntityId(govValidators, BigInt(10));

  await applyServerInput(env, {
    serverTxs: govValidators.map((signerId, index) => ({
      type: 'importReplica' as const,
      entityId: govEntityId,
      signerId,
      data: {
        config: govConfig,
        isProposer: index === 0,
      },
    })),
    entityInputs: [],
  });

  console.log('\n🔥 CORNER CASE TESTS:');

  // === CORNER CASE 0: Single signer entity (should bypass consensus) ===

  // Add single-signer entities for Alice and Bob to test direct execution
  console.log('\n⚠️  CORNER CASE 0: Single signer entity - direct execution');
  const aliceSingleSignerConfig: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: BigInt(1),
    validators: ['alice'],
    shares: { alice: BigInt(1) },
    jurisdiction: ethereumJurisdiction,
  };

  const aliceSingleEntityId = generateLazyEntityId(['alice'], BigInt(1));

  const bobSingleSignerConfig: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: BigInt(1),
    validators: ['bob'],
    shares: { bob: BigInt(1) },
    jurisdiction: ethereumJurisdiction,
  };

  const bobSingleEntityId = generateLazyEntityId(['bob'], BigInt(1));

  await applyServerInput(env, {
    serverTxs: [
      {
        type: 'importReplica' as const,
        entityId: aliceSingleEntityId,
        signerId: 'alice',
        data: {
          config: aliceSingleSignerConfig,
          isProposer: true,
        },
      },
      {
        type: 'importReplica' as const,
        entityId: bobSingleEntityId,
        signerId: 'bob',
        data: {
          config: bobSingleSignerConfig,
          isProposer: true,
        },
      },
    ],
    entityInputs: [],
  });


  await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [
      {
        entityId: aliceSingleEntityId, // ID сущности Alice
        signerId: 'alice', // источник (наблюдатель/валидатор/подписант)
        entityTxs: [
          {
            type: 'j_event',
            data: {
              from: 'alice',
              event: {
                type: 'reserveToReserve',
                data: {
                  asset: 'ETH',
                  amount: '10000000000000000000', // 10 ETH
                  from: 'alice',
                  decimals: 18,
                },
              },
              observedAt: Date.now(),
              blockNumber: 1,
              transactionHash: '0xDEMO',
            },
          },
          {
            type: 'j_event',
            data: {
              from: 'alice',
              event: {
                type: 'reserveToReserve',
                data: {
                  asset: 'USDT',
                  amount: '23000000000000000000', // 23 USDT
                  from: 'alice',
                  decimals: 18,
                },
              },
              observedAt: Date.now(),
              blockNumber: 1,
              transactionHash: '0xDEMO',
            },
          },
          {
            type: 'j_event',
            data: {
              from: 'alice',
              event: {
                type: 'ControlSharesReceived',
                data: {
                  tokenId: 'ACME-SHARES',
                  amount: '1235', // 1235 ACME-SHARES
                  from: 'alice',
                },
              },
              observedAt: Date.now(),
              blockNumber: 1,
              transactionHash: '0xDEMO',
            },
          },
        ],
      },
    ],
  });

  await processUntilEmpty(env, [
    {
      entityId: aliceSingleEntityId,
      signerId: 'alice',
      entityTxs: [{ type: 'chat', data: { from: 'alice', message: 'Single signer test message!' } }],
    },
  ]);

  await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [
      {
        entityId: bobSingleEntityId,
        signerId: 'bob',
        entityTxs: [
          {
            type: 'j_event',
            data: {
              from: 'bob',
              event: {
                type: 'reserveToReserve',
                data: {
                  asset: 'ETH',
                  amount: '5000000000000000000', // 5 ETH
                  from: 'bob',
                  decimals: 18,
                },
              },
              observedAt: Date.now(),
              blockNumber: 1,
              transactionHash: '0xDEMO',
            },
          },
          {
            type: 'j_event',
            data: {
              from: 'bob',
              event: {
                type: 'reserveToReserve',
                data: {
                  asset: 'USDC',
                  amount: '50000000000000000000', // 50 USDC
                  from: 'bob',
                  decimals: 18,
                },
              },
              observedAt: Date.now(),
              blockNumber: 1,
              transactionHash: '0xDEMO',
            },
          },
          {
            type: 'j_event',
            data: {
              from: 'bob',
              event: {
                type: 'ControlSharesReceived',
                data: {
                  tokenId: 'BTC-SHARES',
                  amount: '100', // 100 BTC-SHARES
                  from: 'bob',
                },
              },
              observedAt: Date.now(),
              blockNumber: 1,
              transactionHash: '0xDEMO',
            },
          },
        ],
      },
    ],
  });

  // === CORNER CASE 1: Single transaction (minimal consensus) ===
  console.log('\n⚠️  CORNER CASE 1: Single transaction in chat');
  await processUntilEmpty(env, [
    {
      entityId: chatEntityId,
      signerId: 'alice',
      entityTxs: [{ type: 'chat', data: { from: 'alice', message: 'First message in chat!' } }],
    },
  ]);

  // === CORNER CASE 2: Batch proposals (stress test) ===
  console.log('\n⚠️  CORNER CASE 2: Batch proposals in trading');
  await processUntilEmpty(env, [
    {
      entityId: tradingEntityId,
      signerId: 'alice',
      entityTxs: [
        {
          type: 'propose',
          data: {
            action: { type: 'collective_message', data: { message: 'Trading proposal 1: Set daily limit' } },
            proposer: 'alice',
          },
        },
        {
          type: 'propose',
          data: {
            action: { type: 'collective_message', data: { message: 'Trading proposal 2: Update fees' } },
            proposer: 'bob',
          },
        },
        {
          type: 'propose',
          data: {
            action: { type: 'collective_message', data: { message: 'Trading proposal 3: Add new pairs' } },
            proposer: 'carol',
          },
        },
      ],
    },
  ]);

  // === CORNER CASE 3: High threshold governance (needs 4/5 validators) ===
  console.log('\n⚠️  CORNER CASE 3: High threshold governance vote');
  await processUntilEmpty(env, [
    {
      entityId: govEntityId,
      signerId: 'alice',
      entityTxs: [
        {
          type: 'propose',
          data: {
            action: { type: 'collective_message', data: { message: 'Governance proposal: Increase block size limit' } },
            proposer: 'alice',
          },
        },
      ],
    },
  ]);

  // === CORNER CASE 4: Multiple entities concurrent activity ===
  console.log('\n⚠️  CORNER CASE 4: Concurrent multi-entity activity');
  await processUntilEmpty(env, [
    {
      entityId: chatEntityId,
      signerId: 'alice',
      entityTxs: [
        { type: 'chat', data: { from: 'bob', message: 'Chat during trading!' } },
        { type: 'chat', data: { from: 'carol', message: 'Exciting times!' } },
      ],
    },
    {
      entityId: tradingEntityId,
      signerId: 'alice',
      entityTxs: [
        {
          type: 'propose',
          data: {
            action: {
              type: 'collective_message',
              data: { message: 'Trading proposal: Cross-entity transfer protocol' },
            },
            proposer: 'david',
          },
        },
      ],
    },
    {
      entityId: govEntityId,
      signerId: 'alice',
      entityTxs: [
        {
          type: 'propose',
          data: {
            action: {
              type: 'collective_message',
              data: { message: 'Governance decision: Implement new voting system' },
            },
            proposer: 'bob',
          },
        },
        {
          type: 'propose',
          data: {
            action: { type: 'collective_message', data: { message: 'Governance decision: Update treasury rules' } },
            proposer: 'carol',
          },
        },
      ],
    },
  ]);

  // === CORNER CASE 5: Empty mempool auto-propose (should be ignored) ===
  console.log('\n⚠️  CORNER CASE 5: Empty mempool test (no auto-propose)');
  await processUntilEmpty(env, [
    {
      entityId: chatEntityId,
      signerId: 'alice',
      entityTxs: [], // Empty transactions should not trigger proposal
    },
  ]);

  // === CORNER CASE 6: Large message batch ===
  console.log('\n⚠️  CORNER CASE 6: Large message batch');
  const largeBatch: EntityTx[] = Array.from({ length: 8 }, (_, i) => ({
    type: 'chat' as const,
    data: { from: ['alice', 'bob', 'carol'][i % 3], message: `Batch message ${i + 1}` },
  }));

  await processUntilEmpty(env, [
    {
      entityId: chatEntityId,
      signerId: 'alice',
      entityTxs: largeBatch,
    },
  ]);

  // === CORNER CASE 7: Proposal voting system ===
  console.log('\n⚠️  CORNER CASE 7: Proposal voting system');

  // Create a proposal that needs votes
  await processUntilEmpty(env, [
    {
      entityId: tradingEntityId,
      signerId: 'alice',
      entityTxs: [
        {
          type: 'propose',
          data: {
            action: { type: 'collective_message', data: { message: 'Major decision: Upgrade trading protocol' } },
            proposer: 'carol',
          },
        }, // Carol only has 2 shares, needs more votes
      ],
    },
  ]);

  // Simulate voting on the proposal
  // We need to get the proposal ID from the previous execution, but for demo purposes, we'll simulate voting workflow
  console.log('\n⚠️  CORNER CASE 7b: Voting on proposals (simulated)');
  await processUntilEmpty(env, [
    {
      entityId: govEntityId,
      signerId: 'alice',
      entityTxs: [
        {
          type: 'propose',
          data: {
            action: {
              type: 'collective_message',
              data: { message: 'Critical governance: Emergency protocol activation' },
            },
            proposer: 'eve',
          },
        }, // Eve only has 3 shares, needs 10 total
      ],
    },
  ]);

  // === RESTORE SIGNER-SPECIFIC RESERVES AFTER CONSENSUS ===
  console.log('\n💰 Restoring signer-specific reserves after consensus...');

  // // Restore Alice's reserves
  // const finalAliceReplica = env.replicas.get(`${chatEntityId}:alice`);
  // if (finalAliceReplica && signerReserves.has('alice')) {
  //   finalAliceReplica.state.reserves = signerReserves.get('alice')!;
  //   console.log(`✅ Restored Alice's reserves: 10 ETH, 23 USDT, 1235 ACME-SHARES`);
  // }

  // // Restore Bob's reserves
  // const finalBobReplica = env.replicas.get(`${chatEntityId}:bob`);
  // if (finalBobReplica && signerReserves.has('bob')) {
  //   finalBobReplica.state.reserves = signerReserves.get('bob')!;
  //   console.log(`✅ Restored Bob's reserves: 5 ETH, 50 USDC, 100 BTC-SHARES`);
  // }

  // === FINAL VERIFICATION ===
  if (DEBUG) {
    console.log('\n🎯 === FINAL VERIFICATION ===');
    console.log('✨ All proposal IDs are deterministic hashes of proposal data');
    console.log('🌍 Environment-based architecture working correctly');

    // Group replicas by entity
    const entitiesByType = new Map<string, Array<[string, EntityReplica]>>();
    env.replicas.forEach((replica, key) => {
      const entityType = replica.entityId;
      if (!entitiesByType.has(entityType)) {
        entitiesByType.set(entityType, []);
      }
      entitiesByType.get(entityType)!.push([key, replica]);
    });

    let allEntitiesConsensus = true;

    entitiesByType.forEach((replicas, entityType) => {
      const displayName = formatEntityDisplay(entityType);
      console.log(`\n📊 Entity #${displayName}`);
      console.log(`   Mode: ${replicas[0][1].state.config.mode}`);
      console.log(`   Threshold: ${replicas[0][1].state.config.threshold}`);
      console.log(`   Validators: ${replicas[0][1].state.config.validators.length}`);

      // Show voting power distribution
      const shares = replicas[0][1].state.config.shares;
      console.log(`   Voting Power:`);
      Object.entries(shares).forEach(([validator, power]) => {
        console.log(`     ${formatSignerDisplay(validator)}: ${power} shares`);
      });

      // Check consensus within entity
      const allMessages: string[][] = [];
      const allProposals: Proposal[][] = [];
      replicas.forEach(([key, replica]) => {
        console.log(
          `   ${key}: ${replica.state.messages.length} messages, ${replica.state.proposals.size} proposals, height ${replica.state.height}`,
        );
        if (replica.state.messages.length > 0) {
          replica.state.messages.forEach((msg, i) => console.log(`     ${i + 1}. ${msg}`));
        }
        if (replica.state.proposals.size > 0) {
          console.log(`     Proposals:`);
          replica.state.proposals.forEach((proposal, id) => {
            const yesVotes = Array.from(proposal.votes.values()).filter((vote) => vote === 'yes').length;
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
      const messagesConsensus = allMessages.every(
        (messages) => messages.length === firstMessages.length && messages.every((msg, i) => msg === firstMessages[i]),
      );

      const firstProposals = allProposals[0];
      const proposalsConsensus = allProposals.every(
        (proposals) =>
          proposals.length === firstProposals.length &&
          proposals.every(
            (prop, i) =>
              prop.id === firstProposals[i].id &&
              prop.status === firstProposals[i].status &&
              prop.votes.size === firstProposals[i].votes.size,
          ),
      );

      const entityConsensus = messagesConsensus && proposalsConsensus;

      console.log(
        `   🔍 Consensus: ${entityConsensus ? '✅ SUCCESS' : '❌ FAILED'} (messages: ${messagesConsensus ? '✅' : '❌'}, proposals: ${proposalsConsensus ? '✅' : '❌'})`,
      );
      if (entityConsensus) {
        console.log(`   📈 Total messages: ${firstMessages.length}, proposals: ${firstProposals.length}`);
        const totalShares = Object.values(shares).reduce((sum, val) => sum + val, BigInt(0));
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
    env.replicas.forEach((replica) => {
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
  const ethJurisdiction = await getJurisdictionByAddress('ethereum');
  if (!ethJurisdiction) {
    throw new Error('❌ Ethereum jurisdiction not found - deployment failed');
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
          carol: BigInt(1),
        },
        jurisdiction: ethJurisdiction,
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
          david: BigInt(1),
        },
        jurisdiction: ethJurisdiction,
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
          eve: BigInt(3),
        },
        jurisdiction: ethJurisdiction,
      };
      await registerNumberedEntityOnChain(govConfigForChain, 'Demo Governance');
      console.log('✅ Demo governance entity registered on Ethereum');
    } catch (error: any) {
      console.error('❌ Demo blockchain registration failed:', error.message);
      throw error;
    }
  }, 1000); // Give demo time to complete first

  return env;
};

export { runDemo };
