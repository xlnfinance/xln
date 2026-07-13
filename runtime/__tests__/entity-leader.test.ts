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
import { verifyAccountSignature } from '../account/crypto';
import { applyEntityInput } from '../entity/consensus';
import { createDueScheduledWakeInputs, refreshScheduledWakeIndex } from '../machine/scheduled-wake';
import { createEmptyEnv } from '../runtime';
import type { ConsensusConfig, EntityReplica, EntityState, ProposedEntityFrame } from '../types';
import { validateEntityInput, validateEntityReplica } from '../validation-utils';

const config = (threshold = 8n): ConsensusConfig => ({
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

  test('allows weak boards but returns a loud safety warning', () => {
    expect(getEntityQuorumSafetyWarning(config(7n))).toContain('ENTITY_BOARD_LOW_QUORUM_SAFETY');
    expect(getEntityQuorumSafetyWarning(config(10n))).toBeNull();
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
      threshold: 2n,
      validators: ['1', '2', '3'],
      shares: { '1': 1n, '2': 1n, '3': 1n },
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
    expect(vote2?.leaderTimeoutVote?.nextLeaderId).toBe('2');
    expect(vote3?.leaderTimeoutVote?.nextLeaderId).toBe('2');

    const ownVoteResult = await applyEntityInput(env, replicas.get('2')!, vote2!);
    const voteFrom3 = await applyEntityInput(env, replicas.get('3')!, vote3!);
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

    const certified = await applyEntityInput(env, ownVoteResult.workingReplica, deliveredVote3!);
    expect(certified.outcome.kind).toBe('committed');
    expect(certified.workingReplica.leaderVotes?.size).toBe(2);
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
});
