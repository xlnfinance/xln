import { describe, expect, test } from 'bun:test';
import {
  buildJEventRangeDigest,
  canonicalJEventRangeHash,
  EMPTY_J_HISTORY_ROOT,
  foldJHistoryRoot,
  getJHistoryRegistrationBaseHeight,
} from '../jurisdiction/history-consensus';
import { canonicalJurisdictionEventsHash } from '../jurisdiction/event-observation';
import { compareCanonicalJurisdictionEvents } from '../jurisdiction/event-normalization';
import { createEntityFrameHash } from '../entity/consensus/frame';
import { applyEntityInput } from '../entity/consensus/index';
import { createEmptyEnv } from '../runtime';
import { applyRuntimeTx } from '../machine/tx-handlers';
import {
  buildUnsignedJEventRange,
  getValidatorJExpectedBlockHash,
  getJEventRangeValidationError,
  pruneFinalizedValidatorJHistory,
  recordValidatorJHistory,
  rewindValidatorJHistory,
} from '../jurisdiction/local-history';
import type { EntityReplica, EntityState, JurisdictionEvent, ValidatorJEventBlock } from '../types';

const jurisdictionRef = 'eip155:31337:0xdepository';
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
