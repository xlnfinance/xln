import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync, signAccountFrame } from '../account/crypto';
import { buildSignedEntityCommand } from '../entity/command';
import { signedEntityCommandTx } from '../entity/command-codec';
import { applyEntityInput } from '../entity/consensus';
import { buildEntityLeaderVoteBody, hashEntityLeaderVoteBody } from '../entity/consensus/leader';
import { encodeBoard, hashBoard } from '../entity/factory';
import { createEmptyEnv } from '../runtime';
import type {
  ConsensusConfig,
  EntityLeaderTimeoutVote,
  EntityReplica,
  EntityState,
  EntityTx,
  ProposedEntityFrame,
} from '../types';

const jurisdiction = {
  name: 'partial-prepared-failover',
  chainId: 31_337,
  address: `0x${'a1'.repeat(20)}`,
  depositoryAddress: `0x${'a2'.repeat(20)}`,
  entityProviderAddress: `0x${'a3'.repeat(20)}`,
};

const makeBaseState = (config: ConsensusConfig, entityId: string): EntityState => ({
  entityId,
  height: 0,
  timestamp: 0,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config,
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

const chatCommand = (env: ReturnType<typeof createEmptyEnv>, state: EntityState, signerId: string, message: string): EntityTx =>
  signedEntityCommandTx(buildSignedEntityCommand(env, state, signerId, [{
    type: 'chat',
    data: { from: signerId, message },
  }]));

const signedTimeoutVote = (
  env: ReturnType<typeof createEmptyEnv>,
  state: EntityState,
  voterId: string,
  preparedFrame?: ProposedEntityFrame,
): EntityLeaderTimeoutVote => {
  const vote: EntityLeaderTimeoutVote = {
    ...buildEntityLeaderVoteBody(state),
    voterId,
    signature: '',
    ...(preparedFrame ? { preparedFrame: structuredClone(preparedFrame) } : {}),
  };
  vote.signature = signAccountFrame(env, voterId, hashEntityLeaderVoteBody(vote));
  return vote;
};

describe('partial prepared failover', () => {
  test('3-of-4 timeout quorum abandons a non-quorum 2-of-4 proposal without weakening the prepared lock', async () => {
    const env = createEmptyEnv('entity-partial-prepared-failover');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 20_000;
    const proposerId = deriveSignerAddressSync(env.runtimeSeed!, '1').toLowerCase();
    const board: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 3n,
      validators: [proposerId, '2', '3', '4'],
      shares: { [proposerId]: 1n, '2': 1n, '3': 1n, '4': 1n },
      jurisdiction,
    };
    const entityId = hashBoard(encodeBoard(board, env)).toLowerCase();
    const base = makeBaseState(board, entityId);
    const oldCommand = chatCommand(env, base, proposerId, 'old proposer disappears');
    const nextCommand = chatCommand(env, base, '2', 'new leader continues');

    const proposer: EntityReplica = {
      entityId,
      signerId: proposerId,
      state: structuredClone(base),
      mempool: [],
      isProposer: true,
      lastConsensusProgressAt: 0,
    };
    const proposed = await applyEntityInput(env, proposer, {
      entityId,
      signerId: proposerId,
      entityTxs: [oldCommand],
    });
    const proposalForV2 = proposed.outputs.find(output => output.signerId === '2' && output.proposedFrame);
    if (!proposalForV2?.proposedFrame) throw new Error('TEST_OLD_PROPOSAL_MISSING');
    expect(proposalForV2.proposedFrame.collectedSigs?.size).toBe(1);

    const validator2: EntityReplica = {
      entityId,
      signerId: '2',
      state: structuredClone(base),
      mempool: [nextCommand],
      isProposer: false,
      lastConsensusProgressAt: 0,
    };
    const preparedByV2 = await applyEntityInput(env, validator2, proposalForV2);
    const partialFrame = preparedByV2.workingReplica.lockedFrame;
    if (!partialFrame) throw new Error('TEST_PARTIAL_FRAME_MISSING');
    expect(partialFrame.collectedSigs?.size).toBe(2);

    const quorumLockedReplica = structuredClone(preparedByV2.workingReplica);
    const quorumLockedFrame = quorumLockedReplica.lockedFrame;
    if (!quorumLockedFrame?.hashesToSign || !quorumLockedFrame.collectedSigs) {
      throw new Error('TEST_QUORUM_LOCK_MANIFEST_MISSING');
    }
    quorumLockedFrame.collectedSigs.set(
      '3',
      quorumLockedFrame.hashesToSign.map(({ hash }) => signAccountFrame(env, '3', hash)),
    );
    let omittedLockReplica = quorumLockedReplica;
    let omittedLockOutcome: Awaited<ReturnType<typeof applyEntityInput>> | undefined;
    for (const voterId of [proposerId, '3', '4']) {
      omittedLockOutcome = await applyEntityInput(env, omittedLockReplica, {
        entityId,
        signerId: '2',
        leaderTimeoutVote: signedTimeoutVote(env, base, voterId),
      });
      omittedLockReplica = omittedLockOutcome.workingReplica;
    }
    expect(omittedLockOutcome?.outcome).toEqual({
      kind: 'rejected',
      code: 'LEADER_PREPARED_CERTIFICATE_REJECTED',
    });
    expect(omittedLockReplica.pendingLeaderCertificate).toBeUndefined();
    expect(omittedLockReplica.lockedFrame?.hash).toBe(partialFrame.hash);

    const vote2 = signedTimeoutVote(env, base, '2', partialFrame);
    const vote3 = signedTimeoutVote(env, base, '3');
    const vote4 = signedTimeoutVote(env, base, '4');
    const validator3: EntityReplica = {
      entityId,
      signerId: '3',
      state: structuredClone(base),
      mempool: [],
      isProposer: false,
      lastConsensusProgressAt: 0,
    };
    const afterHigherViewVote = await applyEntityInput(env, validator3, {
      entityId,
      signerId: '3',
      leaderTimeoutVote: vote3,
    });
    const delayedOldProposal = await applyEntityInput(env, afterHigherViewVote.workingReplica, proposalForV2);
    expect(delayedOldProposal.outcome).toEqual({
      kind: 'rejected',
      code: 'PROPOSAL_SUPERSEDED_BY_LOCAL_VIEW_CHANGE',
    });
    expect(delayedOldProposal.workingReplica.lockedFrame).toBeUndefined();

    const votes = [vote2, vote3, vote4];
    let failover = preparedByV2;
    for (const vote of votes) {
      failover = await applyEntityInput(env, failover.workingReplica, {
        entityId,
        signerId: '2',
        leaderTimeoutVote: vote,
      });
    }

    expect(failover.outcome.kind).toBe('committed');
    expect(failover.workingReplica.pendingLeaderCertificate).toMatchObject({
      targetHeight: 1,
      nextLeaderId: '2',
      toView: 1,
    });
    expect(failover.workingReplica.pendingLeaderCertificate?.preparedFrameHash).toBeUndefined();
    expect(failover.workingReplica.lockedFrame).toBeUndefined();
    expect(failover.workingReplica.proposal?.leader).toMatchObject({ proposerSignerId: '2', view: 1 });
    expect(failover.workingReplica.proposal?.hash).not.toBe(partialFrame.hash);
  });
});
