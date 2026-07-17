import { describe, expect, test } from 'bun:test';

import { signAccountFrame, deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import { applyJEvent } from '../entity/tx/j-events';
import { canonicalJurisdictionEventsHash } from '../jurisdiction/event-observation';
import {
  buildJEventRangeDigest,
  canonicalJEventRangeHash,
  EMPTY_J_HISTORY_ROOT,
  foldJHistoryRoot,
} from '../jurisdiction/history-consensus';
import {
  assertCertifiedJHistoryIntegrity,
  finalizedJHistoryRoot,
  MAX_CERTIFIED_J_EVENT_BLOCKS,
  reconcileJEventRangeWithFinalizedState,
} from '../jurisdiction/local-history';
import { advanceCertifiedBoardFinality } from '../jurisdiction/board-registry';
import { createEmptyEnv } from '../runtime';
import { hydrateEntityStateFromStorage, projectEntityCoreDoc } from '../storage/projections';
import type {
  EntityState,
  JurisdictionEvent,
  JurisdictionEventData,
  ValidatorJEventBlock,
} from '../types';

const depositoryAddress = `0x${'dd'.repeat(20)}`;
const entityProviderAddress = `0x${'aa'.repeat(20)}`;
const jurisdictionRef = `stack:31337:${depositoryAddress}`;
const entityId = `0x${'ee'.repeat(32)}`;
const previousFrameHash = `0x${'ab'.repeat(32)}`;
const blockHash = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`;

const reserveEvent = (height: number): JurisdictionEvent => ({
  blockNumber: height,
  blockHash: blockHash(height),
  transactionHash: `0x${(height + 10_000).toString(16).padStart(64, '0')}`,
  logIndex: 0,
  type: 'ReserveUpdated',
  data: { entity: entityId, tokenId: 1, newBalance: String(height) },
});

const eventBlock = (height: number): ValidatorJEventBlock => {
  const events = [reserveEvent(height)];
  return {
    jurisdictionRef,
    jHeight: height,
    jBlockHash: blockHash(height),
    eventsHash: canonicalJurisdictionEventsHash(events),
    events,
  };
};

const makeState = (signerId: string, blockCount: number): EntityState => {
  const jurisdiction = {
    name: 'JHistoryPruningTestnet',
    chainId: 31337,
    depositoryAddress,
    entityProviderAddress,
  };
  const state: EntityState = {
    entityId,
    height: 4,
    prevFrameHash: previousFrameHash,
    timestamp: 100,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [signerId],
      shares: { [signerId]: 1n },
      jurisdiction,
    },
    reserves: new Map(),
    accounts: new Map(),
    lastFinalizedJHeight: blockCount,
    jBlockChain: [],
    entityEncPubKey: 'pub',
    entityEncPrivKey: 'priv',
    profile: { name: 'J history pruning', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
  };
  let root = EMPTY_J_HISTORY_ROOT;
  for (let height = 1; height <= blockCount; height += 1) {
    const block = eventBlock(height);
    root = foldJHistoryRoot(root, [block]);
    state.jBlockChain.push({
      jurisdictionRef,
      jHeight: height,
      jBlockHash: block.jBlockHash,
      eventsHash: block.eventsHash,
      events: structuredClone(block.events),
      finalizedAt: state.timestamp,
      proposerSignerId: signerId,
      proposerSignature: '0xcertified',
    });
  }
  state.jHistoryFinality = {
    jurisdictionRef,
    baseHeight: Math.max(0, blockCount - 1),
    finalizedThroughHeight: blockCount,
    tipBlockHash: blockHash(blockCount),
    eventHistoryRoot: root,
    proposerSignerId: signerId,
    proposerSignature: '0xcertified',
    entityHeight: state.height,
  };
  state.certifiedBoardState = advanceCertifiedBoardFinality(
    undefined,
    jurisdiction,
    blockCount,
    blockHash(blockCount),
    root,
  );
  return state;
};

const signedRange = (
  state: EntityState,
  signerId: string,
  env: ReturnType<typeof createEmptyEnv>,
  block: ValidatorJEventBlock,
): JurisdictionEventData => {
  const blocks = [{
    blockNumber: block.jHeight,
    blockHash: block.jBlockHash,
    eventsHash: block.eventsHash,
    events: structuredClone(block.events),
  }];
  const unsigned = {
    jurisdictionRef,
    baseHeight: state.lastFinalizedJHeight,
    scannedThroughHeight: block.jHeight,
    tipBlockHash: block.jBlockHash,
    eventHistoryRoot: foldJHistoryRoot(finalizedJHistoryRoot(state), [block]),
    rangeHash: canonicalJEventRangeHash(jurisdictionRef, blocks),
    blocks,
  };
  return {
    from: signerId,
    ...unsigned,
    signature: signAccountFrame(env, signerId, buildJEventRangeDigest({
      entityId,
      signerId,
      ...unsigned,
    })),
    observedAt: block.jHeight,
  };
};

describe('bounded Entity-certified J history', () => {
  test('keeps only current authority while old display bodies remain strictly bounded', async () => {
    const env = createEmptyEnv('j-history-checkpoint-pruning');
    const signerId = deriveSignerAddressSync(env.runtimeSeed!, 'j-history-pruning-proposer').toLowerCase();
    registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, 'j-history-pruning-proposer'));
    const before = makeState(signerId, MAX_CERTIFIED_J_EVENT_BLOCKS);
    const boardRoot = before.certifiedBoardState!.boardRegistryRoot;
    const nextRange = signedRange(before, signerId, env, eventBlock(MAX_CERTIFIED_J_EVENT_BLOCKS + 1));

    const applied = await applyJEvent(before, nextRange, env);
    const state = applied.newState;
    const currentRoot = nextRange.eventHistoryRoot;

    expect(state.jBlockChain).toHaveLength(MAX_CERTIFIED_J_EVENT_BLOCKS);
    expect(state.jBlockChain[0]!.jHeight).toBe(2);
    expect(state.jHistoryFinality).not.toHaveProperty('rangeTipAnchors');
    expect(state.jHistoryFinality).not.toHaveProperty('historyCheckpoint');
    expect(finalizedJHistoryRoot(state)).toBe(currentRoot);
    expect(state.certifiedBoardState!.boardRegistryRoot).toBe(boardRoot);
    expect(() => assertCertifiedJHistoryIntegrity(state)).not.toThrow();
    const restored = hydrateEntityStateFromStorage({
      core: structuredClone(projectEntityCoreDoc(state)),
      accounts: new Map(),
      books: new Map(),
    });
    expect(restored.jHistoryFinality).not.toHaveProperty('historyCheckpoint');
    expect(() => assertCertifiedJHistoryIntegrity(restored)).not.toThrow();

    const duplicate = await applyJEvent(state, nextRange, env);
    expect(duplicate.newState).toBe(state);

    const conflictingAuthenticated = structuredClone(nextRange);
    conflictingAuthenticated.blocks[0]!.events[0]!.data = {
      ...conflictingAuthenticated.blocks[0]!.events[0]!.data,
      newBalance: '999999',
    };
    conflictingAuthenticated.blocks[0]!.eventsHash = canonicalJurisdictionEventsHash(
      conflictingAuthenticated.blocks[0]!.events,
    );
    conflictingAuthenticated.rangeHash = canonicalJEventRangeHash(
      jurisdictionRef,
      conflictingAuthenticated.blocks,
    );
    conflictingAuthenticated.eventHistoryRoot = `0x${'ff'.repeat(32)}`;
    conflictingAuthenticated.signature = signAccountFrame(
      env,
      signerId,
      buildJEventRangeDigest({
        entityId,
        signerId,
        jurisdictionRef,
        baseHeight: conflictingAuthenticated.baseHeight,
        scannedThroughHeight: conflictingAuthenticated.scannedThroughHeight,
        tipBlockHash: conflictingAuthenticated.tipBlockHash,
        eventHistoryRoot: conflictingAuthenticated.eventHistoryRoot,
        rangeHash: conflictingAuthenticated.rangeHash,
      }),
    );
    const conflictingDuplicate = await applyJEvent(state, conflictingAuthenticated, env);
    expect(conflictingDuplicate.newState).toBe(state);

    const conflictingRetained = structuredClone(nextRange);
    conflictingRetained.blocks[0]!.blockHash = `0x${'ff'.repeat(32)}`;
    const stableSnapshot = structuredClone(state);
    expect(reconcileJEventRangeWithFinalizedState(state, conflictingRetained))
      .toEqual({ kind: 'noop' });
    expect(state).toEqual(stableSnapshot);

    const prunedBlock = eventBlock(1);
    const prunedRange: JurisdictionEventData = {
      from: signerId,
      jurisdictionRef,
      baseHeight: 0,
      scannedThroughHeight: 1,
      tipBlockHash: prunedBlock.jBlockHash,
      eventHistoryRoot: foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [prunedBlock]),
      rangeHash: canonicalJEventRangeHash(jurisdictionRef, [{
        blockNumber: prunedBlock.jHeight,
        blockHash: prunedBlock.jBlockHash,
        eventsHash: prunedBlock.eventsHash,
        events: prunedBlock.events,
      }]),
      blocks: [{
        blockNumber: prunedBlock.jHeight,
        blockHash: prunedBlock.jBlockHash,
        eventsHash: prunedBlock.eventsHash,
        events: prunedBlock.events,
      }],
      signature: '0xold',
      observedAt: 1,
    };
    expect(reconcileJEventRangeWithFinalizedState(state, prunedRange))
      .toEqual({ kind: 'noop' });
    expect(state).toEqual(stableSnapshot);

    let rolling = state;
    for (let height = MAX_CERTIFIED_J_EVENT_BLOCKS + 2; height <= 260; height += 1) {
      rolling = (await applyJEvent(rolling, signedRange(rolling, signerId, env, eventBlock(height)), env)).newState;
    }
    expect(rolling.jBlockChain).toHaveLength(MAX_CERTIFIED_J_EVENT_BLOCKS);
    expect(rolling.jHistoryFinality).not.toHaveProperty('rangeTipAnchors');
    expect(rolling.jHistoryFinality).not.toHaveProperty('historyCheckpoint');
    expect(finalizedJHistoryRoot(rolling)).toBe(rolling.jHistoryFinality!.eventHistoryRoot);
    expect(() => assertCertifiedJHistoryIntegrity(rolling)).not.toThrow();

    const corrupted = structuredClone(state);
    corrupted.jBlockChain[0]!.events[0]!.data = {
      ...corrupted.jBlockChain[0]!.events[0]!.data,
      newBalance: 'corrupt',
    };
    expect(() => assertCertifiedJHistoryIntegrity(corrupted))
      .toThrow('J_HISTORY_FINALITY_EVENT_BODY_CORRUPTION:2');
  });

  test('advances an empty current head without retaining historical tips', async () => {
    const env = createEmptyEnv('j-history-empty-tip-pruning');
    const signerId = deriveSignerAddressSync(env.runtimeSeed!, 'j-history-empty-tip-proposer').toLowerCase();
    registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, 'j-history-empty-tip-proposer'));
    const state = makeState(signerId, MAX_CERTIFIED_J_EVENT_BLOCKS);
    state.jBlockChain = [];
    state.jHistoryFinality!.eventHistoryRoot = EMPTY_J_HISTORY_ROOT;
    state.certifiedBoardState!.eventHistoryRoot = EMPTY_J_HISTORY_ROOT;
    const nextHeight = MAX_CERTIFIED_J_EVENT_BLOCKS + 1;
    const unsigned = {
      jurisdictionRef,
      baseHeight: state.lastFinalizedJHeight,
      scannedThroughHeight: nextHeight,
      tipBlockHash: blockHash(nextHeight),
      eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
      rangeHash: canonicalJEventRangeHash(jurisdictionRef, []),
      blocks: [],
    };
    const range: JurisdictionEventData = {
      from: signerId,
      ...unsigned,
      signature: signAccountFrame(env, signerId, buildJEventRangeDigest({
        entityId,
        signerId,
        ...unsigned,
      })),
      observedAt: nextHeight,
    };

    const applied = await applyJEvent(state, range, env);

    expect(applied.newState.jBlockChain).toHaveLength(0);
    expect(applied.newState.jHistoryFinality).not.toHaveProperty('rangeTipAnchors');
    expect(applied.newState.jHistoryFinality).not.toHaveProperty('historyCheckpoint');
    expect(() => assertCertifiedJHistoryIntegrity(applied.newState)).not.toThrow();
  });
});
