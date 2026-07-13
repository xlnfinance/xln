import { describe, expect, test } from 'bun:test';
import {
  buildJHistoryCheckpointDigest,
  EMPTY_J_HISTORY_ROOT,
  foldJHistoryRoot,
  getJHistoryRegistrationBaseHeight,
} from '../jurisdiction/history-consensus';
import { canonicalJurisdictionEventsHash } from '../jurisdiction/event-observation';
import { compareCanonicalJurisdictionEvents } from '../jurisdiction/event-normalization';
import type { JurisdictionEvent } from '../types';

const observation = (height: number, blockHash: string, eventsHash: string) => ({
  jurisdictionRef: 'eip155:31337:0xdepository',
  jHeight: height,
  jBlockHash: blockHash,
  eventsHash,
});

describe('J validator history accumulator', () => {
  test('is independent of delivery order but never unions conflicting histories', () => {
    const first = observation(7, '0xblock7', `0x${'11'.repeat(32)}`);
    const second = observation(9, '0xblock9', `0x${'22'.repeat(32)}`);
    const ordered = foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [first, second]);
    const reversed = foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [second, first]);
    const omitted = foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [first]);

    expect(reversed).toBe(ordered);
    expect(omitted).not.toBe(ordered);
  });

  test('rejects two event bodies claimed at one jurisdiction height', () => {
    expect(() => foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [
      observation(7, '0xblock7', `0x${'11'.repeat(32)}`),
      observation(7, '0xblock7', `0x${'22'.repeat(32)}`),
    ])).toThrow('J_HISTORY_EQUIVOCATION_AT_HEIGHT:7');
  });

  test('checkpoint digest binds signer, range, tip and exact history root', () => {
    const root = foldJHistoryRoot(EMPTY_J_HISTORY_ROOT, [
      observation(7, '0xblock7', `0x${'11'.repeat(32)}`),
    ]);
    const base = {
      entityId: '0xentity',
      jurisdictionRef: 'eip155:31337:0xdepository',
      signerId: '0xsigner',
      baseHeight: 0,
      scannedThroughHeight: 10,
      tipBlockHash: '0xtip10',
      eventHistoryRoot: root,
    };
    const digest = buildJHistoryCheckpointDigest(base);

    expect(buildJHistoryCheckpointDigest({ ...base })).toBe(digest);
    expect(buildJHistoryCheckpointDigest({ ...base, scannedThroughHeight: 11 })).not.toBe(digest);
    expect(buildJHistoryCheckpointDigest({ ...base, signerId: '0xother' })).not.toBe(digest);
  });

  test('starts jurisdiction history at the entity registration block', () => {
    expect(getJHistoryRegistrationBaseHeight({ registrationBlock: 91 })).toBe(90);
    expect(getJHistoryRegistrationBaseHeight({ registrationBlock: 1 })).toBe(0);
    expect(getJHistoryRegistrationBaseHeight({})).toBe(0);
    expect(getJHistoryRegistrationBaseHeight({ registrationBlock: -1 })).toBe(0);
  });

  test('orders events inside a jurisdiction block by EVM log position', () => {
    const reserveAtSeven: JurisdictionEvent = {
      blockNumber: 12,
      blockHash: `0x${'12'.repeat(32)}`,
      transactionHash: `0x${'34'.repeat(32)}`,
      logIndex: 41,
      type: 'ReserveUpdated',
      data: { entity: '0xentity', tokenId: 1, newBalance: '7000000' },
    };
    const reserveAtFive: JurisdictionEvent = {
      ...reserveAtSeven,
      logIndex: 42,
      type: 'ReserveUpdated',
      data: { entity: '0xentity', tokenId: 1, newBalance: '5000000' },
    };
    const canonicalHash = canonicalJurisdictionEventsHash([reserveAtSeven, reserveAtFive]);

    expect(canonicalJurisdictionEventsHash([reserveAtFive, reserveAtSeven])).toBe(canonicalHash);
    expect(canonicalJurisdictionEventsHash([
      { ...reserveAtSeven, logIndex: 42 },
      { ...reserveAtFive, logIndex: 41 },
    ])).not.toBe(canonicalHash);
    expect([reserveAtFive, reserveAtSeven].sort(compareCanonicalJurisdictionEvents))
      .toEqual([reserveAtSeven, reserveAtFive]);
  });
});
