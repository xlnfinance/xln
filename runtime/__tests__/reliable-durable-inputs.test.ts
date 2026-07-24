import { describe, expect, test } from 'bun:test';

import { mergeDurableReceiptOnlyInputs } from '../machine/reliable-durable-inputs';
import { getInputReliableIdentity } from '../machine/reliable-receipt';
import { reliableIdentityExactKey } from '../machine/reliable-frontier';
import { splitRoutedOutputByDeliveryLane } from '../machine/output-routing';
import { safeStringify } from '../protocol/serialization';
import type { RoutedEntityInput } from '../types';

const entityId = (value: number): string =>
  `0x${value.toString(16).padStart(64, '0')}`;
const signerId = (value: number): string =>
  `0x${value.toString(16).padStart(40, '0')}`;
const runtimeId = (value: number): string =>
  `0x${value.toString(16).padStart(40, '0')}`;

const frameInput = (index: number, from?: string): RoutedEntityInput => ({
  ...(from ? { from } : {}),
  entityId: entityId(index + 1),
  signerId: signerId(index + 1),
  proposedFrame: {
    height: 1,
    parentFrameHash: 'genesis',
    stateRoot: `0x${'11'.repeat(32)}`,
    authorityRoot: `0x${'22'.repeat(32)}`,
    timestamp: 1,
    hash: `0x${index.toString(16).padStart(64, '0')}`,
    txs: [],
    leader: { proposerSignerId: signerId(index + 1), view: 0 },
    collectedSigs: new Map(),
  },
});

const quadraticReference = (
  appliedInputs: readonly RoutedEntityInput[],
  receiptOnlyInputs: readonly RoutedEntityInput[],
): RoutedEntityInput[] => {
  const persisted = [...appliedInputs];
  for (const input of receiptOnlyInputs) {
    const source = String(input.from || '').trim().toLowerCase();
    if (!source) throw new Error('RUNTIME_RELIABLE_DURABLE_INPUT_SOURCE_MISSING');
    const identity = getInputReliableIdentity(input);
    const key = identity ? reliableIdentityExactKey(identity) : null;
    const matchingIndex = key === null ? -1 : persisted.findIndex(candidate =>
      splitRoutedOutputByDeliveryLane(candidate).some((lane) => {
        const candidateIdentity = getInputReliableIdentity(lane);
        return candidateIdentity !== null &&
          reliableIdentityExactKey(candidateIdentity) === key;
      }));
    if (matchingIndex < 0) {
      persisted.push({ ...input, from: source });
      continue;
    }
    const existing = persisted[matchingIndex]!;
    if (!existing.from) persisted[matchingIndex] = { ...existing, from: source };
    else if (existing.from.toLowerCase() !== source) {
      throw new Error(
        `RUNTIME_RELIABLE_APPLIED_INPUT_SOURCE_CONFLICT:` +
        `${existing.from.toLowerCase()}:${source}`,
      );
    }
  }
  return persisted;
};

describe('durable receipt-only input merge', () => {
  test('is byte-identical to first-match semantics for a 1000-input wave', () => {
    const applied = Array.from({ length: 1_000 }, (_, index) => frameInput(index));
    const receipts = applied.map((input, index) => ({
      ...structuredClone(input),
      from: runtimeId((index % 7) + 1),
    }));
    expect(safeStringify(mergeDurableReceiptOnlyInputs(applied, receipts)))
      .toBe(safeStringify(quadraticReference(applied, receipts)));
  });

  test('appends an unseen identity once and rejects conflicting provenance', () => {
    const applied = [frameInput(1)];
    const unseen = frameInput(2, runtimeId(1));
    const merged = mergeDurableReceiptOnlyInputs(applied, [unseen, structuredClone(unseen)]);
    expect(merged).toHaveLength(2);
    expect(merged[1]?.from).toBe(runtimeId(1));

    expect(() => mergeDurableReceiptOnlyInputs(
      [frameInput(3, runtimeId(1))],
      [frameInput(3, runtimeId(2))],
    )).toThrow('RUNTIME_RELIABLE_APPLIED_INPUT_SOURCE_CONFLICT');
  });
});
