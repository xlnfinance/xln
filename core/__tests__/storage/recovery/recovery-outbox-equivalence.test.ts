import { expect, test } from 'bun:test';

import { assertRecoveryOutboxMatches } from '../../../storage/recovery/journal/verification';
import { prepareRuntimeOutputPayloadRows } from '../../../storage/wal/outbox-payload';
import type { RoutedEntityInput } from '../../../runtime/types';

const output = (targetByte: string): RoutedEntityInput => ({
  runtimeId: `0x${targetByte.repeat(20)}`,
  entityId: `0x${'22'.repeat(32)}`,
  signerId: `0x${'33'.repeat(20)}`,
  sourceRuntimeFrame: { height: 7, timestamp: 9_000 },
  entityTxs: [],
});

test('recovery replay requires the exact ordered committed outbox hashes', () => {
  const expected = [output('1a'), output('1b')];
  const refs = prepareRuntimeOutputPayloadRows(expected).refs;
  expect(() => assertRecoveryOutboxMatches(expected, expected, refs, 7)).not.toThrow();
  expect(() => assertRecoveryOutboxMatches(expected, [...expected].reverse(), refs, 7))
    .toThrow('RECOVERY_JOURNAL_OUTBOX_HASH_MISMATCH:height=7');
  expect(() => assertRecoveryOutboxMatches(expected, [output('1c'), expected[1]!], refs, 7))
    .toThrow('RECOVERY_JOURNAL_OUTBOX_HASH_MISMATCH:height=7');
});
