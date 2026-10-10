import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeStringify } from '../../protocol/serialization';
import { executeOrderbookBookParityVector } from '../../../rscore/fixtures/entity-kernel/orderbook-book';

// Rust replays this exact file in
// rscore/crates/entity-kernel/src/orderbook/tests/book_parity.rs.
test('orderbook book operations match the shared TypeScript book vector', () => {
  const actual = executeOrderbookBookParityVector();
  const expected = readFileSync(
    join(import.meta.dir, '../../../rscore/fixtures/entity-kernel/orderbook-book-v1.json'),
    'utf8',
  );
  expect(`${safeStringify(actual, 2)}\n`).toBe(expected);
  expect(actual.cases.map(testCase => testCase.name)).toEqual([
    'resume-stp-cancels-resting-taker',
    'resume-skips-suspended-taker',
    'resume-takes-newest-eligible-order',
    'out-of-band-sweep-cancel-order',
  ]);
});

test('a crossed resume that hits self-trade prevention cancels the resting taker', () => {
  const stp = executeOrderbookBookParityVector().cases
    .find(testCase => testCase.name === 'resume-stp-cancels-resting-taker');
  const [rested, crossed, resumed] = stp?.steps.map(step => step.expected) ?? [];
  expect(crossed?.orderIds).toEqual(['x:ask', 'x:bid']);
  expect(resumed?.events).toEqual(['REJECT:STP cancel taker:x:ask']);
  expect(resumed?.takerOrderId).toBe('x:bid');
  expect(resumed?.orderIds).toEqual(['x:ask']);
  // The taker leaves the book through a cancel, so the event hash moves even
  // though the remaining page tree equals the one after the first ask rested.
  expect(resumed?.eventHash).not.toBe(crossed?.eventHash);
  expect(resumed?.eventHash).not.toBe(rested?.eventHash);
});
