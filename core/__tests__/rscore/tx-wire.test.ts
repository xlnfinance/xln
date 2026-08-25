import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { packWireValue, unpackWireValue } from '../../rscore/client';
import { accountTxWire } from '../../rscore/shadow-wire';
import { decodeRscoreAccountTx } from '../../rscore/wave-decode';
import type { AccountTx } from '../../types/account';

/**
 * The transaction wire is a contract between two languages, and each side
 * being self-consistent is exactly what a silent disagreement also looks
 * like. These vectors are the shared bytes: this file holds TypeScript to
 * them, and crates/process/tests/tx_wire_vectors.rs holds Rust to the same
 * file.
 *
 * Scope: the payment-profile transactions, which is what the two engines
 * currently both execute — payments, HTLCs, deltas, credit limits, rebalance
 * policy and same-jurisdiction swaps. Settlement, lending, disputes,
 * J-events and every cross-jurisdiction transaction are deliberately absent,
 * because no Rust codec claims them yet. This corpus is not "every
 * AccountTx", and a transaction missing from it is not a covered one.
 *
 * Every case appears twice — once with every optional field present, once
 * with none — because absent and present take different branches on both
 * sides, and a codec that only ever sees one shape is only half tested.
 *
 * To regenerate after a transaction gains a field, run the generator at the
 * bottom of this file and review the diff: a changed vector is a changed
 * protocol.
 */

const VECTORS = join(import.meta.dir, 'tx-wire-vectors.json');

const HASHLOCK = `0x${'ab'.repeat(32)}`;
const SECRET = `0x${'cd'.repeat(32)}`;
const A = `0x${'aa'.repeat(32)}`;
const B = `0x${'bb'.repeat(32)}`;

export const TX_WIRE_CASES: { name: string; tx: AccountTx }[] = [
  { name: 'direct_payment/full', tx: { type: 'direct_payment', data: { tokenId: 1, amount: 25n, route: [B], description: 'memo', fromEntityId: A, toEntityId: B, deliveryMode: 'trusted', trustedGatewayEntityId: B } } },
  { name: 'direct_payment/minimal', tx: { type: 'direct_payment', data: { tokenId: 1, amount: 1n, route: [], fromEntityId: A, toEntityId: B, deliveryMode: 'direct' } } },
  { name: 'htlc_lock/full', tx: { type: 'htlc_lock', data: { lockId: 'lock-1', hashlock: HASHLOCK, timelock: 1_700_000_000_000n, revealBeforeHeight: 12, amount: 500n, tokenId: 1, deliveryMode: 'async' } } },
  { name: 'htlc_lock/envelope', tx: { type: 'htlc_lock', data: { lockId: 'lock-3', hashlock: HASHLOCK, timelock: 1_700_000_000_000n, revealBeforeHeight: 5, amount: 10n, tokenId: 1, deliveryMode: 'instant', envelope: { ciphertext: Buffer.alloc(80, 0x5a).toString('base64') } } } },
  { name: 'htlc_lock/minimal', tx: { type: 'htlc_lock', data: { lockId: 'lock-2', hashlock: HASHLOCK, timelock: 1n, revealBeforeHeight: 0, amount: 1n, tokenId: 1 } } },
  { name: 'htlc_resolve/secret', tx: { type: 'htlc_resolve', data: { lockId: 'lock-1', outcome: 'secret', secret: SECRET } } },
  { name: 'htlc_resolve/error', tx: { type: 'htlc_resolve', data: { lockId: 'lock-1', outcome: 'error', reason: 'expired' } } },
  { name: 'htlc_resolve/error-no-reason', tx: { type: 'htlc_resolve', data: { lockId: 'lock-1', outcome: 'error' } } },
  { name: 'add_delta', tx: { type: 'add_delta', data: { tokenId: 2 } } },
  { name: 'set_credit_limit', tx: { type: 'set_credit_limit', data: { tokenId: 1, amount: 1000n } } },
  { name: 'rebalance_policy', tx: { type: 'rebalance_policy', data: { tokenId: 1, policyVersion: 3, baseFee: 11n, liquidityFeeBps: 12n, gasFee: 13n } } },
  { name: 'swap_offer/full', tx: { type: 'swap_offer', data: { offerId: 'offer-1', giveTokenId: 1, giveTokenDecimals: 6, giveAmount: 1_000_000n, wantTokenId: 2, wantTokenDecimals: 6, wantAmount: 2_000_000n, maxFee: 0n, minNetReceive: 1_900_000n, timeInForce: 1, priceTicks: 20_000n } } },
  { name: 'swap_offer/minimal', tx: { type: 'swap_offer', data: { offerId: 'offer-2', giveTokenId: 1, giveTokenDecimals: 6, giveAmount: 1_000_000n, wantTokenId: 2, wantTokenDecimals: 6, wantAmount: 2_000_000n, maxFee: 0n, minNetReceive: 1n } } },
  { name: 'swap_cancel_request', tx: { type: 'swap_cancel_request', data: { offerId: 'offer-1' } } },
  { name: 'swap_resolve/full', tx: { type: 'swap_resolve', data: { offerId: 'offer-1', fillRatio: 10_000, fillNumerator: 1n, fillDenominator: 2n, cancelRemainder: true, comment: 'STP:book', feeTokenId: 2, feeAmount: 7n, executionGiveAmount: 1_000_000n, executionWantAmount: 2_000_000n, restingGiveTokenId: 1, restingWantTokenId: 2, restingPriceTicks: 20_000n, restingGiveAmount: 3n, restingWantAmount: 4n, restingQuantizedGive: 5n, restingQuantizedWant: 6n } } },
  { name: 'swap_resolve/minimal', tx: { type: 'swap_resolve', data: { offerId: 'offer-2', fillRatio: 0, cancelRemainder: false } } },
  // The shape the matcher actually produces for a partial fill that keeps the
  // offer open: `cancelRemainder` present and false, the book's own view of
  // the remainder attached. Rust used to omit the false flag and drop the
  // three carried fields, so its frame hash could not be reproduced here.
  { name: 'swap_resolve/partial-fill', tx: { type: 'swap_resolve', data: { offerId: 'offer-3', fillRatio: 3_333, fillNumerator: 1n, fillDenominator: 3n, cancelRemainder: false, comment: 'book:partial', feeTokenId: 2, feeAmount: 1n, executionGiveAmount: 333_333n, executionWantAmount: 666_666n, restingGiveTokenId: 1, restingWantTokenId: 2, restingPriceTicks: 20_000n, restingGiveAmount: 666_667n, restingWantAmount: 1_333_334n, restingQuantizedGive: 666_667n, restingQuantizedWant: 1_333_334n } } },
];

type Vector = { name: string; bytes: string };

const vectors = (): Vector[] => JSON.parse(readFileSync(VECTORS, 'utf8')) as Vector[];

describe('account transaction wire', () => {
  test('the vectors cover every case, and nothing else', () => {
    expect(vectors().map(row => row.name)).toEqual(TX_WIRE_CASES.map(row => row.name));
  });

  test('TypeScript writes exactly the recorded bytes', () => {
    const recorded = new Map(vectors().map(row => [row.name, row.bytes]));
    for (const { name, tx } of TX_WIRE_CASES) {
      const wire = accountTxWire(tx);
      expect(wire).not.toBeNull();
      expect(`${name}:${packWireValue(wire!).toString('hex')}`)
        .toBe(`${name}:${recorded.get(name)}`);
    }
  });

  test('TypeScript reads back the transaction it wrote', () => {
    const byName = new Map(TX_WIRE_CASES.map(row => [row.name, row.tx]));
    for (const { name, bytes } of vectors()) {
      const decoded = decodeRscoreAccountTx(unpackWireValue(Buffer.from(bytes, 'hex')));
      // Structural equality, not a rendered string: stringifying compared
      // arrays and nested objects by their `String()` form, where two
      // different routes and two different envelopes can read the same.
      expect({ name, tx: decoded }).toEqual({ name, tx: byName.get(name)! });
    }
  });
});

// Regenerate the vectors (run from the repo root):
//
//   bun -e 'import("./core/__tests__/rscore/tx-wire.test.ts").then(async m => {
//     const { packWireValue } = await import("./core/rscore/client");
//     const { accountTxWire } = await import("./core/rscore/shadow-wire");
//     const rows = m.TX_WIRE_CASES.map(c => ({ name: c.name,
//       bytes: packWireValue(accountTxWire(c.tx)).toString("hex") }));
//     await Bun.write("core/__tests__/rscore/tx-wire-vectors.json",
//       JSON.stringify(rows, null, 2) + "\n"); })'
