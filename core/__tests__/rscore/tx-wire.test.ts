import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HTLC_OPAQUE_CIPHERTEXT_VERSION } from '../../protocol/htlc/multi-recipient';
import { safeStringify } from '../../protocol/serialization';
import { packWireValue, unpackWireValue } from '../../rscore/client';
import { accountTxWire } from '../../rscore/shadow-wire';
import { decodeRscoreAccountTx } from '../../rscore/wave-decode';
import { ACCOUNT_TX_TYPES } from '../../account/tx/catalog';
import type { AccountTx } from '../../types/account';

/**
 * The transaction wire is a contract between two languages, and each side
 * being self-consistent is exactly what a silent disagreement also looks
 * like. These vectors are the shared bytes: this file holds TypeScript to
 * them, and crates/process/tests/tx_wire_vectors.rs holds Rust to the same
 * file.
 *
 * Scope: every canonical AccountTx. The catalog assertion below is the gate:
 * adding or removing a TypeScript variant without a shared TS/Rust byte vector
 * fails before either engine may claim parity.
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
const C = `0x${'cc'.repeat(32)}`;
const D = `0x${'dd'.repeat(32)}`;

export const TX_WIRE_CASES: { name: string; tx: AccountTx }[] = [
  { name: 'direct_payment/full', tx: { type: 'direct_payment', data: { tokenId: 1, amount: 25n, route: [B], description: 'memo', fromEntityId: A, toEntityId: B, deliveryMode: 'trusted', trustedGatewayEntityId: B } } },
  { name: 'direct_payment/minimal', tx: { type: 'direct_payment', data: { tokenId: 1, amount: 1n, route: [], fromEntityId: A, toEntityId: B, deliveryMode: 'direct' } } },
  { name: 'lending_fund', tx: { type: 'lending_fund', data: { positionId: 'position-1', hubEntityId: A, lenderEntityId: B, tokenId: 1, amount: 100n, termId: '1d', interestBps: 250 } } },
  { name: 'lending_borrow_request', tx: { type: 'lending_borrow_request', data: { requestId: 'borrow-1', hubEntityId: A, borrowerEntityId: B, tokenId: 1, amount: 50n, termId: '1h', maxInterestBps: 300 } } },
  { name: 'lending_repay', tx: { type: 'lending_repay', data: { loanId: 'loan-1', hubEntityId: A, borrowerEntityId: B, tokenId: 1, amount: 25n } } },
  { name: 'lending_credit', tx: { type: 'lending_credit', data: { action: 'grant', loanId: 'loan-1', hubEntityId: A, borrowerEntityId: B, tokenId: 1, creditLimit: 500n } } },
  { name: 'lending_close_request', tx: { type: 'lending_close_request', data: { positionId: 'position-1', hubEntityId: A, lenderEntityId: B } } },
  { name: 'lending_close_payout', tx: { type: 'lending_close_payout', data: { positionId: 'position-1', hubEntityId: A, lenderEntityId: B, tokenId: 1, amount: 75n } } },
  { name: 'htlc_lock/full', tx: { type: 'htlc_lock', data: { lockId: 'lock-1', hashlock: HASHLOCK, timelock: 1_700_000_000_000n, revealBeforeHeight: 12, amount: 500n, tokenId: 1, deliveryMode: 'async' } } },
  { name: 'htlc_lock/envelope', tx: { type: 'htlc_lock', data: { lockId: 'lock-3', hashlock: HASHLOCK, timelock: 1_700_000_000_000n, revealBeforeHeight: 5, amount: 10n, tokenId: 1, deliveryMode: 'instant', envelope: { version: HTLC_OPAQUE_CIPHERTEXT_VERSION, ciphertext: Buffer.alloc(80, 0x5a).toString('base64') } } } },
  { name: 'htlc_lock/minimal', tx: { type: 'htlc_lock', data: { lockId: 'lock-2', hashlock: HASHLOCK, timelock: 1n, revealBeforeHeight: 0, amount: 1n, tokenId: 1 } } },
  { name: 'htlc_resolve/secret', tx: { type: 'htlc_resolve', data: { lockId: 'lock-1', outcome: 'secret', secret: SECRET } } },
  { name: 'htlc_resolve/error', tx: { type: 'htlc_resolve', data: { lockId: 'lock-1', outcome: 'error', reason: 'expired' } } },
  { name: 'htlc_resolve/error-no-reason', tx: { type: 'htlc_resolve', data: { lockId: 'lock-1', outcome: 'error' } } },
  { name: 'add_delta', tx: { type: 'add_delta', data: { tokenId: 2 } } },
  { name: 'set_credit_limit', tx: { type: 'set_credit_limit', data: { tokenId: 1, amount: 1000n } } },
  { name: 'request_collateral', tx: { type: 'request_collateral', data: { tokenId: 1, amount: 100n, feeTokenId: 2, feeAmount: 3n, policyVersion: 7 } } },
  { name: 'rebalance_refund', tx: { type: 'rebalance_refund', data: { requestId: 'rebalance-1', requestTokenId: 1, amount: 25n, reason: 'policy_mismatch' } } },
  { name: 'rebalance_policy', tx: { type: 'rebalance_policy', data: { tokenId: 1, policyVersion: 3, baseFee: 11n, liquidityFeeBps: 12n, gasFee: 13n } } },
  { name: 'swap_offer/full', tx: { type: 'swap_offer', data: { offerId: 'offer-1', giveTokenId: 1, giveTokenDecimals: 6, giveAmount: 1_000_000n, wantTokenId: 2, wantTokenDecimals: 6, wantAmount: 2_000_000n, maxFee: 0n, minNetReceive: 1_900_000n, timeInForce: 1, priceTicks: 20_000n } } },
  { name: 'swap_offer/cross', tx: { type: 'swap_offer', data: { offerId: 'offer-cross', giveTokenId: 1, giveTokenDecimals: 6, giveAmount: 10n, wantTokenId: 2, wantTokenDecimals: 6, wantAmount: 20n, maxFee: 1n, minNetReceive: 19n, crossJurisdiction: { routeId: 'route-1', amount: 10n } } } as AccountTx },
  { name: 'swap_offer/minimal', tx: { type: 'swap_offer', data: { offerId: 'offer-2', giveTokenId: 1, giveTokenDecimals: 6, giveAmount: 1_000_000n, wantTokenId: 2, wantTokenDecimals: 6, wantAmount: 2_000_000n, maxFee: 0n, minNetReceive: 1n } } },
  { name: 'swap_cancel_request', tx: { type: 'swap_cancel_request', data: { offerId: 'offer-1' } } },
  { name: 'swap_resolve/full', tx: { type: 'swap_resolve', data: { offerId: 'offer-1', fillRatio: 10_000, fillNumerator: 1n, fillDenominator: 2n, cancelRemainder: true, comment: 'STP:book', feeTokenId: 2, feeAmount: 7n, executionGiveAmount: 1_000_000n, executionWantAmount: 2_000_000n, restingGiveTokenId: 1, restingWantTokenId: 2, restingPriceTicks: 20_000n, restingGiveAmount: 3n, restingWantAmount: 4n, restingQuantizedGive: 5n, restingQuantizedWant: 6n } } },
  { name: 'swap_resolve/minimal', tx: { type: 'swap_resolve', data: { offerId: 'offer-2', fillRatio: 0, cancelRemainder: false } } },
  // The shape the matcher actually produces for a partial fill that keeps the
  // offer open: `cancelRemainder` present and false, the book's own view of
  // the remainder attached. Rust used to omit the false flag and drop the
  // three carried fields, so its frame hash could not be reproduced here.
  { name: 'swap_resolve/partial-fill', tx: { type: 'swap_resolve', data: { offerId: 'offer-3', fillRatio: 3_333, fillNumerator: 1n, fillDenominator: 3n, cancelRemainder: false, comment: 'book:partial', feeTokenId: 2, feeAmount: 1n, executionGiveAmount: 333_333n, executionWantAmount: 666_666n, restingGiveTokenId: 1, restingWantTokenId: 2, restingPriceTicks: 20_000n, restingGiveAmount: 666_667n, restingWantAmount: 1_333_334n, restingQuantizedGive: 666_667n, restingQuantizedWant: 1_333_334n } } },
  { name: 'cross_pull_lock', tx: { type: 'cross_pull_lock', data: { pullId: 'pull-1', tokenId: 1, amount: 10n, fullHash: C, partialRoot: D, crossJurisdiction: { routeId: 'route-1' }, crossJurisdictionRoute: { routeId: 'route-1' } } } as AccountTx },
  { name: 'cross_pull_close', tx: { type: 'cross_pull_close', data: { pullId: 'pull-1', binary: '0x01', proof: { routeId: 'route-1', fillRatio: 65535 } } } as AccountTx },
  { name: 'cross_pull_progress', tx: { type: 'cross_pull_progress', data: { pullId: 'pull-1', fill: { routeId: 'route-1', fillSeq: 1, cumulativeFillRatio: 32768, fillNumerator: 1n, fillDenominator: 2n } } } as AccountTx },
  { name: 'cross_swap_fill_ack', tx: { type: 'cross_swap_fill_ack', data: { routeId: 'route-1', fillSeq: 1, cumulativeFillRatio: 32768, fillNumerator: 1n, fillDenominator: 2n } } as AccountTx },
  { name: 'settle_transition', tx: { type: 'settle_transition', data: { kind: 'clear', revision: 1, workspaceHash: C } } },
  { name: 'j_event_claim/minimal', tx: { type: 'j_event_claim', data: { jHeight: 43, jBlockHash: C, events: [{ type: 'AccountSettled', blockNumber: 43, blockHash: C, transactionHash: D, logIndex: 1, data: { leftEntity: A, rightEntity: B, tokenId: 1, leftReserve: '0', rightReserve: '1999999000000', collateral: '1000000', ondelta: '0', nonce: 0 } }] } } },
  { name: 'j_event_claim/proofs', tx: { type: 'j_event_claim', data: { jHeight: 44, jBlockHash: D, events: [{ type: 'AccountSettled', blockNumber: 44, blockHash: D, transactionHash: C, logIndex: 2, eventIndex: 3, data: { leftEntity: A, rightEntity: B, tokenId: 2, leftReserve: '7', rightReserve: '9', collateral: '11', ondelta: '-13', nonce: 5 } }], leftProof: { version: 1, nodes: [{ version: 1, type: 'leaf', key: C, record: { version: 1, accountKey: D, side: 'left', jHeight: 42, jBlockHash: C, eventsHash: D } }] }, rightProof: { version: 1, nodes: [{ version: 1, type: 'branch', bit: 7, left: C, right: D }, { version: 1, type: 'leaf', key: D, record: { version: 1, accountKey: C, side: 'right', jHeight: 41, jBlockHash: D, eventsHash: C } }] } } } },
];

type Vector = { name: string; bytes: string };

const vectors = (): Vector[] => JSON.parse(readFileSync(VECTORS, 'utf8')) as Vector[];

if (Bun.env['RSCORE_GENERATE_TX_WIRE'] === '1') {
  test('generate account transaction wire vectors', async () => {
    const rows = TX_WIRE_CASES.map(({ name, tx }) => ({
      name,
      bytes: packWireValue(accountTxWire(tx)).toString('hex'),
    }));
    await Bun.write(VECTORS, `${safeStringify(rows, 2)}\n`);
  });
} else describe('account transaction wire', () => {
  test('the vectors cover the exhaustive canonical AccountTx catalog', () => {
    const covered = [...new Set(TX_WIRE_CASES.map(row => row.tx.type))].sort();
    expect(covered).toEqual([...ACCOUNT_TX_TYPES].sort());
  });
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
//   RSCORE_GENERATE_TX_WIRE=1 bun test core/__tests__/rscore/tx-wire.test.ts
