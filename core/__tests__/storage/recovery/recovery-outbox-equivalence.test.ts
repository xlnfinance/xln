import { expect, test } from 'bun:test';

import {
  assertRecoveryOutboxMatches,
  collectCurrentOutputSignerHints,
  selectRetainedRecoveryOutbox,
} from '../../../storage/recovery/journal/verification';
import { prepareRuntimeOutputRows } from '../../../storage/wal/outbox-payload';
import type { RoutedEntityInput } from '../../../runtime/types';

const output = (targetByte: string): RoutedEntityInput => ({
  runtimeId: `0x${targetByte.repeat(20)}`,
  entityId: `0x${targetByte.repeat(32)}`,
  signerId: `0x${'33'.repeat(20)}`,
  sourceRuntimeFrame: { height: 7, timestamp: 9_000 },
  entityTxs: [],
});

test('recovery replay requires the exact ordered committed outbox bytes', () => {
  const expected = [output('1a'), output('1b')];
  const commitment = prepareRuntimeOutputRows(7, expected).commitment;
  expect(() => assertRecoveryOutboxMatches(expected, expected, commitment, 7)).not.toThrow();
  expect(() => assertRecoveryOutboxMatches(expected, [...expected].reverse(), commitment, 7))
    .toThrow('RECOVERY_JOURNAL_OUTBOX_HASH_MISMATCH:height=7');
  expect(() => assertRecoveryOutboxMatches(expected, [output('1c'), expected[1]!], commitment, 7))
    .toThrow('RECOVERY_JOURNAL_OUTBOX_HASH_MISMATCH:height=7');
});

test('an outbox mismatch reports commitments and the first differing index, never the outputs', () => {
  // The message embedded both full output lists; a Hub frame holds up to
  // 10_000 outputs, so one divergence wrote megabytes of WAL payload to logs.
  const sentinel = 'outbox-diagnostic-payload-sentinel';
  const expected = [output('1a'), { ...output('1b'), signerId: sentinel }];
  const commitment = prepareRuntimeOutputRows(7, expected).commitment;
  let message = '';
  try {
    assertRecoveryOutboxMatches(expected, [expected[0]!, output('1c')], commitment, 7);
  } catch (error) {
    message = String((error as Error).message);
  }
  expect(message).toStartWith('RECOVERY_JOURNAL_OUTBOX_HASH_MISMATCH:height=7:');
  expect(message).toContain('"firstDifferentIndex":1');
  expect(message).not.toContain(sentinel);
});

test('deferred frame N output survives unrelated N+1 and retires independently in N+2', () => {
  const first = output('1a');
  const second = output('1b');
  const previous = [first, second];
  const next = selectRetainedRecoveryOutbox(previous, structuredClone(previous), 8);
  expect(next).toEqual(previous);
  expect(next[0]).toBe(first);
  const commitment = prepareRuntimeOutputRows(8, next).commitment;
  expect(() => assertRecoveryOutboxMatches(previous, next, commitment, 8)).not.toThrow();
  expect(selectRetainedRecoveryOutbox(next, [second], 9)).toEqual([second]);
  expect(selectRetainedRecoveryOutbox([second], [], 10)).toEqual([]);
});

test('retained WAL rows cannot fabricate, alter, repeat, or reorder previous output evidence', () => {
  const previous = [output('1a'), output('1b')];
  expect(() => selectRetainedRecoveryOutbox(previous, [output('1c')], 8))
    .toThrow('RECOVERY_OUTBOX_RETAINED_OUTPUT_UNPROVEN');
  expect(() => selectRetainedRecoveryOutbox(previous, [
    { ...previous[0]!, sourceRuntimeFrame: { height: 6, timestamp: 9_000 } },
  ], 8)).toThrow('RECOVERY_OUTBOX_RETAINED_OUTPUT_UNPROVEN');
  expect(() => selectRetainedRecoveryOutbox(previous, [...previous].reverse(), 8))
    .toThrow('RECOVERY_OUTBOX_RETAINED_ORDER_INVALID');
  expect(() => selectRetainedRecoveryOutbox(previous, [previous[0]!, previous[0]!], 8))
    .toThrow('RECOVERY_OUTBOX_RETAINED_ORDER_INVALID');
});

test('retained output permits a new Runtime route without changing its financial evidence', () => {
  const previous = output('1a');
  const rebound = { ...previous, runtimeId: `0x${'1b'.repeat(20)}` };
  expect(selectRetainedRecoveryOutbox([previous], [rebound], 8)).toEqual([rebound]);
  expect(() => selectRetainedRecoveryOutbox([previous], [{ ...rebound, signerId: `0x${'44'.repeat(20)}` }], 8))
    .toThrow('RECOVERY_OUTBOX_RETAINED_OUTPUT_UNPROVEN');
});

test('a peer re-announcing a new signer never bricks replay through a retained output', () => {
  // The retained frame-7 output still names signer 33; the peer re-announced
  // and frame 8 sent to signer 44. Hints from both made replay throw a
  // signer conflict on every restart.
  const accountInput = { type: 'accountInput', data: {} } as RoutedEntityInput['entityTxs'][number];
  const retained = { ...output('1a'), entityTxs: [accountInput] };
  const current = {
    ...retained,
    signerId: `0x${'44'.repeat(20)}`,
    sourceRuntimeFrame: { height: 8, timestamp: 9_500 },
  };
  expect(collectCurrentOutputSignerHints([retained, current], 8))
    .toEqual(new Map([[current.entityId, current.signerId]]));
  expect(() => collectCurrentOutputSignerHints([current, { ...current, signerId: `0x${'55'.repeat(20)}` }], 8))
    .toThrow('RECOVERY_OUTPUT_SIGNER_HINT_CONFLICT');
});
