import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync, signAccountFrame } from '../account/crypto';
import { buildSignedEntityCommand } from '../entity/command';
import { signedEntityCommandTx } from '../entity/command-codec';
import { applyEntityInput, mergeEntityInputs } from '../entity/consensus';
import { hasVerifiedEntityCommitPrecertificate } from '../entity/consensus/commit-precheck';
import { prioritizeEntityConsensusInputs } from '../entity/consensus/input-merge';
import { deriveLocalEntityCryptoKeys } from '../entity/crypto';
import {
  buildEntityLeaderVoteBody,
  hashEntityLeaderVoteBody,
  markLocalEntityLeaderTimeoutVote,
} from '../entity/consensus/leader';
import { encodeBoard, hashBoard } from '../entity/factory';
import { initCrontab } from '../entity/scheduler';
import { applyRuntimeInput, createEmptyEnv, process as processRuntime } from '../runtime';
import type {
  ConsensusConfig,
  EntityInput,
  EntityLeaderTimeoutVote,
  EntityReplica,
  EntityState,
  Env,
  ProposedEntityFrame,
  RoutedEntityInput,
} from '../types';

const RUN_ID = `${process.pid}-${Date.now()}`;

const jurisdiction = {
  name: 'leader-timeout-order-test',
  chainId: 31_337,
  address: `0x${'a1'.repeat(20)}`,
  depositoryAddress: `0x${'a2'.repeat(20)}`,
  entityProviderAddress: `0x${'a3'.repeat(20)}`,
};

const boardFor = (env: Env): ConsensusConfig => {
  const proposerId = deriveSignerAddressSync(env.runtimeSeed!, '1').toLowerCase();
  return {
    mode: 'proposer-based',
    threshold: 3n,
    validators: [proposerId, '2', '3', '4'],
    shares: { [proposerId]: 1n, '2': 1n, '3': 1n, '4': 1n },
    jurisdiction,
  };
};

const baseState = (env: Env): EntityState => {
  const board = boardFor(env);
  return {
    entityId: hashBoard(encodeBoard(board, env)).toLowerCase(),
    height: 0,
    timestamp: 0,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: board,
    reserves: new Map(),
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    lastFinalizedJHeight: 0,
    jBlockChain: [],
    entityEncPubKey: `0x${'11'.repeat(32)}`,
    entityEncPrivKey: `0x${'22'.repeat(32)}`,
    profile: { name: '', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    htlcNotes: new Map(),
    lockBook: new Map(),
    swapTradingPairs: [],
    pendingSwapFillRatios: new Map(),
    crontabState: initCrontab(),
  };
};

const replica = (state: EntityState, signerId: string): EntityReplica => ({
  entityId: state.entityId,
  signerId,
  state: structuredClone(state),
  mempool: [],
  isProposer: signerId === state.config.validators[0],
  lastConsensusProgressAt: 0,
});

type RaceFixture = {
  env: Env;
  state: EntityState;
  proposer: EntityReplica;
  proposalInput: RoutedEntityInput;
  localVoteInput: RoutedEntityInput;
};

const buildFixture = async (label: string): Promise<RaceFixture> => {
  const env = createEmptyEnv(`${label}-${RUN_ID}`);
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = { storage: { enabled: false } };
  env.timestamp = 20_000;
  const state = baseState(env);
  const proposerId = state.config.validators[0]!;
  const proposer = replica(state, proposerId);
  proposer.mempool = [
    signedEntityCommandTx(
      buildSignedEntityCommand(env, state, proposerId, [
        {
          type: 'chat',
          data: { from: proposerId, message: 'old-view proposal' },
        },
      ]),
    ),
  ];
  const proposed = await applyEntityInput(env, proposer, {
    entityId: state.entityId,
    signerId: proposerId,
  });
  const proposalInput = proposed.outputs.find(output => output.signerId === '2' && output.proposedFrame);
  if (!proposalInput?.proposedFrame) throw new Error('TEST_OLD_VIEW_PROPOSAL_MISSING');

  const vote: EntityLeaderTimeoutVote = {
    ...buildEntityLeaderVoteBody(state),
    voterId: '2',
    signature: '',
  };
  markLocalEntityLeaderTimeoutVote(vote);
  return {
    env,
    state,
    proposer: proposed.workingReplica,
    proposalInput,
    localVoteInput: {
      entityId: state.entityId,
      signerId: '2',
      leaderTimeoutVote: vote,
    },
  };
};

const signedTimeoutInput = (
  env: Env,
  state: EntityState,
  targetSignerId: string,
  voterId: string,
): RoutedEntityInput => {
  const vote: EntityLeaderTimeoutVote = {
    ...buildEntityLeaderVoteBody(state),
    voterId,
    signature: '',
  };
  vote.signature = signAccountFrame(env, voterId, hashEntityLeaderVoteBody(vote));
  return {
    entityId: state.entityId,
    signerId: targetSignerId,
    leaderTimeoutVote: vote,
  };
};

const buildCertifiedCommitInput = async (fixture: RaceFixture): Promise<RoutedEntityInput> => {
  const proposerId = fixture.state.config.validators[0]!;
  let proposerResult = { workingReplica: fixture.proposer, outputs: [] as EntityInput[] };
  for (const signerId of ['2', '3']) {
    const validated = await applyEntityInput(fixture.env, replica(fixture.state, signerId), {
      ...structuredClone(fixture.proposalInput),
      signerId,
    });
    if (signerId === '2') {
      fixture.env.eReplicas.set(`${fixture.state.entityId}:2`, validated.workingReplica);
    }
    const precommit = validated.outputs.find(
      output => output.signerId === proposerId && (output.hashPrecommits?.size ?? 0) > 0,
    );
    if (!precommit) throw new Error(`TEST_PRECOMMIT_MISSING:${signerId}`);
    proposerResult = await applyEntityInput(fixture.env, proposerResult.workingReplica, precommit);
  }
  const commit = proposerResult.outputs.find(output => output.signerId === '2' && output.proposedFrame?.hankos?.length);
  if (!commit?.proposedFrame) throw new Error('TEST_CERTIFIED_COMMIT_MISSING');
  return commit;
};

const inputKind = (input: RoutedEntityInput): string => {
  if (input.proposedFrame?.hankos?.length) return 'commit';
  if (input.leaderTimeoutVote) return 'vote';
  if (input.proposedFrame) return 'proposal';
  return 'other';
};

describe('leader timeout / old-view proposal ordering regression', () => {
  test('orders a due timeout vote before an uncertified same-height proposal regardless of arrival order', async () => {
    const fixture = await buildFixture('leader-order-merge');

    for (const inputs of [
      [fixture.proposalInput, fixture.localVoteInput],
      [fixture.localVoteInput, fixture.proposalInput],
    ]) {
      expect(mergeEntityInputs(inputs).map(inputKind)).toEqual(['vote', 'proposal']);
    }
  });

  test('never signs an old-view proposal after its own timeout vote and can certify failover', async () => {
    const fixture = await buildFixture('leader-order-monotonic');
    fixture.env.eReplicas.set(`${fixture.state.entityId}:2`, replica(fixture.state, '2'));

    await applyRuntimeInput(fixture.env, {
      runtimeTxs: [],
      entityInputs: [fixture.localVoteInput],
    });
    await applyRuntimeInput(fixture.env, {
      runtimeTxs: [],
      entityInputs: [fixture.proposalInput],
    });
    await applyRuntimeInput(fixture.env, {
      runtimeTxs: [],
      entityInputs: [
        signedTimeoutInput(fixture.env, fixture.state, '2', '3'),
        signedTimeoutInput(fixture.env, fixture.state, '2', '4'),
      ],
    });

    const target = fixture.env.eReplicas.get(`${fixture.state.entityId}:2`);
    expect(target?.pendingLeaderCertificate?.toView).toBe(1);
    expect(target?.lockedFrame?.leader.view).not.toBe(0);
    expect(target?.leaderVotes?.size).toBe(3);
  });

  test('selects a due local timeout before a queued proposal even with a one-input runtime cap', async () => {
    const fixture = await buildFixture('leader-order-frame-cap');
    const selected = prioritizeEntityConsensusInputs([fixture.proposalInput, fixture.localVoteInput]).slice(0, 1);

    expect(selected.map(inputKind)).toEqual(['vote']);
  });

  test('does not trust an arbitrary Hanko marker ahead of a due timeout under the frame cap', async () => {
    const fixture = await buildFixture('leader-order-fake-hanko');
    fixture.env.eReplicas.set(`${fixture.state.entityId}:2`, replica(fixture.state, '2'));
    const poisoned = structuredClone(fixture.proposalInput);
    poisoned.proposedFrame!.hankos = ['0x01'];
    const selected = prioritizeEntityConsensusInputs(
      [poisoned, fixture.localVoteInput],
      input => hasVerifiedEntityCommitPrecertificate(fixture.env, input),
    ).slice(0, 1);

    expect(selected).toHaveLength(1);
    expect(selected[0]?.leaderTimeoutVote).toBeDefined();
    expect(hasVerifiedEntityCommitPrecertificate(fixture.env, poisoned)).toBe(false);

    for (const signerId of fixture.state.config.validators) {
      const localReplica = replica(fixture.state, signerId);
      const keys = deriveLocalEntityCryptoKeys(fixture.env, fixture.state.entityId, signerId);
      localReplica.state.entityEncPubKey = keys.publicKey;
      localReplica.state.entityEncPrivKey = keys.privateKey;
      fixture.env.eReplicas.set(`${fixture.state.entityId}:${signerId}`, localReplica);
    }
    fixture.env.runtimeState = { ...fixture.env.runtimeState, maxEntityInputsPerFrame: 1 };
    await processRuntime(fixture.env, [poisoned, fixture.localVoteInput]);
    const target = fixture.env.eReplicas.get(`${fixture.state.entityId}:2`);
    expect(target?.leaderVotes?.has('2')).toBe(true);
    expect(fixture.env.runtimeMempool?.entityInputs.some(input => input.proposedFrame?.hash === poisoned.proposedFrame?.hash))
      .toBe(true);
  });

  test('cryptographically prioritizes and applies a real 3-of-4 commit before a same-height timeout', async () => {
    const fixture = await buildFixture('leader-order-certified-commit');
    const proposerId = fixture.state.config.validators[0]!;
    fixture.env.eReplicas.set(`${fixture.state.entityId}:2`, replica(fixture.state, '2'));
    const commit = await buildCertifiedCommitInput(fixture);
    const vote = signedTimeoutInput(fixture.env, fixture.state, '2', '3');
    const verifiedCommit = (input: RoutedEntityInput) =>
      hasVerifiedEntityCommitPrecertificate(fixture.env, input);
    expect(verifiedCommit(commit)).toBe(true);
    const corrupt = structuredClone(commit);
    const corruptBundle = corrupt.proposedFrame!.collectedSigs!.get('2')!;
    corruptBundle[0] = '0x00';
    expect(verifiedCommit(corrupt)).toBe(false);
    const duplicateAlias = structuredClone(commit);
    duplicateAlias.proposedFrame!.collectedSigs!.set(
      ` ${proposerId} `,
      [...duplicateAlias.proposedFrame!.collectedSigs!.get(proposerId)!],
    );
    expect(verifiedCommit(duplicateAlias)).toBe(false);

    const replayedManifest = structuredClone(commit);
    replayedManifest.proposedFrame!.hash = `0x${'77'.repeat(32)}`;
    expect(verifiedCommit(replayedManifest)).toBe(false);

    const forgedLeader = structuredClone(commit);
    forgedLeader.proposedFrame!.leader.proposerSignerId = '4';
    expect(verifiedCommit(forgedLeader)).toBe(false);

    const forgedBody = structuredClone(commit);
    forgedBody.proposedFrame!.timestamp += 1;
    expect(verifiedCommit(forgedBody)).toBe(false);

    const uppercaseCommit = structuredClone(commit);
    uppercaseCommit.signerId = proposerId;
    uppercaseCommit.proposedFrame!.hash =
      `0x${uppercaseCommit.proposedFrame!.hash.slice(2).toUpperCase()}`;
    fixture.env.eReplicas.set(`${fixture.state.entityId}:${proposerId}`, fixture.proposer);
    expect(verifiedCommit(uppercaseCommit)).toBe(false);
    const uppercaseResult = await applyEntityInput(fixture.env, fixture.proposer, uppercaseCommit);
    expect(uppercaseResult.outcome).toEqual({ kind: 'rejected', code: 'COMMIT_DIGEST_NON_CANONICAL' });
    expect(uppercaseResult.workingReplica.state.height).toBe(0);

    const targetBeforeCommit = fixture.env.eReplicas.get(`${fixture.state.entityId}:2`)!;
    const originalLocalManifest = structuredClone(targetBeforeCommit.validatorExecution!.hashesToSign);
    const originalLockedManifest = structuredClone(targetBeforeCommit.lockedFrame!.hashesToSign!);
    const secondaryHash = {
      hash: `0x${'66'.repeat(32)}`,
      type: 'accountFrame' as const,
      context: 'adversarial-manifest-truncation',
    };
    const fullManifestCommit = structuredClone(commit);
    fullManifestCommit.proposedFrame!.hashesToSign = [
      ...fullManifestCommit.proposedFrame!.hashesToSign!,
      secondaryHash,
    ];
    for (const [signerId, signatures] of fullManifestCommit.proposedFrame!.collectedSigs!) {
      fullManifestCommit.proposedFrame!.collectedSigs!.set(
        signerId,
        [...signatures, signAccountFrame(fixture.env, signerId, secondaryHash.hash)],
      );
    }
    targetBeforeCommit.validatorExecution!.hashesToSign = structuredClone(
      fullManifestCommit.proposedFrame!.hashesToSign,
    );
    targetBeforeCommit.lockedFrame!.hashesToSign = structuredClone(
      fullManifestCommit.proposedFrame!.hashesToSign,
    );
    expect(verifiedCommit(fullManifestCommit)).toBe(true);
    const truncatedManifest = structuredClone(fullManifestCommit);
    truncatedManifest.proposedFrame!.hashesToSign = truncatedManifest.proposedFrame!.hashesToSign!.slice(0, 1);
    for (const [signerId, signatures] of truncatedManifest.proposedFrame!.collectedSigs!) {
      truncatedManifest.proposedFrame!.collectedSigs!.set(signerId, signatures.slice(0, 1));
    }
    expect(verifiedCommit(truncatedManifest)).toBe(false);
    targetBeforeCommit.validatorExecution!.hashesToSign = originalLocalManifest;
    targetBeforeCommit.lockedFrame!.hashesToSign = originalLockedManifest;
    expect(mergeEntityInputs([vote, commit], verifiedCommit).map(inputKind)).toEqual(['commit', 'vote']);

    await applyRuntimeInput(fixture.env, {
      runtimeTxs: [],
      entityInputs: [vote, commit],
    });
    const target = fixture.env.eReplicas.get(`${fixture.state.entityId}:2`);
    expect(target?.state.height).toBe(1);
    expect(target?.state.prevFrameHash).toBe(commit.proposedFrame?.hash);
    expect(target?.lockedFrame).toBeUndefined();
  });
});
