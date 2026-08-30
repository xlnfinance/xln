import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  resetHltPaymentOperationLedger,
  snapshotHltPaymentOperationLedger,
  traceAccountApplyHop,
  traceHltSwapProposalOutcomes,
} from '../../../support/performance/account-delivery-trace';
import type { AccountPeerInput, AccountTx } from '../../../types/account';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const LOCK_ID = `0x${'33'.repeat(32)}`;
const HASHLOCK = `0x${'44'.repeat(32)}`;

const input = (height: number, tx: AccountTx): Extract<AccountPeerInput, { kind: 'frame' }> => ({
  kind: 'frame',
  fromEntityId: LEFT,
  toEntityId: RIGHT,
  domain: { chainId: 31_337, depositoryAddress: `0x${'55'.repeat(20)}` },
  disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  proposal: {
    frame: {
      height,
      timestamp: 1_700_000_000_000 + height,
      jHeight: 100,
      accountTxs: [tx],
      prevFrameHash: `0x${'66'.repeat(32)}`,
      accountStateRoot: `0x${'77'.repeat(32)}`,
      stateHash: `0x${height.toString(16).padStart(64, '0')}`,
    },
  },
});

beforeEach(() => {
  process.env['XLN_HLT_OPERATION_LEDGER'] = '1';
  resetHltPaymentOperationLedger();
});

afterEach(() => {
  resetHltPaymentOperationLedger();
  delete process.env['XLN_HLT_OPERATION_LEDGER'];
});

test('RAM-only payment ledger distinguishes unique legs from exact replay', () => {
  const lock = input(1, {
    type: 'htlc_lock',
    data: {
      lockId: LOCK_ID,
      hashlock: HASHLOCK,
      timelock: 1_700_000_100_000n,
      revealBeforeHeight: 200,
      amount: 1_000n,
      tokenId: 1,
    },
  });
  const resolve = input(2, {
    type: 'htlc_resolve',
    data: { lockId: LOCK_ID, outcome: 'error', reason: 'test' },
  });
  const ack = (proposal: Extract<AccountPeerInput, { kind: 'frame' }>): AccountPeerInput => ({
    kind: 'ack',
    fromEntityId: RIGHT,
    toEntityId: LEFT,
    domain: proposal.domain,
    disputeConfig: proposal.disputeConfig,
    ack: {
      height: proposal.proposal.frame.height,
      frameHash: proposal.proposal.frame.stateHash,
    },
  });
  traceAccountApplyHop('account-apply-done', lock, { outcome: 'proposal' });
  traceAccountApplyHop('account-apply-done', resolve, { outcome: 'proposal' });
  traceAccountApplyHop('account-apply-done', ack(lock), { outcome: 'applied' });
  traceAccountApplyHop('account-apply-done', ack(lock), { outcome: 'duplicate' });
  traceAccountApplyHop('account-apply-done', ack(resolve), { outcome: 'applied' });

  const stage = snapshotHltPaymentOperationLedger().stages['account-apply-done'];
  expect(stage).toMatchObject({
    frameAppearances: 5,
    uniqueFrames: 2,
    repeatedFrames: 3,
    operationAppearances: 3,
    uniqueOperationEvents: 2,
    repeatedOperationEvents: 1,
    lockIds: [LOCK_ID],
    lockLegs: [`${LEFT}|${RIGHT}|${LOCK_ID}`],
    resolveIds: [LOCK_ID],
    resolveLegs: [`${LEFT}|${RIGHT}|${LOCK_ID}`],
    hashlocks: [HASHLOCK],
    outcomes: { applied: 2, duplicate: 1, proposal: 2 },
  });
  expect(stage?.firstAtUnixMs).toBeGreaterThan(0);
  expect(stage?.lastAtUnixMs).toBeGreaterThanOrEqual(stage?.firstAtUnixMs ?? 0);
});

test('RAM-only swap proposal ledger partitions accepted, rejected, and deferred offers', () => {
  const offers = ['accepted', 'rejected', 'deferred'].map(offerId => ({
    type: 'swap_offer' as const,
    data: {
      offerId,
      giveTokenId: 1,
      giveTokenDecimals: 6,
      giveAmount: 1_000_000n,
      wantTokenId: 2,
      wantTokenDecimals: 6,
      wantAmount: 1_000_000n,
      maxFee: 0n,
      minNetReceive: 1_000_000n,
    },
  }));
  traceHltSwapProposalOutcomes(offers, [{
    index: 1,
    code: 'PRICE_BAND',
    disposition: 'removed',
  }, {
    index: 2,
    code: 'CAPACITY',
    disposition: 'deferred',
  }]);
  expect(snapshotHltPaymentOperationLedger().swapProposals).toEqual({
    acceptedOfferIds: ['accepted'],
    rejectedOfferIds: ['rejected'],
    deferredOfferIds: ['deferred'],
    rejectionCodes: { PRICE_BAND: 1 },
    repeatedObservations: 0,
  });
});
