import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../../../account/crypto';
import { applyJEvent } from '../../../entity/tx/j-events';
import { canonicalJurisdictionEventsHash } from '../../../jurisdiction/machine/event-observation';
import {
  buildJEventRangeDigest,
  canonicalJEventRangeHash,
  EMPTY_J_HISTORY_ROOT,
  foldJHistoryRoot,
} from '../../../jurisdiction/machine/history-consensus';
import {
  assertCertifiedJHistoryIntegrity,
  finalizedJHistoryRoot,
  reconcileJEventRangeWithFinalizedState,
} from '../../../jurisdiction/machine/local-history';
import { advanceCertifiedBoardFinality } from '../../../jurisdiction/machine/board-registry';
import { createEmptyEnv } from '../../../runtime';
import { emptyEntityAccountMap } from '../../helpers/entity-account-map';
import { hydrateEntityStateFromStorage, projectEntityCoreDoc } from '../../../storage/read/projections';
import type { EntityState } from '../../../entity/types';
import type { JurisdictionEvent, JurisdictionEventData, ValidatorJEventBlock } from '../../../types/jurisdiction-events';

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
  data: { entity: entityId, tokenId: '1', newBalance: String(height) },
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

const makeState = (signerId: string, finalizedThroughHeight: number): EntityState => {
  const jurisdiction = {
    name: 'JHistoryAnchorTestnet',
    chainId: 31337,
    depositoryAddress,
    entityProviderAddress,
  };
  let eventHistoryRoot = EMPTY_J_HISTORY_ROOT;
  for (let height = 1; height <= finalizedThroughHeight; height += 1) {
    eventHistoryRoot = foldJHistoryRoot(eventHistoryRoot, [eventBlock(height)]);
  }
  return {
    entityId,
    height: 4,
    prevFrameHash: previousFrameHash,
    timestamp: 100,
    nonces: new Map(),
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [signerId],
      shares: { [signerId]: 1n },
      jurisdiction,
    },
    reserves: new Map(),
    accounts: emptyEntityAccountMap(entityId),
    lastFinalizedJHeight: finalizedThroughHeight,
    jHistoryFinality: {
      jurisdictionRef,
      baseHeight: Math.max(0, finalizedThroughHeight - 1),
      finalizedThroughHeight,
      tipBlockHash: blockHash(finalizedThroughHeight),
      eventHistoryRoot,
      proposerSignerId: signerId,
      proposerSignature: '0xcertified',
      entityHeight: 4,
    },
    certifiedBoardState: advanceCertifiedBoardFinality(
      undefined,
      jurisdiction,
      finalizedThroughHeight,
      blockHash(finalizedThroughHeight),
      eventHistoryRoot,
    ),
    profile: { name: 'J history anchor', isHub: false, avatar: '', bio: '', website: '' },
    paybook: { entries: new Map(), feesEarned: 0n },
  };
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

describe('single-anchor Entity-certified J history', () => {
  test('advances only the certified anchor and retains no Entity display-history copy', async () => {
    const env = createEmptyEnv('j-history-single-anchor');
    const signerId = deriveSignerAddressSync(env.runtimeSeed!, 'j-history-anchor-proposer').toLowerCase();
    registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, 'j-history-anchor-proposer'));
    const before = makeState(signerId, 3);
    const range = signedRange(before, signerId, env, eventBlock(4));

    const state = (await applyJEvent(before, range, env)).newState;

    expect(state.lastFinalizedJHeight).toBe(4);
    expect(state.jHistoryFinality?.tipBlockHash).toBe(blockHash(4));
    expect(state.jHistoryFinality?.eventHistoryRoot).toBe(range.eventHistoryRoot);
    expect(state.jBlockChain).toBeUndefined();
    expect(() => assertCertifiedJHistoryIntegrity(state)).not.toThrow();

    const restored = hydrateEntityStateFromStorage({
      core: structuredClone(projectEntityCoreDoc(state)),
      accounts: new Map(),
      books: new Map(),
    });
    expect(restored.jBlockChain).toBeUndefined();
    expect(restored.jHistoryFinality).toEqual(state.jHistoryFinality);
    expect(() => assertCertifiedJHistoryIntegrity(restored)).not.toThrow();

    expect((await applyJEvent(state, range, env)).newState).toBe(state);
    const stale = signedRange(makeState(signerId, 1), signerId, env, eventBlock(2));
    expect(reconcileJEventRangeWithFinalizedState(state, stale)).toEqual({ kind: 'noop' });
  });

  test('advances an empty certified head without creating historical bodies', async () => {
    const env = createEmptyEnv('j-history-empty-anchor');
    const signerId = deriveSignerAddressSync(env.runtimeSeed!, 'j-history-empty-proposer').toLowerCase();
    registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, 'j-history-empty-proposer'));
    const state = makeState(signerId, 3);
    const unsigned = {
      jurisdictionRef,
      baseHeight: 3,
      scannedThroughHeight: 4,
      tipBlockHash: blockHash(4),
      eventHistoryRoot: finalizedJHistoryRoot(state),
      rangeHash: canonicalJEventRangeHash(jurisdictionRef, []),
      blocks: [],
    };
    const range: JurisdictionEventData = {
      from: signerId,
      ...unsigned,
      signature: signAccountFrame(env, signerId, buildJEventRangeDigest({ entityId, signerId, ...unsigned })),
      observedAt: 4,
    };

    const next = (await applyJEvent(state, range, env)).newState;

    expect(next.lastFinalizedJHeight).toBe(4);
    expect(next.jHistoryFinality?.eventHistoryRoot).toBe(finalizedJHistoryRoot(state));
    expect(next.jBlockChain).toBeUndefined();
    expect(() => assertCertifiedJHistoryIntegrity(next)).not.toThrow();
  });
});
