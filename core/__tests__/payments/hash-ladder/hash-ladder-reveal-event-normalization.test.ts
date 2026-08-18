import { describe, expect, test } from 'bun:test';

import { normalizeJurisdictionEvent } from '../../../jurisdiction/machine/events/event-normalization';

const bytes32 = (byte: string): string => `0x${byte.repeat(64)}`;

const revealData = {
  entity: bytes32('1'),
  counterpartyEntity: bytes32('2'),
  ladderHash: bytes32('3'),
  fillRatio: 0x1234,
  fullSecret: bytes32('4'),
  reveals: [bytes32('5'), bytes32('6'), bytes32('7'), bytes32('8')],
  targetRole: true,
  revealedAt: 1_700_000_000,
} as const;

describe('HashLadderRevealRegistered event normalization', () => {
  test('preserves writer identity, role, commitment and L1 timestamp', () => {
    expect(normalizeJurisdictionEvent({
      type: 'HashLadderRevealRegistered',
      data: revealData,
    })).toEqual({
      type: 'HashLadderRevealRegistered',
      data: revealData,
    });
  });

  test('fails closed if any settlement-security field is absent', () => {
    // None of these fields is display-only. Omitting one could rebind a ladder,
    // select the other signed role, or bypass its window.
    for (const field of Object.keys(revealData)) {
      const malformed = { ...revealData } as Record<string, unknown>;
      delete malformed[field];
      expect(normalizeJurisdictionEvent({
        type: 'HashLadderRevealRegistered',
        data: malformed,
      })).toBeNull();
    }
  });

  test('does not coerce a numeric role into a boolean role', () => {
    expect(normalizeJurisdictionEvent({
      type: 'HashLadderRevealRegistered',
      data: { ...revealData, targetRole: 1 },
    })).toBeNull();
  });

  test('rejects ratios outside the contract uint16 domain', () => {
    expect(normalizeJurisdictionEvent({
      type: 'HashLadderRevealRegistered',
      data: { ...revealData, fillRatio: 0 },
    })).toBeNull();
    expect(normalizeJurisdictionEvent({
      type: 'HashLadderRevealRegistered',
      data: { ...revealData, fillRatio: 0xffff },
    })).toEqual({
      type: 'HashLadderRevealRegistered',
      data: { ...revealData, fillRatio: 0xffff },
    });
    expect(normalizeJurisdictionEvent({
      type: 'HashLadderRevealRegistered',
      data: { ...revealData, fillRatio: 0x1_0000 },
    })).toBeNull();
  });
});
