import { describe, expect, test } from 'bun:test';

import {
  buildEntityLeaderVoteBody,
  hashEntityLeaderVoteBody,
  getEntityLeaderOrder,
  getEntityLeaderState,
  getEntityLeaderTimeoutMs,
  getEntityQuorumSafetyWarning,
  getNextEntityFallbackLeader,
} from '../entity/consensus/leader';
import { signAccountFrame, verifyAccountSignature } from '../account/crypto';
import { applyEntityInput } from '../entity/consensus';
import { applyEntityFrame } from '../entity/consensus';
import { createEntityFrameHash } from '../entity/consensus/frame';
import { buildEntityHashesToSign } from '../entity/consensus/hanko-witness';
import { createDueScheduledWakeInputs, refreshScheduledWakeIndex } from '../machine/scheduled-wake';
import { createEmptyEnv } from '../runtime';
import type { ConsensusConfig, EntityReplica, EntityState, ProposedEntityFrame } from '../types';
import { validateConsensusConfig, validateEntityInput, validateEntityReplica } from '../validation-utils';

const config = (threshold = 10n): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold,
  validators: ['ceo', 'alice', 'bob', 'carol'],
  shares: { ceo: 1n, alice: 3n, bob: 5n, carol: 5n },
});

const state = (leaderState?: EntityState['leaderState']): EntityState => ({
  entityId: 'entity',
  height: 7,
  timestamp: 1_000,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: config(),
  prevFrameHash: '0xframe7',
  leaderState,
  reserves: new Map(),
  accounts: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  entityEncPubKey: 'pub',
  entityEncPrivKey: 'priv',
  profile: { name: '', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
});

describe('entity leader policy', () => {
  test('keeps validators[0] as CEO and sorts only fallback validators by stake', () => {
    expect(getEntityLeaderOrder(config())).toEqual(['ceo', 'bob', 'carol', 'alice']);
    expect(getEntityLeaderState(state()).activeValidatorId).toBe('ceo');
    expect(getNextEntityFallbackLeader(state())).toBe('bob');
  });

  test('never returns automatically to CEO after failover', () => {
    expect(getNextEntityFallbackLeader(state({ activeValidatorId: 'bob', view: 1, changedAtHeight: 8 }))).toBe('carol');
    expect(getNextEntityFallbackLeader(state({ activeValidatorId: 'alice', view: 3, changedAtHeight: 10 }))).toBe('bob');
  });

  test('builds the exact next-height view-change vote body', () => {
    expect(buildEntityLeaderVoteBody(state())).toEqual({
      entityId: 'entity',
      targetHeight: 8,
      previousFrameHash: '0xframe7',
      fromView: 0,
      toView: 1,
      previousLeaderId: 'ceo',
      nextLeaderId: 'bob',
    });
  });

  test('accepts a leader-timeout vote as a standalone routed entity input', () => {
    const vote = {
      ...buildEntityLeaderVoteBody(state()),
      voterId: 'alice',
      signature: '',
    };
    expect(validateEntityInput({
      entityId: state().entityId,
      signerId: 'alice',
      leaderTimeoutVote: vote,
    }).leaderTimeoutVote).toEqual(vote);
  });

  test('uses linear timeout backoff capped at sixty seconds', () => {
    expect([1, 2, 3, 8].map(getEntityLeaderTimeoutMs)).toEqual([10_000, 20_000, 30_000, 60_000]);
  });

  test('reports weak boards and rejects an exact two-thirds mainnet quorum', () => {
    expect(getEntityQuorumSafetyWarning(config(7n))).toContain('ENTITY_BOARD_LOW_QUORUM_SAFETY');
    expect(getEntityQuorumSafetyWarning(config(10n))).toBeNull();
    expect(() => validateConsensusConfig(config(7n))).toThrow('strictly greater than two-thirds');
  });

  test('rejects malformed persisted leader certificates at the decode boundary', () => {
    const replica: EntityReplica = {
      entityId: 'entity',
      signerId: 'ceo',
      state: state(),
      mempool: [],
      isProposer: true,
      pendingLeaderCertificate: {
        ...buildEntityLeaderVoteBody(state()),
        votes: new Map(),
      },
    };
    expect(() => validateEntityReplica(replica)).toThrow('votes cannot be empty');
  });

  test('certifies fallback leader from signed timeout votes and lets it propose', async () => {
    const env = createEmptyEnv('entity-leader-failover');
    env.scenarioMode = true;
    env.timestamp = 10_000;
    const board: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 3n,
      validators: ['1', '2', '3', '4'],
      shares: { '1': 1n, '2': 1n, '3': 1n, '4': 1n },
    };
    const base = state();
    base.entityId = '9';
    base.height = 0;
    base.timestamp = 0;
    base.prevFrameHash = undefined;
    base.config = board;
    const command = {
      type: 'chat' as const,
      data: { from: '2', message: 'fallback leader command' },
    };
    const replicas = new Map<string, EntityReplica>();
    for (const signerId of board.validators) {
      replicas.set(signerId, {
        entityId: base.entityId,
        signerId,
        state: structuredClone(base),
        mempool: signerId === '1' ? [] : [command],
        isProposer: signerId === '1',
        lastConsensusProgressAt: 0,
      });
    }
    env.eReplicas = new Map(Array.from(replicas.entries()).map(([signerId, replica]) => [
      `${base.entityId}:${signerId}`,
      replica,
    ]));
    refreshScheduledWakeIndex(env);

    const timeoutInputs = createDueScheduledWakeInputs(env, env.timestamp);
    const vote2 = timeoutInputs.find(input => input.signerId === '2');
    const vote3 = timeoutInputs.find(input => input.signerId === '3');
    const vote4 = timeoutInputs.find(input => input.signerId === '4');
    expect(vote2?.leaderTimeoutVote?.nextLeaderId).toBe('2');
    expect(vote3?.leaderTimeoutVote?.nextLeaderId).toBe('2');

    const ownVoteResult = await applyEntityInput(env, replicas.get('2')!, vote2!);
    const voteFrom3 = await applyEntityInput(env, replicas.get('3')!, vote3!);
    const voteFrom4 = await applyEntityInput(env, replicas.get('4')!, vote4!);
    expect(ownVoteResult.outcome.kind).toBe('committed');
    expect(voteFrom3.outcome.kind).toBe('committed');
    const deliveredVote3 = voteFrom3.outputs.find(output => output.signerId === '2');
    expect(deliveredVote3?.leaderTimeoutVote?.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(verifyAccountSignature(
      env,
      '3',
      hashEntityLeaderVoteBody(deliveredVote3!.leaderTimeoutVote!),
      deliveredVote3!.leaderTimeoutVote!.signature,
    )).toBe(true);

    const withTwoVotes = await applyEntityInput(env, ownVoteResult.workingReplica, deliveredVote3!);
    const deliveredVote4 = voteFrom4.outputs.find(output => output.signerId === '2');
    const certified = await applyEntityInput(env, withTwoVotes.workingReplica, deliveredVote4!);
    expect(certified.outcome.kind).toBe('committed');
    expect(certified.workingReplica.leaderVotes?.size).toBe(3);
    expect(certified.workingReplica.pendingLeaderCertificate?.nextLeaderId).toBe('2');
    expect(certified.workingReplica.proposal?.leader).toMatchObject({ proposerSignerId: '2', view: 1 });
    expect(certified.workingReplica.proposal?.newState.leaderState).toEqual({
      activeValidatorId: '2',
      view: 1,
      changedAtHeight: 1,
    });
  });

  test('ignores a delayed committed proposal without replacing the next proposal', async () => {
    const env = createEmptyEnv('entity-stale-proposal');
    env.scenarioMode = true;
    env.timestamp = 2_000;
    const committedHash = `0x${'11'.repeat(32)}`;
    const nextHash = `0x${'22'.repeat(32)}`;
    const committedState = state();
    committedState.entityId = '9';
    committedState.height = 1;
    committedState.prevFrameHash = committedHash;
    const staleFrame: ProposedEntityFrame = {
      height: 1,
      txs: [],
      hash: committedHash,
      newState: structuredClone(committedState),
      leader: { proposerSignerId: 'ceo', view: 0 },
    };
    const nextFrame: ProposedEntityFrame = {
      height: 2,
      txs: [],
      hash: nextHash,
      newState: { ...structuredClone(committedState), height: 2 },
      leader: { proposerSignerId: 'ceo', view: 0 },
    };
    const replica: EntityReplica = {
      entityId: committedState.entityId,
      signerId: 'ceo',
      state: committedState,
      mempool: [],
      proposal: nextFrame,
      isProposer: true,
    };

    const result = await applyEntityInput(env, replica, {
      entityId: committedState.entityId,
      signerId: 'ceo',
      proposedFrame: staleFrame,
    });

    expect(result.outcome).toEqual({ kind: 'noop', reason: 'PROPOSAL_ALREADY_COMMITTED' });
    expect(result.workingReplica.state.height).toBe(1);
    expect(result.workingReplica.proposal?.hash).toBe(nextHash);
  });

  test('re-proposes the locked prepared frame instead of signing a conflicting failover frame', async () => {
    const env = createEmptyEnv('entity-prepared-failover');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 20_000;
    const board: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 3n,
      validators: ['1', '2', '3', '4'],
      shares: { '1': 1n, '2': 1n, '3': 1n, '4': 1n },
    };
    const base = state();
    base.entityId = '9';
    base.height = 0;
    base.timestamp = 0;
    base.prevFrameHash = undefined;
    base.config = board;
    const preparedTimestamp = 10_000;
    const preparedResult = await applyEntityFrame(env, base, [], preparedTimestamp);
    const preparedState: EntityState = {
      ...preparedResult.newState,
      entityId: base.entityId,
      height: 1,
      timestamp: preparedTimestamp,
      leaderState: getEntityLeaderState(base),
    };
    const preparedHash = await createEntityFrameHash('genesis', 1, preparedTimestamp, [], preparedState);
    const preparedManifest = buildEntityHashesToSign(
      base.entityId,
      1,
      preparedHash,
      preparedResult.collectedHashes,
    );
    const prepared: ProposedEntityFrame = {
      height: 1,
      txs: [],
      hash: preparedHash,
      newState: preparedState,
      leader: { proposerSignerId: '1', view: 0 },
      outputs: preparedResult.outputs,
      jOutputs: preparedResult.jOutputs,
      hashesToSign: preparedManifest,
      collectedSigs: new Map([
        ['1', preparedManifest.map(({ hash }) => signAccountFrame(env, '1', hash))],
        ['2', preparedManifest.map(({ hash }) => signAccountFrame(env, '2', hash))],
        ['3', preparedManifest.map(({ hash }) => signAccountFrame(env, '3', hash))],
      ]),
    };
    const withPreparedSigners = (...signers: string[]): ProposedEntityFrame => ({
      ...structuredClone(prepared),
      collectedSigs: new Map(signers.map(signerId => [
        signerId,
        prepared.collectedSigs!.get(signerId)!,
      ])),
    });
    const replica: EntityReplica = {
      entityId: base.entityId,
      signerId: '2',
      state: structuredClone(base),
      mempool: [{ type: 'chat', data: { from: '2', message: 'must not create F1' } }],
      lockedFrame: withPreparedSigners('1', '2'),
      validatorComputedState: structuredClone(prepared.newState),
      isProposer: false,
      lastConsensusProgressAt: 0,
    };
    env.eReplicas.set(`${base.entityId}:2`, replica);
    refreshScheduledWakeIndex(env);
    const preparedTimeout = createDueScheduledWakeInputs(env, env.timestamp)
      .find(input => input.signerId === '2');
    expect(preparedTimeout?.leaderTimeoutVote?.preparedFrame?.hash).toBe(preparedHash);
    expect(preparedTimeout?.leaderTimeoutVote?.preparedFrame?.collectedSigs?.size).toBe(2);
    const commonVote = buildEntityLeaderVoteBody(base);
    const vote2 = {
      ...commonVote,
      voterId: '2',
      preparedFrame: withPreparedSigners('1', '2'),
      signature: '',
    };
    vote2.signature = signAccountFrame(env, '2', hashEntityLeaderVoteBody(vote2));
    const vote3 = {
      ...commonVote,
      voterId: '3',
      preparedFrame: withPreparedSigners('1', '3'),
      signature: '',
    };
    vote3.signature = signAccountFrame(env, '3', hashEntityLeaderVoteBody(vote3));
    const vote4 = {
      ...commonVote,
      voterId: '4',
      preparedFrame: withPreparedSigners('2', '3'),
      signature: '',
    };
    vote4.signature = signAccountFrame(env, '4', hashEntityLeaderVoteBody(vote4));

    const conflictingTimestamp = preparedTimestamp + 1;
    const conflictingResult = await applyEntityFrame(env, base, [], conflictingTimestamp);
    const conflictingState: EntityState = {
      ...conflictingResult.newState,
      entityId: base.entityId,
      height: 1,
      timestamp: conflictingTimestamp,
      leaderState: getEntityLeaderState(base),
    };
    const conflictingHash = await createEntityFrameHash(
      'genesis',
      1,
      conflictingTimestamp,
      [],
      conflictingState,
    );
    const conflictingManifest = buildEntityHashesToSign(
      base.entityId,
      1,
      conflictingHash,
      conflictingResult.collectedHashes,
    );
    const conflictingPrepared: ProposedEntityFrame = {
      height: 1,
      txs: [],
      hash: conflictingHash,
      newState: conflictingState,
      leader: { proposerSignerId: '1', view: 0 },
      outputs: conflictingResult.outputs,
      jOutputs: conflictingResult.jOutputs,
      hashesToSign: conflictingManifest,
      collectedSigs: new Map(['1', '2', '3'].map(signerId => [
        signerId,
        conflictingManifest.map(({ hash }) => signAccountFrame(env, signerId, hash)),
      ])),
    };
    const fullPrepared = withPreparedSigners('1', '2', '3');
    const conflictVotes = [
      { ...commonVote, voterId: '2', preparedFrame: fullPrepared, signature: '' },
      { ...commonVote, voterId: '3', preparedFrame: conflictingPrepared, signature: '' },
      { ...commonVote, voterId: '4', signature: '' },
    ];
    for (const conflictVote of conflictVotes) {
      conflictVote.signature = signAccountFrame(
        env,
        conflictVote.voterId,
        hashEntityLeaderVoteBody(conflictVote),
      );
    }
    let conflictAttempt = { workingReplica: structuredClone(replica) };
    for (const conflictVote of conflictVotes) {
      conflictAttempt = await applyEntityInput(env, conflictAttempt.workingReplica, {
        entityId: base.entityId,
        signerId: '2',
        leaderTimeoutVote: conflictVote,
      });
    }
    expect(conflictAttempt.outcome).toEqual({
      kind: 'rejected',
      code: 'LEADER_PREPARED_CERTIFICATE_REJECTED',
    });
    expect(conflictAttempt.workingReplica.state.height).toBe(0);
    expect(conflictAttempt.workingReplica.pendingLeaderCertificate).toBeUndefined();

    const first = await applyEntityInput(env, replica, {
      entityId: base.entityId,
      signerId: '2',
      leaderTimeoutVote: vote2,
    });
    const duplicate = await applyEntityInput(env, first.workingReplica, {
      entityId: base.entityId,
      signerId: '2',
      leaderTimeoutVote: structuredClone(vote2),
    });
    expect(duplicate.workingReplica.leaderVotes?.size).toBe(1);
    const second = await applyEntityInput(env, duplicate.workingReplica, {
      entityId: base.entityId,
      signerId: '2',
      leaderTimeoutVote: vote3,
    });
    const certified = await applyEntityInput(env, second.workingReplica, {
      entityId: base.entityId,
      signerId: '2',
      leaderTimeoutVote: vote4,
    });

    expect(certified.workingReplica.state.height).toBe(1);
    expect(certified.workingReplica.pendingLeaderCertificate?.preparedFrameHash).toBe(preparedHash);
    expect(certified.outputs.some(output => output.proposedFrame?.hash === preparedHash)).toBe(true);
    expect(certified.workingReplica.state.leaderState).toEqual(getEntityLeaderState(base));
    expect(await createEntityFrameHash(
      'genesis',
      1,
      preparedTimestamp,
      [],
      certified.workingReplica.state,
    )).toBe(preparedHash);

    let reordered = { workingReplica: structuredClone(replica) };
    for (const vote of [vote4, vote2, vote3]) {
      reordered = await applyEntityInput(env, reordered.workingReplica, {
        entityId: base.entityId,
        signerId: '2',
        leaderTimeoutVote: structuredClone(vote),
      });
    }
    expect(reordered.workingReplica.state.prevFrameHash).toBe(preparedHash);
    expect(reordered.workingReplica.pendingLeaderCertificate?.preparedFrameHash).toBe(preparedHash);
    expect(Array.from(reordered.workingReplica.pendingLeaderCertificate?.votes.keys() ?? []))
      .toEqual(['2', '3', '4']);
    expect(Array.from(certified.workingReplica.pendingLeaderCertificate?.votes.keys() ?? []))
      .toEqual(['2', '3', '4']);

    const restored = validateEntityReplica(structuredClone(certified.workingReplica));
    expect(restored.pendingLeaderCertificate?.preparedFrameHash).toBe(preparedHash);
    const transitionBody = buildEntityLeaderVoteBody(restored.state);
    let transition = { ...certified, workingReplica: restored };
    for (const voterId of ['2', '3', '4']) {
      const transitionVote = {
        ...transitionBody,
        voterId,
        signature: '',
      };
      transitionVote.signature = signAccountFrame(env, voterId, hashEntityLeaderVoteBody(transitionVote));
      transition = await applyEntityInput(env, transition.workingReplica, {
        entityId: base.entityId,
        signerId: '2',
        leaderTimeoutVote: transitionVote,
      });
    }
    const transitionProposal = transition.workingReplica.proposal;
    if (!transitionProposal?.hashesToSign) throw new Error('TEST_LEADER_TRANSITION_PROPOSAL_MISSING');
    expect(transitionProposal.height).toBe(2);
    expect(transitionProposal.newState.leaderState).toEqual({
      activeValidatorId: '2',
      view: 1,
      changedAtHeight: 2,
    });
    for (const signerId of ['3', '4']) {
      transition = await applyEntityInput(env, transition.workingReplica, {
        entityId: base.entityId,
        signerId: '2',
        hashPrecommits: new Map([[
          signerId,
          transitionProposal.hashesToSign.map(({ hash }) => signAccountFrame(env, signerId, hash)),
        ]]),
      });
    }
    expect(transition.workingReplica.state.height).toBe(2);
    expect(transition.workingReplica.state.leaderState?.activeValidatorId).toBe('2');
    const heightTwoHash = transition.workingReplica.state.prevFrameHash;
    const delayedOldCommit = await applyEntityInput(env, transition.workingReplica, {
      entityId: base.entityId,
      signerId: '2',
      proposedFrame: structuredClone(prepared),
    });
    expect(delayedOldCommit.outcome).toEqual({ kind: 'noop', reason: 'COMMIT_STALE' });
    expect(delayedOldCommit.workingReplica.state.height).toBe(2);
    expect(delayedOldCommit.workingReplica.state.prevFrameHash).toBe(heightTwoHash);
    expect(delayedOldCommit.workingReplica.state.leaderState?.activeValidatorId).toBe('2');
  });
});
