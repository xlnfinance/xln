/**
 * Multi-Signer Consensus Test
 *
 * Tests entity-level BFT consensus with multiple validators:
 * - Alice entity: 3-of-4 validators
 * - Hub entity: single validator (hub)
 * - directPayment requires 3 signatures to commit
 *
 * This proves:
 * - Byzantine fault tolerance (1 validator can be offline/malicious)
 * - Signature collection and verification
 * - Precommit/commit flow with multiple signers
 * - State transitions with threshold consensus
 *
 * Run with: bun runtime/scenarios/multi-sig.ts
 */

import type { ConsensusConfig, EntityReplica, EntityTx, Env } from '../types';
import { buildEntityTransactionProposalAction, hashEntityProposalAction } from '../entity/authorization';
import { prepareLocallyAuthoredEntityTxs } from '../entity/command';
import { encodeBoard, generateLazyEntityId, generateNumberedEntityId, hashBoard } from '../entity/factory';
import { getEntityLeaderState } from '../entity/consensus/leader';
import {
  bindScenarioJReplica,
  ensureJAdapter,
  getJAdapterMode,
  createJReplica,
  createJurisdictionConfig,
  resolveScenarioBoardSigner,
} from './boot';
import {
  findReplica,
  assert,
  processWithOffline,
  convergeWithOffline,
  enableStrictScenario,
  ensureSignerKeysFromSeed,
  requireRuntimeSeed,
  processJEvents,
  syncChain,
  commitRuntimeInput,
} from './helpers';

const USDC = 1;
const ONE = 10n ** 18n;
const usd = (amount: number | bigint) => BigInt(amount) * ONE;

const hasFinalizedHankoBatch = (replica: EntityReplica): boolean =>
  (replica.state.jBlockChain || []).some(block =>
    (block.events || []).some(event => event.type === 'HankoBatchProcessed'),
  );

const importBoardReplicas = (entityId: string, config: ConsensusConfig, x: number) =>
  config.validators.map((signerId, index) => ({
    type: 'importReplica' as const,
    entityId,
    signerId,
    data: {
      isProposer: index === 0,
      position: { x: x + index * 20, y: 0, z: 0 },
      config,
    },
  }));

type GovernanceVote = readonly [signerId: string, choice: 'yes' | 'no'];

const requireReplica = (env: Env, entityId: string, signerId: string): EntityReplica => {
  const replica = env.eReplicas.get(`${entityId}:${signerId}`);
  if (!replica) throw new Error(`MULTISIG_REPLICA_MISSING:${entityId}:${signerId}`);
  return replica;
};

const assertGovernanceProposal = (
  env: Env,
  entityId: string,
  validators: string[],
  offlineSigners: Set<string>,
  proposalId: string,
  expectedStatus: 'pending' | 'executed' | 'rejected',
  expectedVotes: GovernanceVote[],
): void => {
  for (const signerId of validators.filter(validator => !offlineSigners.has(validator))) {
    const proposal = requireReplica(env, entityId, signerId).state.proposals.get(proposalId);
    assert(
      proposal?.status === expectedStatus,
      `${signerId} sees governance proposal ${proposalId.slice(0, 14)} as ${expectedStatus}`,
      env,
    );
    assert(
      proposal.votes.size === expectedVotes.length,
      `${signerId} sees exactly ${expectedVotes.length} governance votes`,
      env,
    );
    for (const [voter, choice] of expectedVotes) {
      assert(proposal.votes.get(voter) === choice, `${signerId} sees ${voter}'s independent ${choice} vote`, env);
    }
  }
};

const submitCollectiveProposal = async (
  env: Env,
  entityId: string,
  validators: string[],
  proposer: string,
  txs: EntityTx[],
  offlineSigners: Set<string>,
): Promise<string> => {
  const before = new Set(requireReplica(env, entityId, proposer).state.proposals.keys());
  const expectedAction = buildEntityTransactionProposalAction(txs);
  await processWithOffline(env, [{ entityId, signerId: proposer, entityTxs: txs }], offlineSigners);
  await convergeWithOffline(env, offlineSigners, 20, 'governance-proposal');

  const proposals = Array.from(requireReplica(env, entityId, proposer).state.proposals.values()).filter(
    proposal => !before.has(proposal.id),
  );
  assert(proposals.length === 1, `exactly one governance proposal created by ${proposer}`, env);
  const proposal = proposals[0]!;
  assert(
    proposal.actionHash === hashEntityProposalAction(expectedAction),
    'governance proposal commits the exact collective action',
    env,
  );
  assert(
    proposal.action.type === 'entity_transaction' && proposal.action.data.actionHash === expectedAction.data.actionHash,
    'governance proposal commits the exact ordered EntityTx batch',
    env,
  );
  assertGovernanceProposal(env, entityId, validators, offlineSigners, proposal.id, 'pending', [[proposer, 'yes']]);
  return proposal.id;
};

const submitGovernanceVote = async (
  env: Env,
  entityId: string,
  voter: string,
  proposalId: string,
  choice: 'yes' | 'no',
  offlineSigners: Set<string>,
): Promise<void> => {
  const voterReplica = requireReplica(env, entityId, voter);
  const leader = getEntityLeaderState(voterReplica.state).activeValidatorId;
  const signedVote = prepareLocallyAuthoredEntityTxs(env, voterReplica.state, voter, [
    { type: 'vote', data: { proposalId, voter, choice } },
  ]);
  await processWithOffline(
    env,
    [
      {
        entityId,
        signerId: leader,
        entityTxs: signedVote,
      },
    ],
    offlineSigners,
  );
  await convergeWithOffline(env, offlineSigners, 20, `governance-vote-${voter}`);
};

const executeCollectiveWithVotes = async (
  env: Env,
  params: {
    entityId: string;
    validators: string[];
    proposer: string;
    voters: string[];
    txs: EntityTx[];
    offlineSigners: Set<string>;
    assertBeforeQuorum?: () => void;
  },
): Promise<string> => {
  const proposalId = await submitCollectiveProposal(
    env,
    params.entityId,
    params.validators,
    params.proposer,
    params.txs,
    params.offlineSigners,
  );
  const votes: GovernanceVote[] = [[params.proposer, 'yes']];
  params.assertBeforeQuorum?.();
  for (const [index, voter] of params.voters.entries()) {
    await submitGovernanceVote(env, params.entityId, voter, proposalId, 'yes', params.offlineSigners);
    votes.push([voter, 'yes']);
    const expectedStatus = index === params.voters.length - 1 ? 'executed' : 'pending';
    assertGovernanceProposal(
      env,
      params.entityId,
      params.validators,
      params.offlineSigners,
      proposalId,
      expectedStatus,
      votes,
    );
    if (expectedStatus === 'pending') params.assertBeforeQuorum?.();
  }
  return proposalId;
};

const assertReserve = (env: Env, entityId: string, signerIds: string[], expected: bigint, label: string): void => {
  for (const signerId of signerIds) {
    const actual = requireReplica(env, entityId, signerId).state.reserves.get(USDC) ?? 0n;
    assert(actual === expected, `${label}: ${signerId} reserve ${actual} === ${expected}`, env);
  }
};

export async function multiSig(env: Env): Promise<void> {
  const restoreStrict = enableStrictScenario(env, 'Multi-Sig');
  const prevScenarioMode = env.scenarioMode;
  try {
    env.scenarioMode = true; // Deterministic time control
    const { clearSignerKeys } = await import('../account/crypto');
    requireRuntimeSeed(env, 'Multi-Sig');
    const offlineSigners = new Set<string>();

    clearSignerKeys(env);
    const signerAliases = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'];
    ensureSignerKeysFromSeed(env, signerAliases, 'Multi-Sig');
    const signerByAlias = new Map(
      signerAliases.map(alias => [alias, resolveScenarioBoardSigner(env, alias)] as const),
    );
    const signer = (alias: string): string => {
      const resolved = signerByAlias.get(alias);
      if (!resolved) throw new Error(`MULTISIG_SIGNER_ALIAS_UNKNOWN:${alias}`);
      return resolved;
    };
    const equalShares = (validators: string[]): Record<string, bigint> =>
      Object.fromEntries(validators.map(validator => [validator, 1n]));

    if (env.scenarioMode && env.height === 0) {
      env.timestamp = 1;
    }

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('     MULTI-SIGNER CONSENSUS TEST (3-of-4 Validators)          ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // ============================================================================
    // SETUP: JAdapter
    // ============================================================================
    console.log('🏛️  Setting up JAdapter...');
    const jMode = getJAdapterMode();
    const jadapter = await ensureJAdapter(env, jMode);
    bindScenarioJReplica(
      env,
      createJReplica(env, 'MultiSig', jadapter.addresses.depository, { x: 0, y: 600, z: 0 }),
      jadapter,
    );
    jadapter.startWatching(env);
    const jurisdiction = createJurisdictionConfig(
      'MultiSig',
      jadapter.addresses.depository,
      jadapter.addresses.entityProvider,
      jadapter.mode === 'browservm' ? 'browservm://' : process.env['ANVIL_RPC'] || 'http://localhost:8545',
      Number(jadapter.chainId),
    );
    console.log('✅ JAdapter ready\n');

    // ============================================================================
    // SETUP: Create lazy and registered 3-of-4 entities plus a lazy recipient
    // ============================================================================
    console.log('📦 Creating entities...');

    const aliceValidators = ['1', '2', '3', '4'].map(signer);
    const aliceConfig: ConsensusConfig = {
      mode: 'proposer-based' as const,
      threshold: 3n,
      validators: aliceValidators,
      shares: equalShares(aliceValidators),
      jurisdiction,
    };
    const alice = {
      id: generateLazyEntityId(aliceConfig.validators, aliceConfig.threshold, env).toLowerCase(),
      validators: aliceConfig.validators,
    };
    assert(
      alice.id === hashBoard(encodeBoard(aliceConfig, env)).toLowerCase(),
      'lazy entity ID commits exact validator order',
    );

    const hubValidators = [signer('5')];
    const hubConfig: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 1n,
      validators: hubValidators,
      shares: equalShares(hubValidators),
      jurisdiction,
    };
    const hub = {
      id: generateLazyEntityId(hubConfig.validators, hubConfig.threshold, env).toLowerCase(),
      validators: hubConfig.validators,
      signer: hubValidators[0]!,
    };

    const registeredValidators = ['6', '7', '8', '9'].map(signer);
    const registeredConfig: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 3n,
      validators: registeredValidators,
      shares: equalShares(registeredValidators),
      jurisdiction,
    };
    const registeredBoardHash = hashBoard(encodeBoard(registeredConfig, env));
    const nextEntityNumber = await jadapter.entityProvider.nextNumber();
    const registration = await jadapter.entityProvider.registerNumberedEntity(registeredBoardHash);
    const registrationReceipt = await registration.wait();
    assert(registrationReceipt?.status === 1, 'numbered multisig board registered on EntityProvider');
    const registered = {
      id: generateNumberedEntityId(Number(nextEntityNumber)).toLowerCase(),
      validators: registeredConfig.validators,
    };

    // Import of a numbered Entity is fail-closed until the watcher has durably
    // observed its EntityProvider board. The transaction receipt is not runtime
    // authority and must never be substituted for the certified J observation.
    await syncChain(env, 3);

    // CRITICAL: Multi-signer requires separate replica for EACH validator
    await commitRuntimeInput(env, {
      runtimeTxs: [
        ...importBoardReplicas(alice.id, aliceConfig, 0),
        ...importBoardReplicas(registered.id, registeredConfig, 100),
        ...importBoardReplicas(hub.id, hubConfig, 220),
      ],
      entityInputs: [],
    });

    // The watcher cursor predates these validator-local replicas. Poll before
    // any Entity wake so every fresh signer backfills from the same trusted tip
    // and no validator can propose against a stale local J view.
    await processJEvents(env);
    await convergeWithOffline(env, offlineSigners, 20, 'post-import-j-history');

    console.log('  ✅ Alice: 3-of-4 validators (1, 2, 3, 4)');
    console.log(`  ✅ Registered: ${registered.id.slice(-8)} with 3-of-4 validators (6, 7, 8, 9)`);
    console.log('  ✅ Hub: lazy single validator\n');

    // ============================================================================
    // SETUP: Entity-level commit under 3-of-4 threshold
    // ============================================================================
    console.log('🏦 Executing entity-level mintReserves under 3-of-4 threshold...');

    await executeCollectiveWithVotes(env, {
      entityId: alice.id,
      validators: alice.validators,
      proposer: alice.validators[0]!,
      voters: [alice.validators[1]!, alice.validators[2]!],
      txs: [{ type: 'mintReserves', data: { tokenId: USDC, amount: usd(1_000) } }],
      offlineSigners,
      assertBeforeQuorum: () =>
        assertReserve(env, alice.id, alice.validators, 0n, 'Alice mint remains unapplied before governance quorum'),
    });
    assertReserve(env, alice.id, alice.validators, usd(1_000), 'Alice governance-approved mint');
    await syncChain(env, 5);

    await executeCollectiveWithVotes(env, {
      entityId: registered.id,
      validators: registered.validators,
      proposer: registered.validators[0]!,
      voters: [registered.validators[1]!, registered.validators[2]!],
      txs: [{ type: 'mintReserves', data: { tokenId: USDC, amount: usd(1_000) } }],
      offlineSigners,
      assertBeforeQuorum: () =>
        assertReserve(
          env,
          registered.id,
          registered.validators,
          0n,
          'Registered mint remains unapplied before governance quorum',
        ),
    });
    assertReserve(env, registered.id, registered.validators, usd(1_000), 'Registered governance-approved mint');
    await syncChain(env, 5);

    console.log('\\n🔍 Checking reserve state across all validators...');
    const setupHeights: number[] = [];
    for (const validator of alice.validators) {
      const key = `${alice.id}:${validator}`;
      const replica = env.eReplicas.get(key);
      const height = replica?.state.height || 0;
      const hasPending = Boolean(replica?.proposal || replica?.lockedFrame || (replica?.mempool.length || 0) > 0);
      const pendingDetails = [
        replica?.proposal ? `proposal=${replica.proposal.hash.slice(0, 10)}` : null,
        replica?.lockedFrame ? `locked=${replica.lockedFrame.hash.slice(0, 10)}` : null,
        replica?.mempool.length ? `mempool=[${replica.mempool.map(tx => tx.type).join(',')}]` : null,
      ]
        .filter(Boolean)
        .join(' ');
      setupHeights.push(height);
      console.log(`  ${validator}: height=${height}, pending=${hasPending ? pendingDetails || 'yes' : 'no'}`);
      assert(height > 0, `Validator ${validator} committed the initial multi-sig entity tx`);
      assert(!hasPending, `Validator ${validator} is idle after the initial multi-sig commit`);
    }

    for (const validator of registered.validators) {
      const replica = env.eReplicas.get(`${registered.id}:${validator}`);
      assert((replica?.state.height || 0) > 0, `Registered validator ${validator} committed initial entity tx`);
      assert(
        (replica?.state.reserves.get(USDC) || 0n) === usd(1_000),
        `Registered validator ${validator} finalized minted reserve`,
      );
    }

    // Both entity forms must authorize a real Depository batch with their 3-of-4 Hanko.
    for (const board of [
      {
        name: 'lazy',
        id: alice.id,
        proposer: alice.validators[0]!,
        voters: [alice.validators[1]!, alice.validators[2]!],
        validators: alice.validators,
        amount: usd(10),
      },
      {
        name: 'registered',
        id: registered.id,
        proposer: registered.validators[0]!,
        voters: [registered.validators[1]!, registered.validators[2]!],
        validators: registered.validators,
        amount: usd(15),
      },
    ]) {
      await executeCollectiveWithVotes(env, {
        entityId: board.id,
        validators: board.validators,
        proposer: board.proposer,
        voters: board.voters,
        txs: [
          { type: 'r2r', data: { toEntityId: hub.id, tokenId: USDC, amount: board.amount } },
          { type: 'j_broadcast', data: {} },
        ],
        offlineSigners,
      });
      await syncChain(env, 8);

      for (const validator of board.validators) {
        const replica = env.eReplicas.get(`${board.id}:${validator}`);
        assert(!!replica, `${board.name} validator ${validator} replica exists`);
        assert(hasFinalizedHankoBatch(replica!), `${board.name} validator ${validator} finalized HankoBatchProcessed`);
        assert(
          !replica!.proposal && !replica!.lockedFrame && replica!.mempool.length === 0,
          `${board.name} validator ${validator} is idle after J finality`,
        );
      }
    }

    // ============================================================================
    // TEST 0: NEGATIVE TEST - Proposer alone can't commit (threshold enforcement)
    // ============================================================================
    console.log('\\n═══════════════════════════════════════════════════════════════');
    console.log('  TEST 0: Negative Test - Threshold Enforcement                ');
    console.log('═══════════════════════════════════════════════════════════════\\n');

    console.log('🔒 Creating isolated 3-of-4 entity for negative test...');
    const testValidators = ['10', '11', '12', '13'].map(signer);
    const testConfig: ConsensusConfig = {
      mode: 'proposer-based' as const,
      threshold: 3n,
      validators: testValidators,
      shares: equalShares(testValidators),
      jurisdiction,
    };
    const testEntity = {
      id: generateLazyEntityId(testConfig.validators, testConfig.threshold, env).toLowerCase(),
      validators: testConfig.validators,
    };

    // All validators commit the proposal frame. Their frame precommits are not
    // governance votes and therefore cannot execute the proposed mint.
    await commitRuntimeInput(env, {
      runtimeTxs: [...importBoardReplicas(testEntity.id, testConfig, 340)],
      entityInputs: [],
    });
    const negativeHeightBefore = requireReplica(env, testEntity.id, testEntity.validators[0]!).state.height;
    const negativeProposalId = await submitCollectiveProposal(
      env,
      testEntity.id,
      testEntity.validators,
      testEntity.validators[0]!,
      [{ type: 'mintReserves', data: { tokenId: USDC, amount: usd(10) } }],
      offlineSigners,
    );
    assert(
      requireReplica(env, testEntity.id, testEntity.validators[0]!).state.height > negativeHeightBefore,
      'proposal frame commits with board precommits',
      env,
    );
    assertReserve(env, testEntity.id, testEntity.validators, 0n, 'proposer vote alone cannot execute collective mint');

    await processWithOffline(env, undefined, offlineSigners);
    await processWithOffline(env, undefined, offlineSigners);
    assertGovernanceProposal(env, testEntity.id, testEntity.validators, offlineSigners, negativeProposalId, 'pending', [
      [testEntity.validators[0]!, 'yes'],
    ]);
    assertReserve(env, testEntity.id, testEntity.validators, 0n, 'Entity frame signatures are not governance votes');

    await submitGovernanceVote(env, testEntity.id, testEntity.validators[1]!, negativeProposalId, 'no', offlineSigners);
    assertGovernanceProposal(env, testEntity.id, testEntity.validators, offlineSigners, negativeProposalId, 'pending', [
      [testEntity.validators[0]!, 'yes'],
      [testEntity.validators[1]!, 'no'],
    ]);
    await submitGovernanceVote(env, testEntity.id, testEntity.validators[2]!, negativeProposalId, 'no', offlineSigners);
    assertGovernanceProposal(
      env,
      testEntity.id,
      testEntity.validators,
      offlineSigners,
      negativeProposalId,
      'rejected',
      [
        [testEntity.validators[0]!, 'yes'],
        [testEntity.validators[1]!, 'no'],
        [testEntity.validators[2]!, 'no'],
      ],
    );
    assertReserve(env, testEntity.id, testEntity.validators, 0n, 'rejected collective mint never mutates reserves');

    console.log('   ✅ Frame quorum committed the proposal without executing it');
    console.log('   ✅ Only signed governance votes reached terminal rejection\\n');
    // ============================================================================
    // TEST 1: Byzantine tolerance (4 offline, 1+2+3 reach threshold on Alice)
    // ============================================================================
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  TEST 1: Byzantine Tolerance (4 offline)                      ');
    console.log('═══════════════════════════════════════════════════════════════\\n');

    console.log('📴 Simulating 4 offline (drop inputs to signer)...');
    const offlineAliceSigner = alice.validators[3]!;
    offlineSigners.add(offlineAliceSigner);
    env.info('network', 'OFFLINE_SIGNER', { signerId: offlineAliceSigner, reason: 'byzantine test' }, alice.id);
    console.log('   4 input delivery disabled\\n');

    console.log('💼 1 proposes: mintReserves with 4 offline (3-of-4 still enough)');
    const heightBeforeOffline = (await findReplica(env, alice.id))[1].state.height;
    const reserveBeforeOffline = requireReplica(env, alice.id, alice.validators[0]!).state.reserves.get(USDC) ?? 0n;

    await executeCollectiveWithVotes(env, {
      entityId: alice.id,
      validators: alice.validators,
      proposer: alice.validators[0]!,
      voters: [alice.validators[1]!, alice.validators[2]!],
      txs: [{ type: 'mintReserves', data: { tokenId: USDC, amount: usd(500) } }],
      offlineSigners,
      assertBeforeQuorum: () =>
        assertReserve(
          env,
          alice.id,
          alice.validators.slice(0, 3),
          reserveBeforeOffline,
          'offline-board mint remains unapplied before governance quorum',
        ),
    });

    const [, s1AfterOffline] = findReplica(env, alice.id);
    assert(
      s1AfterOffline.state.height > heightBeforeOffline,
      `Frame should commit with 3/4 (1+2+3): ${s1AfterOffline.state.height} > ${heightBeforeOffline}`,
    );
    assert(!s1AfterOffline.proposal, 'Proposal should be cleared after commit');

    // Governance execution authorizes and emits the J mint; the reserve changes
    // only after the resulting receipt is independently watched and finalized by
    // Entity consensus. Restore the offline replica before that explicit chain
    // drain so this phase also proves deterministic catch-up from the committed
    // 3-of-4 frame.
    offlineSigners.delete(offlineAliceSigner);
    await syncChain(env, 5);
    assertReserve(
      env,
      alice.id,
      alice.validators,
      reserveBeforeOffline + usd(500),
      'all validators finalize the exact governance-approved mint receipt',
    );
    console.log(
      `   ✅ Frame committed with 4 offline (height ${heightBeforeOffline} → ${s1AfterOffline.state.height})`,
    );
    console.log('   ✅ Restored validator 4 caught up through certified J finality');

    console.log('\\n✅ TEST 1 COMPLETE: Byzantine tolerance proven!\\n');
    console.log('   1 + 2 + 3 = 3/4 threshold ✅');
    console.log('   Commit succeeded without 4 ✅');

    // ============================================================================
    // TEST 2: Post-commit convergence
    // ============================================================================
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  TEST 2: Post-Commit Convergence                             ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('🔄 Draining any remaining entity work...');
    await convergeWithOffline(env, offlineSigners, 20);

    const [, aliceRep3] = findReplica(env, alice.id);
    const finalHeight = aliceRep3.state.height;
    const totalEntityPending = Array.from(env.eReplicas.values()).filter(
      replica => replica.proposal || replica.lockedFrame || replica.mempool.length > 0,
    ).length;

    console.log(`\n📊 Final state:`);
    console.log(`   Alice height: ${finalHeight}`);
    console.log(`   Active entity proposals: ${totalEntityPending}`);
    console.log(`   Hub height: ${env.eReplicas.get(`${hub.id}:${hub.signer}`)?.state.height || 0}`);

    assert(
      finalHeight >= Math.max(...setupHeights) + 1,
      'Alice proposer height advanced after the byzantine-tolerant commit',
    );
    assert(totalEntityPending === 0, 'No entity-level proposals remain after convergence');

    console.log('\n✅ TEST 2 COMPLETE: Multi-sig network converged cleanly after entity commits.\n');

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✅ MULTI-SIGNER CONSENSUS: ALL TESTS PASS');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`📊 Total frames: ${env.history?.length || 0}`);
    console.log('   Entity-level 3-of-4 threshold: ✅');
    console.log('   Lazy + registered on-chain Hanko: ✅');
    console.log('   Proposer alone cannot commit: ✅');
    console.log('   Byzantine tolerance (4 offline): ✅');
    console.log('   Post-commit convergence: ✅');
    console.log('═══════════════════════════════════════════════════════════════\n');
  } finally {
    env.scenarioMode = prevScenarioMode ?? false;
    restoreStrict();
  }
}

if (import.meta.main) {
  const { createEmptyEnv } = await import('../runtime');
  const env = createEmptyEnv(process.env['XLN_RUNTIME_SEED'] ?? process.env['RUNTIME_SEED'] ?? 'multi-sig-cli-seed');
  env.scenarioMode = true;
  await multiSig(env);
}
