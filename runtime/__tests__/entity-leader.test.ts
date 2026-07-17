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
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
  verifyAccountSignature,
} from '../account/crypto';
import { applyEntityInput } from '../entity/consensus';
import { applyEntityFrame } from '../entity/consensus';
import { buildSignedEntityCommand } from '../entity/command';
import { signedEntityCommandTx } from '../entity/command-codec';
import { createEntityFrameHash, createEntityFrameHashFromStateRoot } from '../entity/consensus/frame';
import { buildEntityHashesToSign } from '../entity/consensus/hanko-witness';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../entity/consensus/state-root';
import { encodeBoard, hashBoard } from '../entity/factory';
import { canonicalJurisdictionEventsHash } from '../jurisdiction/event-observation';
import { EMPTY_J_HISTORY_ROOT } from '../jurisdiction/history-consensus';
import {
  buildCertifiedJPrefixTx,
  buildJPrefixCertificate,
  buildLocalJPrefixAttestation,
  mergeJPrefixAttestations,
} from '../jurisdiction/j-prefix-consensus';
import { recordValidatorJHistory } from '../jurisdiction/local-history';
import { commitReliableIngress } from '../machine/reliable-delivery';
import { createDueScheduledWakeInputs, refreshScheduledWakeIndex } from '../machine/scheduled-wake';
import { applyRuntimeInput, createEmptyEnv } from '../runtime';
import type {
  ConsensusConfig,
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
  JurisdictionEvent,
  ProposedEntityFrame,
  ValidatorJHistory,
} from '../types';
import { validateConsensusConfig, validateEntityInput, validateEntityReplica } from '../validation-utils';

const leaderTestJurisdiction = {
  name: 'entity-leader-test',
  chainId: 31_337,
  address: `0x${'a1'.repeat(20)}`,
  depositoryAddress: `0x${'a2'.repeat(20)}`,
  entityProviderAddress: `0x${'a3'.repeat(20)}`,
};

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

  test('warns about weak boards without overriding the configured threshold', () => {
    expect(getEntityQuorumSafetyWarning(config(7n))).toContain('ENTITY_BOARD_LOW_QUORUM_SAFETY');
    expect(getEntityQuorumSafetyWarning(config(10n))).toBeNull();
    expect(validateConsensusConfig(config(7n)).threshold).toBe(7n);
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
    const proposerId = deriveSignerAddressSync(env.runtimeSeed!, '1').toLowerCase();
    const board: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 3n,
      validators: [proposerId, '2', '3', '4'],
      shares: { [proposerId]: 1n, '2': 1n, '3': 1n, '4': 1n },
      jurisdiction: leaderTestJurisdiction,
    };
    const base = state();
    base.entityId = hashBoard(encodeBoard(board, env)).toLowerCase();
    base.height = 0;
    base.timestamp = 0;
    base.prevFrameHash = undefined;
    base.config = board;
    const command = signedEntityCommandTx(buildSignedEntityCommand(env, base, '2', [{
      type: 'chat' as const,
      data: { from: '2', message: 'fallback leader command' },
    }]));
    const replicas = new Map<string, EntityReplica>();
    for (const signerId of board.validators) {
      replicas.set(signerId, {
        entityId: base.entityId,
        signerId,
        state: structuredClone(base),
        mempool: signerId === proposerId ? [] : [command],
        isProposer: signerId === proposerId,
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

    const ownVoteResult = await applyRuntimeInput(env, { runtimeTxs: [], entityInputs: [vote2!] });
    const voteFrom3 = await applyEntityInput(env, replicas.get('3')!, vote3!);
    const voteFrom4 = await applyEntityInput(env, replicas.get('4')!, vote4!);
    const canonicalOwnVote = ownVoteResult.appliedRuntimeInput.entityInputs[0]?.leaderTimeoutVote;
    expect(canonicalOwnVote?.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(verifyAccountSignature(
      env,
      '2',
      hashEntityLeaderVoteBody(canonicalOwnVote!),
      canonicalOwnVote!.signature,
    )).toBe(true);
    expect(() => commitReliableIngress(env, ownVoteResult.appliedRuntimeInput.entityInputs)).not.toThrow();
    expect(voteFrom3.outcome.kind).toBe('committed');
    const deliveredVote3 = voteFrom3.outputs.find(output => output.signerId === '2');
    expect(deliveredVote3?.leaderTimeoutVote?.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(verifyAccountSignature(
      env,
      '3',
      hashEntityLeaderVoteBody(deliveredVote3!.leaderTimeoutVote!),
      deliveredVote3!.leaderTimeoutVote!.signature,
    )).toBe(true);

    const ownVoteReplica = env.eReplicas.get(`${base.entityId}:2`);
    if (!ownVoteReplica) throw new Error('TEST_LOCAL_LEADER_VOTE_REPLICA_MISSING');
    const withTwoVotes = await applyEntityInput(env, ownVoteReplica, deliveredVote3!);
    const deliveredVote4 = voteFrom4.outputs.find(output => output.signerId === '2');
    const certified = await applyEntityInput(env, withTwoVotes.workingReplica, deliveredVote4!);
    expect(certified.outcome.kind).toBe('committed');
    expect(certified.workingReplica.leaderVotes?.size).toBe(3);
    expect(certified.workingReplica.pendingLeaderCertificate?.nextLeaderId).toBe('2');
    expect(certified.workingReplica.proposal?.leader).toMatchObject({ proposerSignerId: '2', view: 1 });
    expect(certified.workingReplica.validatorExecution?.state.leaderState).toEqual({
      activeValidatorId: '2',
      view: 1,
      changedAtHeight: 1,
    });
  });

  test('ignores a delayed committed proposal without replacing the next proposal', async () => {
    const env = createEmptyEnv('entity-stale-proposal');
    env.scenarioMode = true;
    env.timestamp = 2_000;
    const committedState = state();
    committedState.entityId = '9';
    committedState.height = 1;
    const committedStateRoot = computeCanonicalEntityConsensusStateHash(committedState);
    const committedAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(committedState));
    const committedHash = createEntityFrameHashFromStateRoot(
      'genesis',
      1,
      committedState.timestamp,
      [],
      committedState.entityId,
      committedStateRoot,
      committedAuthorityRoot,
    );
    committedState.prevFrameHash = committedHash;
    const nextState = { ...committedState, height: 2 };
    const nextStateRoot = computeCanonicalEntityConsensusStateHash(nextState);
    const nextAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(nextState));
    const nextHash = createEntityFrameHashFromStateRoot(
      committedHash,
      2,
      committedState.timestamp,
      [],
      committedState.entityId,
      nextStateRoot,
      nextAuthorityRoot,
    );
    const staleFrame: ProposedEntityFrame = {
      height: 1,
      parentFrameHash: 'genesis',
      stateRoot: committedStateRoot,
      authorityRoot: committedAuthorityRoot,
      timestamp: committedState.timestamp,
      txs: [],
      hash: committedHash,
      leader: { proposerSignerId: 'ceo', view: 0 },
    };
    const nextFrame: ProposedEntityFrame = {
      height: 2,
      parentFrameHash: committedHash,
      stateRoot: nextStateRoot,
      authorityRoot: nextAuthorityRoot,
      timestamp: committedState.timestamp,
      txs: [],
      hash: nextHash,
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

  test('failover relays an exact prepared J-certified frame and rejects catch-up drift', async () => {
    const proposerEnv = createEmptyEnv('entity-j-prepared-proposer');
    const failoverEnv = createEmptyEnv('entity-j-prepared-failover');
    const validatorEnv = createEmptyEnv('entity-j-prepared-validator');
    const observerEnv = createEmptyEnv('entity-j-prepared-observer');
    for (const env of [proposerEnv, failoverEnv, validatorEnv, observerEnv]) {
      env.scenarioMode = true;
      env.quietRuntimeLogs = true;
      env.timestamp = 20_000;
    }
    const installKey = (env: Env, label: string): string => {
      const signerId = deriveSignerAddressSync(env.runtimeSeed!, label).toLowerCase();
      registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, label));
      return signerId;
    };
    const proposerId = installKey(proposerEnv, 'proposer');
    const failoverId = installKey(failoverEnv, 'failover');
    const validatorId = installKey(validatorEnv, 'validator');
    const observerId = installKey(observerEnv, 'observer');
    const validators = [proposerId, failoverId, validatorId, observerId];
    const depositoryAddress = `0x${'a1'.repeat(20)}`;
    const jurisdictionRef = `stack:31337:${depositoryAddress}`;
    const jBlockHash = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`;
    const board: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 3n,
      validators,
      shares: Object.fromEntries(validators.map((signerId) => [signerId, 1n])),
      jurisdiction: {
        name: 'PreparedFailoverJ',
        address: 'http://127.0.0.1:8545',
        chainId: 31337,
        depositoryAddress,
        entityProviderAddress: `0x${'a2'.repeat(20)}`,
        registrationBlock: 1,
      },
    };
    const base = state();
    base.entityId = hashBoard(encodeBoard(board, proposerEnv)).toLowerCase();
    base.height = 0;
    base.timestamp = 0;
    base.prevFrameHash = undefined;
    base.config = board;
    base.lastFinalizedJHeight = 10;
    base.jBlockChain = [];
    base.jHistoryFinality = {
      jurisdictionRef,
      baseHeight: 0,
      finalizedThroughHeight: 10,
      tipBlockHash: jBlockHash(10),
      eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
      proposerSignerId: proposerId,
      proposerSignature: '0xgenesis',
      entityHeight: 0,
    };
    const reserveEvent: JurisdictionEvent = {
      blockNumber: 11,
      blockHash: jBlockHash(11),
      transactionHash: `0x${'a3'.repeat(32)}`,
      logIndex: 0,
      type: 'ReserveUpdated',
      data: { entity: base.entityId, tokenId: 1, newBalance: '111' },
    };
    const history = (): ValidatorJHistory => recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 11,
      tipBlockHash: jBlockHash(11),
      headers: [10, 11].map((jHeight) => ({ jHeight, jBlockHash: jBlockHash(jHeight) })),
      blocks: [{
        jurisdictionRef,
        jHeight: 11,
        jBlockHash: jBlockHash(11),
        eventsHash: canonicalJurisdictionEventsHash([reserveEvent]),
        events: [reserveEvent],
      }],
    });
    const replicaFor = (signerId: string): EntityReplica => ({
      entityId: base.entityId,
      signerId,
      state: structuredClone(base),
      mempool: [],
      isProposer: signerId === proposerId,
      jHistory: history(),
    });
    const signerEnvs = new Map<string, Env>([
      [proposerId, proposerEnv],
      [failoverId, failoverEnv],
      [validatorId, validatorEnv],
      [observerId, observerEnv],
    ]);
    const heads = new Map(validators.map((signerId) => {
      const head = buildLocalJPrefixAttestation(signerEnvs.get(signerId)!, replicaFor(signerId));
      if (!head) throw new Error(`TEST_J_PREPARED_HEAD_MISSING:${signerId}`);
      return [signerId, head];
    }));
    const certificate = buildJPrefixCertificate(base, heads);
    if (!certificate) throw new Error('TEST_J_PREPARED_CERTIFICATE_MISSING');
    const proposerReplica = replicaFor(proposerId);
    proposerReplica.jPrefixRound = mergeJPrefixAttestations(proposerEnv, base, undefined, heads);
    const preparedTxs: EntityTx[] = [
      buildCertifiedJPrefixTx(proposerEnv, proposerReplica, certificate, proposerId),
    ];
    const preparedTimestamp = 10_000;
    const replay = await applyEntityFrame(proposerEnv, base, preparedTxs, preparedTimestamp);
    const preparedState: EntityState = {
      ...replay.newState,
      entityId: base.entityId,
      height: 1,
      timestamp: preparedTimestamp,
      leaderState: getEntityLeaderState(base),
    };
    const preparedHash = await createEntityFrameHash(
      'genesis',
      1,
      preparedTimestamp,
      preparedTxs,
      preparedState,
      certificate,
    );
    const hashesToSign = buildEntityHashesToSign(base.entityId, 1, preparedHash, replay.collectedHashes);
    const prepared: ProposedEntityFrame = {
      height: 1,
      parentFrameHash: 'genesis',
      stateRoot: computeCanonicalEntityConsensusStateHash(preparedState),
      authorityRoot: computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(preparedState)),
      timestamp: preparedTimestamp,
      txs: structuredClone(preparedTxs),
      hash: preparedHash,
      leader: { proposerSignerId: proposerId, view: 0 },
      jPrefixCertificate: structuredClone(certificate),
      hashesToSign,
      collectedSigs: new Map([proposerId, failoverId, validatorId].map((signerId) => [
        signerId,
        hashesToSign.map(({ hash }) => signAccountFrame(signerEnvs.get(signerId)!, signerId, hash)),
      ])),
    };
    const withPreparedSigners = (...signerIds: string[]): ProposedEntityFrame => ({
      ...structuredClone(prepared),
      collectedSigs: new Map(signerIds.map((signerId) => [
        signerId,
        prepared.collectedSigs!.get(signerId)!,
      ])),
    });
    const failoverReplica = replicaFor(failoverId);
    failoverReplica.lockedFrame = withPreparedSigners(proposerId, failoverId);
    failoverReplica.validatorExecution = {
      frameHash: preparedHash,
      height: 1,
      state: structuredClone(preparedState),
      outputs: structuredClone(replay.outputs),
      jOutputs: structuredClone(replay.jOutputs),
      hashesToSign: structuredClone(hashesToSign),
    };
    failoverReplica.jPrefixRound = mergeJPrefixAttestations(failoverEnv, base, undefined, heads);
    failoverReplica.lastConsensusProgressAt = 0;
    const voteBody = buildEntityLeaderVoteBody(base);
    let failover = { workingReplica: failoverReplica, outputs: [] as EntityInput[] };
    const votePreparedSigners = [
      [failoverId, [proposerId, failoverId]],
      [validatorId, [proposerId, validatorId]],
      [observerId, [failoverId, validatorId]],
    ] as const;
    for (const [voterId, preparedSignerIds] of votePreparedSigners) {
      const vote = {
        ...voteBody,
        voterId,
        preparedFrame: withPreparedSigners(...preparedSignerIds),
        signature: '',
      };
      vote.signature = signAccountFrame(
        signerEnvs.get(voterId)!,
        voterId,
        hashEntityLeaderVoteBody(vote),
      );
      failover = await applyEntityInput(failoverEnv, failover.workingReplica, {
        entityId: base.entityId,
        signerId: failoverId,
        leaderTimeoutVote: vote,
      });
    }
    expect(failover.workingReplica.state.height).toBe(1);
    expect(failover.workingReplica.state.lastFinalizedJHeight).toBe(11);
    expect(failover.workingReplica.state.reserves.get(1)).toBe(111n);
    const relayed = failover.outputs.find((output) =>
      output.signerId === validatorId && output.proposedFrame?.hash === preparedHash
    );
    if (!relayed?.proposedFrame) throw new Error('TEST_J_PREPARED_RELAY_MISSING');
    expect(relayed.proposedFrame.jPrefixCertificate).toEqual(certificate);
    expect(relayed.proposedFrame.txs).toEqual(preparedTxs);

    const caughtUp = await applyEntityInput(validatorEnv, replicaFor(validatorId), relayed);
    expect(caughtUp.workingReplica.state.height).toBe(1);
    expect(caughtUp.workingReplica.state.lastFinalizedJHeight).toBe(11);
    expect(caughtUp.workingReplica.state.reserves.get(1)).toBe(111n);

    const assertRelayRejected = async (frame: ProposedEntityFrame): Promise<void> => {
      const result = await applyEntityInput(observerEnv, replicaFor(observerId), {
        entityId: base.entityId,
        signerId: observerId,
        proposedFrame: frame,
      });
      expect(result.outcome.kind).toBe('rejected');
      expect(result.workingReplica.state.height).toBe(0);
      expect(result.workingReplica.lockedFrame).toBeUndefined();
    };
    const missingCertificate = structuredClone(relayed.proposedFrame);
    delete missingCertificate.jPrefixCertificate;
    await assertRelayRejected(missingCertificate);
    const differentCertificate = structuredClone(relayed.proposedFrame);
    differentCertificate.jPrefixCertificate!.selected.tipBlockHash = `0x${'ff'.repeat(32)}`;
    await assertRelayRejected(differentCertificate);
    const differentRange = structuredClone(relayed.proposedFrame);
    const rangeTx = differentRange.txs.find((tx) => tx.type === 'j_event');
    if (!rangeTx || rangeTx.type !== 'j_event') throw new Error('TEST_J_PREPARED_RANGE_MISSING');
    const rangeEvent = rangeTx.data.blocks[0]?.events[0];
    if (!rangeEvent || rangeEvent.type !== 'ReserveUpdated') throw new Error('TEST_J_PREPARED_EVENT_MISSING');
    rangeEvent.data.newBalance = '999';
    await assertRelayRejected(differentRange);
  });

  test('re-proposes the locked prepared frame instead of signing a conflicting failover frame', async () => {
    const env = createEmptyEnv('entity-prepared-failover');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 20_000;
    const proposerId = deriveSignerAddressSync(env.runtimeSeed!, '1').toLowerCase();
    const board: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 3n,
      validators: [proposerId, '2', '3', '4'],
      shares: { [proposerId]: 1n, '2': 1n, '3': 1n, '4': 1n },
      jurisdiction: leaderTestJurisdiction,
    };
    const base = state();
    base.entityId = hashBoard(encodeBoard(board, env)).toLowerCase();
    base.height = 0;
    base.timestamp = 0;
    base.prevFrameHash = undefined;
    base.config = board;
    const preparedTimestamp = 10_000;
    const preparedUserTxs: EntityTx[] = [{
      type: 'chat',
      data: {
        from: proposerId,
        message: 'prepared payload alpha',
      },
    }];
    const preparedTxs: EntityTx[] = [signedEntityCommandTx(
      buildSignedEntityCommand(env, base, proposerId, preparedUserTxs),
    )];
    const preparedResult = await applyEntityFrame(env, base, preparedTxs, preparedTimestamp);
    const preparedState: EntityState = {
      ...preparedResult.newState,
      entityId: base.entityId,
      height: 1,
      timestamp: preparedTimestamp,
      leaderState: getEntityLeaderState(base),
    };
    const preparedStateRoot = computeCanonicalEntityConsensusStateHash(preparedState);
    const preparedAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(preparedState));
    const preparedHash = await createEntityFrameHash('genesis', 1, preparedTimestamp, preparedTxs, preparedState);
    const preparedManifest = buildEntityHashesToSign(
      base.entityId,
      1,
      preparedHash,
      preparedResult.collectedHashes,
    );
    const prepared: ProposedEntityFrame = {
      height: 1,
      parentFrameHash: 'genesis',
      stateRoot: preparedStateRoot,
      authorityRoot: preparedAuthorityRoot,
      timestamp: preparedTimestamp,
      txs: structuredClone(preparedTxs),
      hash: preparedHash,
      leader: { proposerSignerId: proposerId, view: 0 },
      hashesToSign: preparedManifest,
      collectedSigs: new Map([
        [proposerId, preparedManifest.map(({ hash }) => signAccountFrame(env, proposerId, hash))],
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
      mempool: [signedEntityCommandTx(buildSignedEntityCommand(env, base, '2', [{
        type: 'chat',
        data: { from: '2', message: 'must not create F1' },
      }]))],
      lockedFrame: withPreparedSigners(proposerId, '2'),
      validatorExecution: {
        frameHash: preparedHash,
        height: 1,
        state: structuredClone(preparedState),
        outputs: structuredClone(preparedResult.outputs),
        jOutputs: structuredClone(preparedResult.jOutputs),
        hashesToSign: structuredClone(preparedManifest),
      },
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
      preparedFrame: withPreparedSigners(proposerId, '2'),
      signature: '',
    };
    vote2.signature = signAccountFrame(env, '2', hashEntityLeaderVoteBody(vote2));
    const providerMutatedVote = structuredClone(vote2);
    const providerMutatedCommand = providerMutatedVote.preparedFrame?.txs[0];
    const providerMutatedTx = providerMutatedCommand?.type === 'entityCommand'
      ? providerMutatedCommand.data.txs[0]
      : undefined;
    if (providerMutatedTx?.type !== 'chat') {
      throw new Error('TEST_PREPARED_CHAT_MISSING');
    }
    providerMutatedTx.data.message = 'prepared payload beta';
    expect(hashEntityLeaderVoteBody(providerMutatedVote)).not.toBe(hashEntityLeaderVoteBody(vote2));
    expect(verifyAccountSignature(
      env,
      '2',
      hashEntityLeaderVoteBody(providerMutatedVote),
      vote2.signature,
    )).toBe(false);
    const vote3 = {
      ...commonVote,
      voterId: '3',
      preparedFrame: withPreparedSigners(proposerId, '3'),
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
    const conflictingStateRoot = computeCanonicalEntityConsensusStateHash(conflictingState);
    const conflictingAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(conflictingState));
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
      parentFrameHash: 'genesis',
      stateRoot: conflictingStateRoot,
      authorityRoot: conflictingAuthorityRoot,
      timestamp: conflictingTimestamp,
      txs: [],
      hash: conflictingHash,
      leader: { proposerSignerId: proposerId, view: 0 },
      hashesToSign: conflictingManifest,
      collectedSigs: new Map([proposerId, '2', '3'].map(signerId => [
        signerId,
        conflictingManifest.map(({ hash }) => signAccountFrame(env, signerId, hash)),
      ])),
    };
    const fullPrepared = withPreparedSigners(proposerId, '2', '3');
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

    const poisonedPrepared = withPreparedSigners(proposerId, '3');
    const poisonedCommand = poisonedPrepared.txs[0];
    const poisonedTx = poisonedCommand?.type === 'entityCommand'
      ? poisonedCommand.data.txs[0]
      : undefined;
    if (poisonedTx?.type !== 'chat') {
      throw new Error('TEST_POISONED_CHAT_MISSING');
    }
    poisonedTx.data.message = 'poisoned payload beta';
    const poisonedVotes = [
      { ...commonVote, voterId: '2', preparedFrame: withPreparedSigners(proposerId, '2'), signature: '' },
      { ...commonVote, voterId: '3', preparedFrame: poisonedPrepared, signature: '' },
      { ...commonVote, voterId: '4', signature: '' },
    ];
    for (const poisonedVote of poisonedVotes) {
      poisonedVote.signature = signAccountFrame(
        env,
        poisonedVote.voterId,
        hashEntityLeaderVoteBody(poisonedVote),
      );
    }
    let poisonedAttempt = { workingReplica: structuredClone(replica) };
    for (const poisonedVote of poisonedVotes) {
      poisonedAttempt = await applyEntityInput(env, poisonedAttempt.workingReplica, {
        entityId: base.entityId,
        signerId: '2',
        leaderTimeoutVote: poisonedVote,
      });
    }
    expect(poisonedAttempt.outcome).toEqual({
      kind: 'rejected',
      code: 'LEADER_PREPARED_CERTIFICATE_REJECTED',
    });
    expect(poisonedAttempt.workingReplica.state.height).toBe(0);
    expect(poisonedAttempt.workingReplica.pendingLeaderCertificate).toBeUndefined();

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
      preparedTxs,
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
    expect(transition.workingReplica.validatorExecution?.state.leaderState).toEqual({
      activeValidatorId: '2',
      view: 1,
      changedAtHeight: 2,
    });
    for (const signerId of ['3', '4']) {
      transition = await applyEntityInput(env, transition.workingReplica, {
        entityId: base.entityId,
        signerId: '2',
        hashPrecommitFrame: {
          height: transitionProposal.height,
          frameHash: transitionProposal.hash,
        },
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
