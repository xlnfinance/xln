import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildDeterministicSwapOfferId } from '../../../account/swap/swap-command-route';
import { LIMITS } from '../../../config/constants';
import { compareCanonicalText, isCanonicalOfferId, SWAP_OFFER_ID_REJECTION } from '../../../orderbook/swap-keys';
import { safeStringify } from '../../../protocol/serialization';
import { executeSwapOfferIdAccountSemanticVector } from '../../../../rscore/fixtures/account-semantics/swap-offer-id';

// Rust replays this exact file in rscore/crates/engine/tests/monetary/swap_offer_id.rs.
test('swap_offer offerId admission matches the shared TypeScript semantic vector', async () => {
  const actual = await executeSwapOfferIdAccountSemanticVector();
  const expected = readFileSync(
    join(import.meta.dir, '../../../../rscore/fixtures/account-semantics/swap-offer-id-v1.json'),
    'utf8',
  );
  expect(`${safeStringify(actual, 2)}\n`).toBe(expected);
  for (const testCase of actual.cases) {
    const canonical = isCanonicalOfferId(testCase.offerId);
    expect(testCase.verdict, safeStringify(testCase.offerId)).toBe(canonical ? 'applied' : 'rejected');
    if (!canonical) expect(testCase.message).toBe(SWAP_OFFER_ID_REJECTION);
  }
});

test('an admitted offerId fits the book page order id and sorts identically in UTF-16 and UTF-8', async () => {
  const { cases } = await executeSwapOfferIdAccountSemanticVector();
  const admitted = cases.filter(testCase => testCase.verdict === 'applied').map(testCase => testCase.offerId);
  const longest = Math.max(...admitted.map(offerId => new TextEncoder().encode(offerId).length));
  expect(longest).toBe(LIMITS.MAX_SWAP_OFFER_ID_LENGTH);
  // 0x + 64 hex Entity id, ':' separator, offerId: the page order-id bound is 323 bytes.
  expect(66 + 1 + longest).toBe(323);
  const byCodeUnit = [...admitted].sort(compareCanonicalText);
  const byUtf8 = [...admitted].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  expect(byCodeUnit).toEqual(byUtf8);
  // The rejected high-Unicode pair is the counterexample: the two orders disagree.
  expect(compareCanonicalText('￿', '\u{10000}')).toBe(1);
  expect(Buffer.compare(Buffer.from('￿'), Buffer.from('\u{10000}'))).toBe(-1);
});

test('the deterministic swap command offerId is canonical', () => {
  const offerId = buildDeterministicSwapOfferId({
    logicalTimestamp: 1_760_000_000_000,
    logicalHeight: 123_456,
    sourceEntityId: `0x${'ab'.repeat(32)}`,
    counterpartyEntityId: `0x${'cd'.repeat(32)}`,
    sellToken: 2,
    buyToken: 1,
    sellAmount: 10n ** 18n,
    buyAmount: 2_500_000n,
    priceTicks: 25_000n,
    routeValue: 'same',
  });
  expect(isCanonicalOfferId(offerId)).toBe(true);
});
