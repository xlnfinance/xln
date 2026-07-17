import { describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync, signAccountFrame } from '../account/crypto';
import { applyEntityInput } from '../entity/consensus';
import { generateLazyEntityId } from '../entity/factory';
import { applyJEvent } from '../entity/tx/j-events';
import { buildJHistoryRangeRuntimeInput } from '../jadapter/helpers';
import { canonicalJurisdictionEventsHash } from '../jurisdiction/event-observation';
import { buildJEventRangeDigest, canonicalJEventRangeHash } from '../jurisdiction/history-consensus';
import { assertFrameJPrefix, buildLocalJPrefixAttestation } from '../jurisdiction/j-prefix-consensus';
import { recordValidatorJHistory } from '../jurisdiction/local-history';
import { markLocalJAuthorityRuntimeTx } from '../jurisdiction/registration-evidence';
import { applyRuntimeTx } from '../machine/tx-handlers';
import { createEmptyEnv } from '../runtime';
import type { EntityInput, EntityReplica, EntityState } from '../types';

const seed = 'j-range-overlap-consensus';
const leaderId = deriveSignerAddressSync(seed, '1').toLowerCase();
const validatorId = deriveSignerAddressSync(seed, '2').toLowerCase();
const entityId = generateLazyEntityId([leaderId, validatorId], 2n).toLowerCase();
const depository = `0x${'11'.repeat(20)}`;
const jurisdictionRef = `stack:31337:${depository}`;
const blockHash = (height: number): string =>
  `0x${height.toString(16).padStart(64, '0')}`;

const reserveEvent = (height: number, amount: string) => ({
  blockNumber: height,
  blockHash: blockHash(height),
  transactionHash: `0x${(height + 100).toString(16).padStart(64, '0')}`,
  logIndex: 0,
  type: 'ReserveUpdated' as const,
  data: { entity: entityId, tokenId: 1, newBalance: amount },
});

const eventBlock = (height: number, amount: string) => {
  const events = [reserveEvent(height, amount)];
  return {
    jurisdictionRef,
    jHeight: height,
    jBlockHash: blockHash(height),
    eventsHash: canonicalJurisdictionEventsHash(events),
    events,
  };
};

const initialState = (): EntityState => ({
  entityId,
  height: 0,
  timestamp: 0,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 2n,
    validators: [leaderId, validatorId],
    shares: { [leaderId]: 1n, [validatorId]: 1n },
    jurisdiction: {
      address: depository,
      name: 'overlap-regression',
      entityProviderAddress: depository,
      depositoryAddress: depository,
      chainId: 31337,
    },
  },
  reserves: new Map(),
  accounts: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  entityEncPubKey: 'pub',
  entityEncPrivKey: 'priv',
  profile: { name: 'test', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
});

const frameAtHeight = (outputs: EntityInput[], height: number): NonNullable<EntityInput['proposedFrame']> => {
  const frame = outputs.find((output) => output.proposedFrame?.height === height)?.proposedFrame;
  if (!frame) throw new Error(`TEST_FRAME_MISSING:${height}`);
  return frame;
};

describe('overlapping finalized J-range consensus', () => {
  test('checks the certified prefix, rejects conflicts, and commits only the matching suffix', async () => {
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    const leaderKey = `${entityId}:${leaderId}`;
    const leader: EntityReplica = {
      entityId,
      signerId: leaderId,
      state: initialState(),
      mempool: [],
      isProposer: true,
    };
    env.eReplicas.set(leaderKey, leader);

    const applyWatcherPoll = async (height: number, amount: string, fromHeight: number) => {
      const observation = {
        type: 'observeJRange' as const,
        data: {
          entityId,
          signerId: leaderId,
          jurisdictionRef,
          scannedThroughHeight: height,
          tipBlockHash: blockHash(height),
          headers: Array.from({ length: height - fromHeight + 1 }, (_, index) => ({
            jHeight: fromHeight + index,
            jBlockHash: blockHash(fromHeight + index),
          })),
          blocks: [eventBlock(height, amount)],
        },
      };
      const built = buildJHistoryRangeRuntimeInput(
        env,
        [{ timestamp: height, runtimeTxs: [observation], entityInputs: [] }],
        height,
        blockHash(height),
      );
      await applyRuntimeTx(env, markLocalJAuthorityRuntimeTx(observation));
      if (!built) {
        return {
          outcome: { kind: 'committed' as const },
          workingReplica: env.eReplicas.get(leaderKey)!,
          outputs: [] as EntityInput[],
        };
      }
      for (const runtimeTx of built.input.runtimeTxs) await applyRuntimeTx(env, runtimeTx);
      if (built.input.entityInputs.length === 0) {
        return {
          outcome: { kind: 'committed' as const },
          workingReplica: env.eReplicas.get(leaderKey)!,
          outputs: [] as EntityInput[],
        };
      }
      if (built.input.entityInputs.length !== 1) throw new Error('TEST_J_RANGE_INPUT_COUNT_INVALID');
      const result = await applyEntityInput(
        env,
        env.eReplicas.get(leaderKey)!,
        built.input.entityInputs[0]!,
      );
      env.eReplicas.set(leaderKey, result.workingReplica);
      return result;
    };

    const initialValidatorHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 7,
      tipBlockHash: blockHash(7),
      headers: Array.from({ length: 7 }, (_, index) => ({
        jHeight: index + 1,
        jBlockHash: blockHash(index + 1),
      })),
      blocks: [eventBlock(7, '7')],
    });
    const initialValidator: EntityReplica = {
      entityId,
      signerId: validatorId,
      state: initialState(),
      mempool: [],
      isProposer: false,
      jHistory: initialValidatorHistory,
    };
    const firstPoll = await applyWatcherPoll(7, '7', 1);
    const validatorHead = buildLocalJPrefixAttestation(env, initialValidator);
    if (!validatorHead) throw new Error('TEST_VALIDATOR_PREFIX_HEAD_MISSING');
    const firstQuorum = await applyEntityInput(env, firstPoll.workingReplica, {
      entityId,
      signerId: leaderId,
      jPrefixAttestations: new Map([[validatorId, validatorHead]]),
    });
    env.eReplicas.set(leaderKey, firstQuorum.workingReplica);
    const firstProposal = frameAtHeight(firstQuorum.outputs, 1);
    await applyWatcherPoll(12, '12', 8);

    const validatorHistoryThroughTwelve = recordValidatorJHistory(
      initialValidator.jHistory,
      {
        jurisdictionRef,
        scannedThroughHeight: 12,
        tipBlockHash: blockHash(12),
        headers: Array.from({ length: 5 }, (_, index) => ({
          jHeight: index + 8,
          jBlockHash: blockHash(index + 8),
        })),
        blocks: [eventBlock(12, '12')],
      },
      initialValidator.state,
    );
    const firstValidation = await applyEntityInput(env, {
      ...initialValidator,
      jHistory: validatorHistoryThroughTwelve,
    }, {
      entityId,
      signerId: validatorId,
      proposedFrame: firstProposal,
    });
    const firstPrecommit = firstValidation.outputs.find((output) => output.hashPrecommits);
    if (!firstPrecommit) throw new Error('TEST_FIRST_PRECOMMIT_MISSING');

    const firstCommit = await applyEntityInput(
      env,
      env.eReplicas.get(leaderKey)!,
      firstPrecommit,
    );
    env.eReplicas.set(leaderKey, firstCommit.workingReplica);
    frameAtHeight(firstCommit.outputs, 1);
    const validatorAfterFirstCommit = firstValidation;
    expect(validatorAfterFirstCommit.workingReplica.state.lastFinalizedJHeight).toBe(7);
    expect(validatorAfterFirstCommit.workingReplica.state.reserves.get(1)).toBe(7n);
    const validatorSuffixHead = validatorAfterFirstCommit.outputs.find((output) =>
      output.signerId === leaderId && output.jPrefixAttestations?.has(validatorId)
    );
    if (!validatorSuffixHead) throw new Error('TEST_VALIDATOR_SUFFIX_HEAD_MISSING');
    const secondProposalResult = await applyEntityInput(
      env,
      firstCommit.workingReplica,
      validatorSuffixHead,
    );
    env.eReplicas.set(leaderKey, secondProposalResult.workingReplica);
    const secondProposal = frameAtHeight(secondProposalResult.outputs, 2);
    const validatorReadyForSuffix = validatorAfterFirstCommit.workingReplica;

    const firstRange = firstProposal.txs.find((tx) => tx.type === 'j_event');
    const secondRange = secondProposal.txs.find((tx) => tx.type === 'j_event');
    if (!firstRange || firstRange.type !== 'j_event' || !secondRange || secondRange.type !== 'j_event') {
      throw new Error('TEST_J_RANGE_MISSING');
    }
    const crossingBlocks = [...firstRange.data.blocks, ...secondRange.data.blocks];
    const crossingRangeHash = canonicalJEventRangeHash(jurisdictionRef, crossingBlocks);
    const crossingUnsigned = {
      jurisdictionRef,
      baseHeight: firstRange.data.baseHeight,
      scannedThroughHeight: secondRange.data.scannedThroughHeight,
      tipBlockHash: secondRange.data.tipBlockHash,
      eventHistoryRoot: secondRange.data.eventHistoryRoot,
      rangeHash: crossingRangeHash,
      blocks: crossingBlocks,
    };
    const crossingProposal = structuredClone(secondProposal);
    const crossingTx = crossingProposal.txs.find((tx) => tx.type === 'j_event');
    if (!crossingTx || crossingTx.type !== 'j_event') throw new Error('TEST_CROSSING_J_RANGE_MISSING');
    crossingTx.data = {
      ...crossingTx.data,
      ...crossingUnsigned,
      signature: signAccountFrame(env, leaderId, buildJEventRangeDigest({
        entityId,
        signerId: leaderId,
        ...crossingUnsigned,
      })),
    };
    expect(() => assertFrameJPrefix(env, validatorReadyForSuffix, crossingProposal)).not.toThrow();

    const observedAtMismatch = structuredClone(secondProposal);
    const mismatchedRange = observedAtMismatch.txs.find((tx) => tx.type === 'j_event');
    if (!mismatchedRange || mismatchedRange.type !== 'j_event') {
      throw new Error('TEST_SECOND_J_RANGE_MISSING');
    }
    // observedAt is deliberately outside the signed digest. Preflight must
    // still reject it before reducer replay can throw and halt the replica.
    mismatchedRange.data.observedAt -= 1;
    const mismatchResult = await applyEntityInput(env, validatorReadyForSuffix, {
      entityId,
      signerId: validatorId,
      proposedFrame: observedAtMismatch,
    });
    expect(mismatchResult.outcome).toEqual({ kind: 'rejected', code: 'PROPOSAL_J_RANGE_MISMATCH' });
    expect(mismatchResult.outputs).toEqual([]);
    expect(mismatchResult.workingReplica.state.lastFinalizedJHeight).toBe(7);
    expect(mismatchResult.workingReplica.lockedFrame).toBeUndefined();

    const conflictingProposal = structuredClone(secondProposal);
    const conflictingRange = conflictingProposal.txs.find((tx) => tx.type === 'j_event');
    if (!conflictingRange || conflictingRange.type !== 'j_event') {
      throw new Error('TEST_SECOND_J_RANGE_MISSING');
    }
    conflictingRange.data.blocks[0]!.blockHash = `0x${'cc'.repeat(32)}`;
    const conflictResult = await applyEntityInput(env, validatorReadyForSuffix, {
      entityId,
      signerId: validatorId,
      proposedFrame: conflictingProposal,
    });
    expect(conflictResult.outcome).toEqual({ kind: 'rejected', code: 'PROPOSAL_J_RANGE_MISMATCH' });
    expect(conflictResult.outputs).toEqual([]);
    expect(conflictResult.workingReplica.state.lastFinalizedJHeight).toBe(7);
    expect(conflictResult.workingReplica.state.reserves.get(1)).toBe(7n);
    expect(conflictResult.workingReplica.lockedFrame).toBeUndefined();

    const secondValidation = await applyEntityInput(env, validatorReadyForSuffix, {
      entityId,
      signerId: validatorId,
      proposedFrame: secondProposal,
    });
    expect(secondValidation.outcome.kind).toBe('committed');
    expect(secondValidation.workingReplica.state.lastFinalizedJHeight).toBe(12);
    expect(secondValidation.workingReplica.state.reserves.get(1)).toBe(12n);
    expect(secondValidation.workingReplica.state.jBlockChain.map((block) => block.jHeight))
      .toEqual([7, 12]);
    const secondPrecommit = secondValidation.outputs.find((output) => output.hashPrecommits);
    if (!secondPrecommit) throw new Error('TEST_SECOND_PRECOMMIT_MISSING');

    const secondCommit = await applyEntityInput(
      env,
      env.eReplicas.get(leaderKey)!,
      secondPrecommit,
    );
    expect(secondCommit.workingReplica.state.lastFinalizedJHeight).toBe(12);
    expect(secondCommit.workingReplica.state.reserves.get(1)).toBe(12n);
    expect(secondCommit.workingReplica.state.jBlockChain.map((block) => block.jHeight)).toEqual([7, 12]);

    const replay = await applyJEvent(secondCommit.workingReplica.state, firstRange.data, env);
    expect(replay.newState).toBe(secondCommit.workingReplica.state);
    expect(replay.mempoolOps).toEqual([]);
    expect(replay.outputs).toEqual([]);
  });
});
