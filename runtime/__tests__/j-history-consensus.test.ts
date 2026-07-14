import { describe, expect, test } from 'bun:test';
import {
  buildJEventRangeDigest,
  canonicalJEventRangeHash,
  canonicalJHistoryObservationLeaf,
  EMPTY_J_HISTORY_ROOT,
  foldJHistoryRoot,
  getJHistoryRegistrationBaseHeight,
} from '../jurisdiction/history-consensus';
import {
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
} from '../jurisdiction/event-observation';
import { compareCanonicalJurisdictionEvents } from '../jurisdiction/event-normalization';
import { createEntityFrameHash } from '../entity/consensus/frame';
import { applyEntityInput } from '../entity/consensus/index';
import { createEmptyEnv } from '../runtime';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
  verifyAccountSignature,
} from '../account/crypto';
import { applyRuntimeTx } from '../machine/tx-handlers';
import {
  buildUnsignedJEventRange,
  getValidatorJExpectedBlockHash,
  getJEventRangeValidationError,
  pruneFinalizedValidatorJHistory,
  reconcileJEventRangeWithFinalizedState,
  recordValidatorJHistory,
  rewindValidatorJHistory,
} from '../jurisdiction/local-history';
import type { EntityReplica, EntityState, JurisdictionEvent, ValidatorJEventBlock } from '../types';

const depositoryAddress = `0x${'dd'.repeat(20)}`;
const jurisdictionRef = `stack:31337:${depositoryAddress}`;
const entityId = `0x${'ee'.repeat(32)}`;
const leaderId = `0x${'11'.repeat(20)}`;
const validatorId = `0x${'22'.repeat(20)}`;
const blockHash = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`;

const reserveEvent = (height: number, amount: string): JurisdictionEvent => ({
  blockNumber: height,
  blockHash: blockHash(height),
  transactionHash: `0x${(height + 100).toString(16).padStart(64, '0')}`,
  logIndex: 0,
  type: 'ReserveUpdated',
  data: { entity: entityId, tokenId: 1, newBalance: amount },
});

const eventBlock = (height: number, amount: string): ValidatorJEventBlock => {
  const events = [reserveEvent(height, amount)];
  return {
    jurisdictionRef,
    jHeight: height,
    jBlockHash: blockHash(height),
    eventsHash: canonicalJurisdictionEventsHash(events),
    events,
  };
};

const state = (): EntityState => ({
  entityId,
  height: 4,
  timestamp: 100,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 2n,
    validators: [leaderId, validatorId],
    shares: { [leaderId]: 1n, [validatorId]: 1n },
    jurisdiction: {
      name: 'JHistoryTestnet',
      chainId: 31337,
      depositoryAddress,
    },
  },
  reserves: new Map(),
  accounts: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  entityEncPubKey: 'pub',
  entityEncPrivKey: 'priv',
  profile: { name: 'J history', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
});

describe('J validator-local history and Entity-finalized ranges', () => {
  test('folds event blocks by jurisdiction height, independent of delivery order', () => {
    const first = eventBlock(7, '7');
    const second = eventBlock(9, '9');
    const ordered = foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [first, second]);
    const reversed = foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [second, first]);

    expect(reversed).toBe(ordered);
    expect(foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [first])).not.toBe(ordered);
    expect(() => foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [
      first,
      { ...first, eventsHash: `0x${'22'.repeat(32)}` },
    ])).toThrow('J_HISTORY_EQUIVOCATION_AT_HEIGHT:7');
  });

  test('matches the independently fixed evidence-bound J-history leaf vector', () => {
    const observation = {
      jurisdictionRef: 'stack:31337:0x00000000000000000000000000000000000000dd',
      jHeight: 7,
      jBlockHash: `0x${'11'.repeat(32)}`,
      eventsHash: `0x${'22'.repeat(32)}`,
      disputeFinalizationEvidenceHash: `0x${'33'.repeat(32)}`,
    };
    expect(canonicalJHistoryObservationLeaf(observation))
      .toBe('0x102170f17aafa712ef03a338733ddd7f690fb9888b9062ed91e3cf8d48b771bb');
    expect(foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [observation]))
      .toBe('0xee3695ffeafd31c849dd235ee631c09389a477eba163b82e22187857cb61e308');
  });

  test('range digest binds proposer, exact body, range and history root', () => {
    const block = eventBlock(7, '7');
    const blocks = [{
      blockNumber: block.jHeight,
      blockHash: block.jBlockHash,
      eventsHash: block.eventsHash,
      events: block.events,
    }];
    const rangeHash = canonicalJEventRangeHash(jurisdictionRef, blocks);
    const base = {
      entityId,
      jurisdictionRef,
      signerId: 'leader',
      baseHeight: 0,
      scannedThroughHeight: 10,
      tipBlockHash: blockHash(10),
      eventHistoryRoot: foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [block]),
      rangeHash,
    };
    const digest = buildJEventRangeDigest(base);

    expect(buildJEventRangeDigest({ ...base })).toBe(digest);
    expect(buildJEventRangeDigest({ ...base, scannedThroughHeight: 11 })).not.toBe(digest);
    expect(buildJEventRangeDigest({ ...base, signerId: 'other' })).not.toBe(digest);
    expect(canonicalJEventRangeHash(jurisdictionRef, [])).not.toBe(rangeHash);
  });

  test('transaction identity is Hanko-bound when a reducer uses it in state', async () => {
    const firstEvent = reserveEvent(7, '7');
    const secondEvent = { ...firstEvent, transactionHash: `0x${'ab'.repeat(32)}` };
    const makeData = (event: JurisdictionEvent) => {
      const eventsHash = canonicalJurisdictionEventsHash([event]);
      const blocks = [{
        blockNumber: 7,
        blockHash: blockHash(7),
        eventsHash,
        events: [event],
      }];
      return {
        from: 'leader',
        jurisdictionRef,
        baseHeight: 0,
        scannedThroughHeight: 7,
        tipBlockHash: blockHash(7),
        eventHistoryRoot: foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [{
          jurisdictionRef,
          jHeight: 7,
          jBlockHash: blockHash(7),
          eventsHash,
        }]),
        rangeHash: canonicalJEventRangeHash(jurisdictionRef, blocks),
        blocks,
        signature: '0xsig',
        observedAt: 7,
      };
    };
    const first = makeData(firstEvent);
    const second = makeData(secondEvent);

    expect(first.blocks[0]!.eventsHash).not.toBe(second.blocks[0]!.eventsHash);
    expect(first.rangeHash).not.toBe(second.rangeHash);
    await expect(createEntityFrameHash('genesis', 5, 100, [{ type: 'j_event', data: first }], state()))
      .resolves.not.toBe(await createEntityFrameHash(
        'genesis',
        5,
        100,
        [{ type: 'j_event', data: second }],
        state(),
      ));
  });

  test('validator ahead of proposer signs only an exact common ordered prefix', () => {
    const proposerBlock = eventBlock(7, '7');
    const laterBlock = eventBlock(12, '12');
    const proposerHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 10,
      tipBlockHash: blockHash(10),
      blocks: [proposerBlock],
    });
    const validatorHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 12,
      tipBlockHash: blockHash(12),
      headers: [10, 12].map((jHeight) => ({ jHeight, jBlockHash: blockHash(jHeight) })),
      blocks: [proposerBlock, laterBlock],
    });
    const unsigned = buildUnsignedJEventRange(state(), proposerHistory)!;
    const proposal = { from: 'leader', signature: '0xsig', observedAt: 10, ...unsigned };

    expect(getJEventRangeValidationError(state(), validatorHistory, proposal, 'leader')).toBeNull();

    const omittedHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 12,
      tipBlockHash: blockHash(12),
      headers: [10, 12].map((jHeight) => ({ jHeight, jBlockHash: blockHash(jHeight) })),
      blocks: [laterBlock],
    });
    expect(getJEventRangeValidationError(state(), omittedHistory, proposal, 'leader'))
      .toBe('J_RANGE_EVENT_BLOCK_COUNT_MISMATCH');

    const substituted = structuredClone(proposal);
    substituted.blocks[0]!.eventsHash = `0x${'ff'.repeat(32)}`;
    expect(() => getJEventRangeValidationError(state(), validatorHistory, substituted, 'leader'))
      .toThrow('J_HISTORY_LOCAL_EVENTS_HASH_MISMATCH');
  });

  test('rejects validly signed proposer evidence that differs from the validator-local receipt evidence', () => {
    const env = createEmptyEnv('j-evidence-prefix-agreement');
    const signerId = deriveSignerAddressSync(env.runtimeSeed!, 'evidence-proposer').toLowerCase();
    registerSignerKey(signerId, deriveSignerKeySync(env.runtimeSeed!, 'evidence-proposer'));
    const finalizedEvent: JurisdictionEvent = {
      blockNumber: 7,
      blockHash: blockHash(7),
      transactionHash: `0x${'a7'.repeat(32)}`,
      logIndex: 0,
      type: 'DisputeFinalized',
      data: {
        sender: entityId,
        counterentity: `0x${'cc'.repeat(32)}`,
        initialNonce: '1',
        initialProofbodyHash: `0x${'31'.repeat(32)}`,
        finalProofbodyHash: `0x${'32'.repeat(32)}`,
      },
    };
    const localEvidence = [{
      sender: entityId,
      counterentity: `0x${'cc'.repeat(32)}`,
      initialNonce: '1',
      finalNonce: '2',
      initialProofbodyHash: `0x${'31'.repeat(32)}`,
      finalProofbodyHash: `0x${'32'.repeat(32)}`,
      leftArguments: '0x',
      rightArguments: '0x',
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
      sig: '0x01',
    }];
    const localBlock: ValidatorJEventBlock = {
      jurisdictionRef,
      jHeight: 7,
      jBlockHash: blockHash(7),
      eventsHash: canonicalJurisdictionEventsHash([finalizedEvent]),
      events: [finalizedEvent],
      disputeFinalizationEvidence: localEvidence,
      disputeFinalizationEvidenceHash: canonicalDisputeFinalizationEvidenceHash(localEvidence),
    };
    const history = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 7,
      tipBlockHash: blockHash(7),
      blocks: [localBlock],
    });
    const unsigned = buildUnsignedJEventRange(state(), history)!;
    const forgedEvidence = [{
      ...localEvidence[0]!,
      finalNonce: '999999',
      leftArguments: '0x1234',
    }];
    const forgedBlocks = structuredClone(unsigned.blocks);
    forgedBlocks[0]!.disputeFinalizationEvidence = forgedEvidence;
    forgedBlocks[0]!.disputeFinalizationEvidenceHash = canonicalDisputeFinalizationEvidenceHash(forgedEvidence);
    const forgedUnsigned = {
      ...unsigned,
      eventHistoryRoot: foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [{
        jurisdictionRef,
        jHeight: 7,
        jBlockHash: blockHash(7),
        eventsHash: forgedBlocks[0]!.eventsHash,
        disputeFinalizationEvidenceHash: forgedBlocks[0]!.disputeFinalizationEvidenceHash,
      }]),
      rangeHash: canonicalJEventRangeHash(jurisdictionRef, forgedBlocks),
      blocks: forgedBlocks,
    };
    const digest = buildJEventRangeDigest({ entityId, signerId, ...forgedUnsigned });
    const signature = signAccountFrame(env, signerId, digest);
    expect(verifyAccountSignature(env, signerId, digest, signature)).toBe(true);

    expect(getJEventRangeValidationError(
      state(),
      history,
      { from: signerId, signature, observedAt: 7, ...forgedUnsigned },
      signerId,
    )).toBe('J_RANGE_EVENT_BLOCK_MISMATCH');

    const certifiedState = state();
    certifiedState.lastFinalizedJHeight = 7;
    certifiedState.jBlockChain = [{
      jurisdictionRef,
      jHeight: 7,
      jBlockHash: localBlock.jBlockHash,
      eventsHash: localBlock.eventsHash,
      disputeFinalizationEvidenceHash: localBlock.disputeFinalizationEvidenceHash,
      events: localBlock.events,
      finalizedAt: 100,
      proposerSignerId: signerId,
      proposerSignature: signature,
    }];
    certifiedState.jHistoryFinality = {
      jurisdictionRef,
      baseHeight: 0,
      finalizedThroughHeight: 7,
      tipBlockHash: blockHash(7),
      eventHistoryRoot: unsigned.eventHistoryRoot,
      proposerSignerId: signerId,
      proposerSignature: signature,
      entityHeight: certifiedState.height,
    };
    expect(() => reconcileJEventRangeWithFinalizedState(certifiedState, {
      from: signerId,
      signature,
      observedAt: 7,
      ...forgedUnsigned,
    })).toThrow('J_RANGE_FINALIZED_PREFIX_CONFLICT:7');
  });

  test('stores reducer evidence in canonical order instead of watcher delivery order', () => {
    const finalizedEvent: JurisdictionEvent = {
      blockNumber: 7,
      blockHash: blockHash(7),
      transactionHash: `0x${'b7'.repeat(32)}`,
      logIndex: 0,
      type: 'DisputeFinalized',
      data: {
        sender: entityId,
        counterentity: `0x${'cc'.repeat(32)}`,
        initialNonce: '1',
        initialProofbodyHash: `0x${'41'.repeat(32)}`,
        finalProofbodyHash: `0x${'42'.repeat(32)}`,
      },
    };
    const evidence = ['2', '999999'].map((finalNonce) => ({
      sender: entityId,
      counterentity: `0x${'cc'.repeat(32)}`,
      initialNonce: '1',
      finalNonce,
      initialProofbodyHash: `0x${'41'.repeat(32)}`,
      finalProofbodyHash: `0x${'42'.repeat(32)}`,
      leftArguments: finalNonce === '2' ? '0x12' : '0x99',
      rightArguments: '0x',
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
      sig: '0x01',
    }));
    const makeHistory = (orderedEvidence: typeof evidence) => recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 7,
      tipBlockHash: blockHash(7),
      blocks: [{
        jurisdictionRef,
        jHeight: 7,
        jBlockHash: blockHash(7),
        eventsHash: canonicalJurisdictionEventsHash([finalizedEvent]),
        events: [finalizedEvent],
        disputeFinalizationEvidence: orderedEvidence,
        disputeFinalizationEvidenceHash: canonicalDisputeFinalizationEvidenceHash(orderedEvidence),
      }],
    });

    const forward = makeHistory(evidence).eventBlocks.get(7)?.disputeFinalizationEvidence;
    const reversed = makeHistory([...evidence].reverse()).eventBlocks.get(7)?.disputeFinalizationEvidence;
    expect(reversed).toEqual(forward);
  });

  test('validator rejects a proposal that omits an eventful local J block before precommit', async () => {
    const validatorState = state();
    const localHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 10,
      tipBlockHash: blockHash(10),
      blocks: [eventBlock(7, '7')],
    });
    const maliciousHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 10,
      tipBlockHash: blockHash(10),
      blocks: [],
    });
    const unsigned = buildUnsignedJEventRange(validatorState, maliciousHistory)!;
    const tx = {
      type: 'j_event' as const,
      data: { from: leaderId, signature: '0xmalicious', observedAt: 10, ...unsigned },
    };
    const replica: EntityReplica = {
      entityId: validatorState.entityId,
      signerId: validatorId,
      state: validatorState,
      mempool: [],
      isProposer: false,
      jHistory: localHistory,
    };
    const result = await applyEntityInput(createEmptyEnv('j-range-omit-precommit'), replica, {
      entityId: validatorState.entityId,
      signerId: validatorId,
      proposedFrame: {
        height: validatorState.height + 1,
        txs: [tx],
        hash: `0x${'11'.repeat(32)}`,
        newState: {
          ...validatorState,
          height: validatorState.height + 1,
          leaderState: { activeValidatorId: leaderId, view: 0, changedAtHeight: 0 },
        },
        leader: { proposerSignerId: leaderId, view: 0 },
      },
    });

    expect(result.outcome).toEqual({ kind: 'rejected', code: 'PROPOSAL_J_RANGE_MISMATCH' });
    expect(result.outputs).toHaveLength(0);
    expect(replica.lockedFrame).toBeUndefined();
  });

  test('prunes only finalized local evidence and retains later observations', () => {
    const history = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 12,
      tipBlockHash: blockHash(12),
      blocks: [eventBlock(7, '7'), eventBlock(12, '12')],
    });
    const pruned = pruneFinalizedValidatorJHistory(history, 10)!;

    expect([...pruned.eventBlocks.keys()]).toEqual([12]);
    expect(pruned.blockHashes.has(7)).toBe(false);
    expect(pruned.blockHashes.has(12)).toBe(true);
  });

  test('rewinds only validator-private suffix and preserves the E-certified anchor', () => {
    const entityState = state();
    entityState.lastFinalizedJHeight = 10;
    entityState.jHistoryFinality = {
      jurisdictionRef,
      baseHeight: 0,
      finalizedThroughHeight: 10,
      tipBlockHash: blockHash(10),
      eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
      proposerSignerId: leaderId,
      proposerSignature: '0xsig',
      entityHeight: entityState.height,
    };
    const history = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 12,
      tipBlockHash: blockHash(12),
      headers: [10, 11, 12].map((jHeight) => ({ jHeight, jBlockHash: blockHash(jHeight) })),
      blocks: [eventBlock(12, '12')],
    });

    const rewound = rewindValidatorJHistory(entityState, history)!;

    expect(rewound.scannedThroughHeight).toBe(10);
    expect([...rewound.eventBlocks]).toEqual([]);
    expect([...rewound.blockHashes]).toEqual([[10, blockHash(10)]]);
    expect(getValidatorJExpectedBlockHash(entityState, rewound, 10)).toBe(blockHash(10));
  });

  test('never rewinds across an E-certified J height', async () => {
    const env = createEmptyEnv('j-finalized-reorg');
    const entityState = state();
    entityState.lastFinalizedJHeight = 10;
    const replica: EntityReplica = {
      entityId,
      signerId: leaderId,
      state: entityState,
      mempool: [],
      isProposer: true,
      jHistory: recordValidatorJHistory(undefined, {
        jurisdictionRef,
        scannedThroughHeight: 12,
        tipBlockHash: blockHash(12),
        headers: [10, 11, 12].map((jHeight) => ({ jHeight, jBlockHash: blockHash(jHeight) })),
        blocks: [eventBlock(12, '12')],
      }),
    };
    env.eReplicas.set(`${entityId}:${leaderId}`, replica);

    await expect(applyRuntimeTx(env, {
      type: 'rewindJHistory',
      data: {
        entityId,
        signerId: leaderId,
        jurisdictionRef,
        conflictingHeight: 10,
        conflictingBlockHash: blockHash(10),
      },
    })).rejects.toThrow('J_HISTORY_FINALIZED_REORG:10');
  });

  test('halts when a private-chain reorg crosses a locally signed Entity-frame lock', async () => {
    const env = createEmptyEnv('j-signed-lock-reorg');
    const entityState = state();
    entityState.lastFinalizedJHeight = 10;
    entityState.jHistoryFinality = {
      jurisdictionRef,
      baseHeight: 0,
      finalizedThroughHeight: 10,
      tipBlockHash: blockHash(10),
      eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
      proposerSignerId: leaderId,
      proposerSignature: '0xsig',
      entityHeight: entityState.height,
    };
    const localHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 12,
      tipBlockHash: blockHash(12),
      headers: [10, 11, 12].map((jHeight) => ({ jHeight, jBlockHash: blockHash(jHeight) })),
      blocks: [eventBlock(12, '12')],
    }, entityState);
    const unsignedRange = buildUnsignedJEventRange(entityState, localHistory);
    if (!unsignedRange) throw new Error('TEST_J_RANGE_MISSING');
    const lockedFrame = {
      height: entityState.height + 1,
      txs: [{
        type: 'j_event' as const,
        data: { from: leaderId, signature: '0xsig', observedAt: 12, ...unsignedRange },
      }],
      hash: `0x${'ab'.repeat(32)}`,
      newState: { ...entityState, height: entityState.height + 1 },
      leader: { proposerSignerId: leaderId, view: 0 },
      collectedSigs: new Map([[validatorId, ['0xprecommit']]]),
    };
    const replica: EntityReplica = {
      entityId,
      signerId: validatorId,
      state: entityState,
      mempool: [],
      isProposer: false,
      jHistory: localHistory,
      lockedFrame,
      validatorComputedState: lockedFrame.newState,
    };
    env.eReplicas.set(`${entityId}:${validatorId}`, replica);

    await expect(applyRuntimeTx(env, {
      type: 'rewindJHistory',
      data: {
        entityId,
        signerId: validatorId,
        jurisdictionRef,
        conflictingHeight: 12,
        conflictingBlockHash: `0x${'cc'.repeat(32)}`,
      },
    })).rejects.toThrow('J_HISTORY_SIGNED_LOCK_REORG');
    expect(replica.jHistory?.scannedThroughHeight).toBe(12);
    expect(replica.lockedFrame?.hash).toBe(lockedFrame.hash);
    expect(replica.validatorComputedState?.height).toBe(entityState.height + 1);
  });

  test('treats the Entity-certified anchor as authoritative when local history is restored empty', async () => {
    const env = createEmptyEnv('j-certified-anchor-authority');
    const entityState = state();
    entityState.lastFinalizedJHeight = 10;
    entityState.jHistoryFinality = {
      jurisdictionRef,
      baseHeight: 0,
      finalizedThroughHeight: 10,
      tipBlockHash: blockHash(10),
      eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
      proposerSignerId: leaderId,
      proposerSignature: '0xsig',
      entityHeight: entityState.height,
    };
    const replica: EntityReplica = {
      entityId,
      signerId: leaderId,
      state: entityState,
      mempool: [],
      isProposer: true,
    };
    env.eReplicas.set(`${entityId}:${leaderId}`, replica);

    await expect(applyRuntimeTx(env, {
      type: 'observeJRange',
      data: {
        entityId,
        signerId: leaderId,
        jurisdictionRef,
        scannedThroughHeight: 12,
        tipBlockHash: blockHash(12),
        headers: [
          { jHeight: 10, jBlockHash: `0x${'bb'.repeat(32)}` },
          { jHeight: 12, jBlockHash: blockHash(12) },
        ],
        blocks: [],
      },
    })).rejects.toThrow('J_HISTORY_FINALIZED_REORG:10');
    expect(replica.jHistory).toBeUndefined();
  });

  test('rejects a restored local header conflicting with any certified event block in the prefix', async () => {
    const env = createEmptyEnv('j-certified-prefix-authority');
    const entityState = state();
    const finalizedEvent = eventBlock(7, '7');
    entityState.lastFinalizedJHeight = 10;
    entityState.jBlockChain = [{
      jurisdictionRef,
      jHeight: finalizedEvent.jHeight,
      jBlockHash: finalizedEvent.jBlockHash,
      eventsHash: finalizedEvent.eventsHash,
      events: structuredClone(finalizedEvent.events),
      finalizedAt: entityState.timestamp,
      proposerSignerId: leaderId,
      proposerSignature: '0xsig',
    }];
    entityState.jHistoryFinality = {
      jurisdictionRef,
      baseHeight: 0,
      finalizedThroughHeight: 10,
      tipBlockHash: blockHash(10),
      eventHistoryRoot: foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [finalizedEvent]),
      proposerSignerId: leaderId,
      proposerSignature: '0xsig',
      entityHeight: entityState.height,
    };
    const replica: EntityReplica = {
      entityId,
      signerId: leaderId,
      state: entityState,
      mempool: [],
      isProposer: true,
    };
    env.eReplicas.set(`${entityId}:${leaderId}`, replica);

    await expect(applyRuntimeTx(env, {
      type: 'observeJRange',
      data: {
        entityId,
        signerId: leaderId,
        jurisdictionRef,
        scannedThroughHeight: 12,
        tipBlockHash: blockHash(12),
        headers: [{ jHeight: 7, jBlockHash: `0x${'cc'.repeat(32)}` }],
        blocks: [],
      },
    })).rejects.toThrow('J_HISTORY_FINALIZED_REORG:7');
    expect(replica.jHistory).toBeUndefined();
  });

  test('rejects a certified finality root inconsistent with the certified event chain', () => {
    const entityState = state();
    const finalizedEvent = eventBlock(7, '7');
    const laterEvent = eventBlock(12, '12');
    const corruptRoot = `0x${'ff'.repeat(32)}`;
    entityState.lastFinalizedJHeight = 10;
    entityState.jBlockChain = [{
      jurisdictionRef,
      jHeight: finalizedEvent.jHeight,
      jBlockHash: finalizedEvent.jBlockHash,
      eventsHash: finalizedEvent.eventsHash,
      events: structuredClone(finalizedEvent.events),
      finalizedAt: entityState.timestamp,
      proposerSignerId: leaderId,
      proposerSignature: '0xsig',
    }];
    entityState.jHistoryFinality = {
      jurisdictionRef,
      baseHeight: 0,
      finalizedThroughHeight: 10,
      tipBlockHash: blockHash(10),
      eventHistoryRoot: corruptRoot,
      proposerSignerId: leaderId,
      proposerSignature: '0xsig',
      entityHeight: entityState.height,
    };
    const blocks = [{
      blockNumber: laterEvent.jHeight,
      blockHash: laterEvent.jBlockHash,
      eventsHash: laterEvent.eventsHash,
      events: structuredClone(laterEvent.events),
    }];

    expect(() => reconcileJEventRangeWithFinalizedState(entityState, {
      from: leaderId,
      jurisdictionRef,
      baseHeight: 10,
      scannedThroughHeight: 12,
      tipBlockHash: blockHash(12),
      eventHistoryRoot: foldJHistoryRoot(corruptRoot, [laterEvent]),
      rangeHash: canonicalJEventRangeHash(jurisdictionRef, blocks),
      blocks,
      signature: '0xsig',
      observedAt: 12,
    })).toThrow('J_HISTORY_FINALITY_ROOT_CORRUPTION');
  });

  test('requires certified finality once Entity state advances past its registration baseline', () => {
    const entityState = state();
    entityState.config.jurisdiction!.registrationBlock = 91;
    entityState.lastFinalizedJHeight = 90;

    expect(() => reconcileJEventRangeWithFinalizedState(entityState, {
      from: leaderId,
      jurisdictionRef,
      baseHeight: 90,
      scannedThroughHeight: 91,
      tipBlockHash: blockHash(91),
      eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
      rangeHash: canonicalJEventRangeHash(jurisdictionRef, []),
      blocks: [],
      signature: '0xsig',
      observedAt: 91,
    })).not.toThrow();

    entityState.lastFinalizedJHeight = 91;
    expect(() => reconcileJEventRangeWithFinalizedState(entityState, {
      from: leaderId,
      jurisdictionRef,
      baseHeight: 91,
      scannedThroughHeight: 92,
      tipBlockHash: blockHash(92),
      eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
      rangeHash: canonicalJEventRangeHash(jurisdictionRef, []),
      blocks: [],
      signature: '0xsig',
      observedAt: 92,
    })).toThrow('J_HISTORY_FINALITY_MISSING');
  });

  test('propagates certified-history corruption instead of classifying it as a proposer mismatch', async () => {
    const entityState = state();
    const finalizedEvent = eventBlock(7, '7');
    entityState.lastFinalizedJHeight = 10;
    entityState.jBlockChain = [{
      jurisdictionRef,
      jHeight: finalizedEvent.jHeight,
      jBlockHash: finalizedEvent.jBlockHash,
      eventsHash: finalizedEvent.eventsHash,
      events: structuredClone(finalizedEvent.events),
      finalizedAt: entityState.timestamp,
      proposerSignerId: leaderId,
      proposerSignature: '0xsig',
    }];
    entityState.jHistoryFinality = {
      jurisdictionRef,
      baseHeight: 0,
      finalizedThroughHeight: 10,
      tipBlockHash: blockHash(10),
      eventHistoryRoot: `0x${'ff'.repeat(32)}`,
      proposerSignerId: leaderId,
      proposerSignature: '0xsig',
      entityHeight: entityState.height,
    };
    const replica: EntityReplica = {
      entityId,
      signerId: validatorId,
      state: entityState,
      mempool: [],
      isProposer: false,
    };

    await expect(applyEntityInput(createEmptyEnv('j-certified-corruption-fatal'), replica, {
      entityId,
      signerId: validatorId,
      proposedFrame: {
        height: entityState.height + 1,
        txs: [{
          type: 'j_event',
          data: {
            from: leaderId,
            jurisdictionRef,
            baseHeight: 10,
            scannedThroughHeight: 11,
            tipBlockHash: blockHash(11),
            eventHistoryRoot: `0x${'aa'.repeat(32)}`,
            rangeHash: canonicalJEventRangeHash(jurisdictionRef, []),
            blocks: [],
            signature: '0xsig',
            observedAt: 11,
          },
        }],
        hash: `0x${'11'.repeat(32)}`,
        newState: {
          ...entityState,
          height: entityState.height + 1,
          leaderState: { activeValidatorId: leaderId, view: 0, changedAtHeight: 0 },
        },
        leader: { proposerSignerId: leaderId, view: 0 },
      },
    })).rejects.toThrow('J_HISTORY_FINALITY_ROOT_CORRUPTION');
    expect(replica.lockedFrame).toBeUndefined();
  });

  test('reconciles a matching signed overlap to its suffix and rejects a conflicting prefix', () => {
    const entityState = state();
    const first = eventBlock(7, '7');
    entityState.lastFinalizedJHeight = 10;
    entityState.jBlockChain = [{
      jurisdictionRef,
      jHeight: first.jHeight,
      jBlockHash: first.jBlockHash,
      eventsHash: first.eventsHash,
      events: structuredClone(first.events),
      finalizedAt: entityState.timestamp,
      proposerSignerId: leaderId,
      proposerSignature: '0xsig',
    }];
    entityState.jHistoryFinality = {
      jurisdictionRef,
      baseHeight: 0,
      finalizedThroughHeight: 10,
      tipBlockHash: blockHash(10),
      eventHistoryRoot: foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [first]),
      proposerSignerId: leaderId,
      proposerSignature: '0xsig',
      entityHeight: entityState.height,
    };
    const later = eventBlock(12, '12');
    const blocks = [first, later].map((block) => ({
      blockNumber: block.jHeight,
      blockHash: block.jBlockHash,
      eventsHash: block.eventsHash,
      events: structuredClone(block.events),
    }));
    const matching = {
      from: leaderId,
      jurisdictionRef,
      baseHeight: 0,
      scannedThroughHeight: 12,
      tipBlockHash: blockHash(12),
      eventHistoryRoot: foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [first, later]),
      rangeHash: canonicalJEventRangeHash(jurisdictionRef, blocks),
      blocks,
      signature: '0xsig',
      observedAt: 12,
    };

    const reconciled = reconcileJEventRangeWithFinalizedState(entityState, matching);
    expect(reconciled.kind).toBe('suffix');
    if (reconciled.kind === 'suffix') {
      expect(reconciled.baseHeight).toBe(10);
      expect(reconciled.blocks.map((block) => block.blockNumber)).toEqual([12]);
    }

    const conflicting = structuredClone(matching);
    conflicting.blocks[0]!.blockHash = `0x${'cc'.repeat(32)}`;
    expect(() => reconcileJEventRangeWithFinalizedState(entityState, conflicting))
      .toThrow('J_RANGE_FINALIZED_PREFIX_CONFLICT:7');
  });

  test('treats a fully finalized matching range as an idempotent no-op', () => {
    const entityState = state();
    const finalized = eventBlock(7, '7');
    entityState.lastFinalizedJHeight = 10;
    entityState.jBlockChain = [{
      jurisdictionRef,
      jHeight: finalized.jHeight,
      jBlockHash: finalized.jBlockHash,
      eventsHash: finalized.eventsHash,
      events: structuredClone(finalized.events),
      finalizedAt: entityState.timestamp,
      proposerSignerId: leaderId,
      proposerSignature: '0xsig',
    }];
    entityState.jHistoryFinality = {
      jurisdictionRef,
      baseHeight: 0,
      finalizedThroughHeight: 10,
      tipBlockHash: blockHash(10),
      eventHistoryRoot: foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [finalized]),
      proposerSignerId: leaderId,
      proposerSignature: '0xsig',
      entityHeight: entityState.height,
    };
    const blocks = [{
      blockNumber: finalized.jHeight,
      blockHash: finalized.jBlockHash,
      eventsHash: finalized.eventsHash,
      events: structuredClone(finalized.events),
    }];
    const result = reconcileJEventRangeWithFinalizedState(entityState, {
      from: leaderId,
      jurisdictionRef,
      baseHeight: 0,
      scannedThroughHeight: 10,
      tipBlockHash: blockHash(10),
      eventHistoryRoot: entityState.jHistoryFinality.eventHistoryRoot,
      rangeHash: canonicalJEventRangeHash(jurisdictionRef, blocks),
      blocks,
      signature: '0xsig',
      observedAt: 10,
    });

    expect(result).toEqual({ kind: 'noop' });
    expect(() => reconcileJEventRangeWithFinalizedState(entityState, {
      from: leaderId,
      jurisdictionRef,
      baseHeight: 0,
      scannedThroughHeight: 7,
      tipBlockHash: `0x${'ab'.repeat(32)}`,
      eventHistoryRoot: entityState.jHistoryFinality!.eventHistoryRoot,
      rangeHash: canonicalJEventRangeHash(jurisdictionRef, blocks),
      blocks,
      signature: '0xsig',
      observedAt: 7,
    })).toThrow('J_RANGE_FINALIZED_TIP_CONFLICT:7');
  });

  test('starts history at registration and orders events by EVM log position', () => {
    expect(getJHistoryRegistrationBaseHeight({ registrationBlock: 91 })).toBe(90);
    expect(getJHistoryRegistrationBaseHeight({ registrationBlock: 1 })).toBe(0);

    const later = { ...reserveEvent(12, '5'), logIndex: 42 };
    const earlier = { ...reserveEvent(12, '7'), logIndex: 41 };
    const canonicalHash = canonicalJurisdictionEventsHash([earlier, later]);

    expect(canonicalJurisdictionEventsHash([later, earlier])).toBe(canonicalHash);
    expect([later, earlier].sort(compareCanonicalJurisdictionEvents)).toEqual([earlier, later]);
  });
});
