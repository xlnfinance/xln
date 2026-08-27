import { expect, test } from 'bun:test';

import { assertRecoveryOutboxMatches } from '../../../storage/recovery/journal/verification';
import { prepareRuntimeOutputRows } from '../../../storage/wal/outbox-payload';
import type { RoutedEntityInput } from '../../../runtime/types';

const output = (targetByte: string): RoutedEntityInput => ({
  runtimeId: `0x${targetByte.repeat(20)}`,
  entityId: `0x${'22'.repeat(32)}`,
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
