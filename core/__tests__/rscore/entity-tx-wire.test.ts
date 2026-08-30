import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hashEntityCommandTxs } from '../../entity/command/command-codec';
import { ENTITY_TX_TYPES } from '../../entity/tx/processing/catalog';
import { validateEntityTx } from '../../entity/tx-validation';
import { decodeBinaryPayload, encodeBinaryPayload } from '../../protocol/serialization/binary-codec';
import { safeStringify } from '../../protocol/serialization';
import type { CrossJurisdictionCloseProof, CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { EntityTx } from '../../types/entity-tx';

/**
 * Actual EntityTx payload bytes shared with Rust. Every row is accepted by the
 * production TypeScript boundary decoder before encoding. Rust feeds the same
 * row through RuntimeEntityInput::decode, so a missing per-kind native decoder
 * is a loud coverage failure rather than a successful generic object parse.
 */
const VECTORS = join(import.meta.dir, 'entity-tx-wire-vectors.json');
const A = `0x${'aa'.repeat(32)}`;
const B = `0x${'bb'.repeat(32)}`;
const H = `0x${'11'.repeat(32)}`;
const H2 = `0x${'22'.repeat(32)}`;
const ADDRESS = `0x${'33'.repeat(20)}`;
const SIGNER = `0x${'44'.repeat(20)}`;
const SIGNATURE = `0x${'55'.repeat(65)}`;

const proof: CrossJurisdictionCloseProof = {
  orderId: 'order-1', routeHash: H, sourcePullId: 'source-pull', targetPullId: 'target-pull',
  fillRatio: 65_535, cumulativeSourceAmount: 5n, cumulativeTargetAmount: 7n,
  binaryHash: H2, closeMode: 'full',
};
const route: CrossJurisdictionSwapRoute = {
  orderId: 'order-1', makerEntityId: A, hubEntityId: B,
  source: { jurisdiction: 'j1', entityId: A, counterpartyEntityId: B, tokenId: 1, amount: 5n },
  target: { jurisdiction: 'j2', entityId: B, counterpartyEntityId: A, tokenId: 2, amount: 7n },
  sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 20 },
  targetDisputeConfig: { leftResponseSeconds: 30, rightResponseSeconds: 40 },
  status: 'intent', createdAt: 100, updatedAt: 101,
};
const accountInput = {
  kind: 'ack' as const, fromEntityId: B, toEntityId: A,
  domain: { chainId: 31_337, depositoryAddress: ADDRESS },
  disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 20 },
  ack: { height: 1, frameHash: H },
};
const nestedCommandTxs: EntityTx[] = [{ type: 'chat', data: { from: 'owner', message: 'hello' } }];

const CASES = [
  { type: 'accountInput', data: accountInput },
  { type: 'admitCrossJurisdictionBookOrder', data: { route, reason: 'admit' } },
  { type: 'applyCrossJurisdictionBookProgress', data: { orderId: 'order-1', sourceEntityId: A, fillSeq: 1, incrementalSourceAmount: 5n, incrementalTargetAmount: 7n, cumulativeSourceAmount: 5n, cumulativeTargetAmount: 7n, cumulativeFillRatio: 65_535, fillNumerator: 1n, fillDenominator: 1n, cancelRemainder: false, reason: 'fill' } },
  { type: 'boardHandover', data: { board: { mode: 'proposer-based', threshold: 1n, validators: ['owner'], shares: { owner: 1n } } } },
  { type: 'chat', data: { from: 'owner', message: 'hello' } },
  { type: 'chatMessage', data: { message: 'hello', timestamp: 100, metadata: { type: 'test', counterpartyId: B } } },
  { type: 'crossJurisdictionBookOrderRemoved', data: { orderId: 'order-1', sourceEntityId: A, sourceAccountId: B, route, removedAt: 100, reason: 'done' } },
  { type: 'crossJurisdictionFillNotice', data: { orderId: 'order-1', routeHash: H, previousFillSeq: 0, fillSeq: 1, incrementalSourceAmount: 5n, incrementalTargetAmount: 7n, cumulativeSourceAmount: 5n, cumulativeTargetAmount: 7n, cumulativeFillRatio: 65_535, fillNumerator: 1n, fillDenominator: 1n, cancelRemainder: false, pairId: '1/2' } },
  { type: 'crossJurisdictionForceSiblingDispute', data: { routeId: 'route-1', observedCounterpartyEntityId: B, observedAt: 100 } },
  { type: 'crossJurisdictionSalvage', data: { routeId: 'route-1', binary: '0x01', fillRatio: 1, sourceEntityId: A, sourceCounterpartyEntityId: B, observedAt: 100 } },
  { type: 'crossPullClose', data: { counterpartyEntityId: B, pullId: 'pull-1', binary: '0x01', proof, route, description: 'close' } },
  { type: 'directPayment', data: { targetEntityId: B, tokenId: 1, amount: 5n, route: [A, B], description: 'pay', deliveryMode: 'direct' } },
  { type: 'disputeFinalize', data: { counterpartyEntityId: B, useOnchainRegistry: true, description: 'finalize' } },
  { type: 'disputeStart', data: { counterpartyEntityId: B, crossJurisdictionRouteId: 'route-1', starterInitialArguments: '0x', starterCounterArguments: '0x', description: 'start' } },
  { type: 'e2r', data: { contractAddress: ADDRESS, tokenType: 20, externalTokenId: 1n, internalTokenId: 1, amount: 5n } },
  { type: 'entityCommand', data: { version: 1, entityId: A, stackKey: H, boardHash: H2, boardEpoch: 0, authorSignerId: 'owner', authorSigner: SIGNER, nonce: 1n, txsHash: hashEntityCommandTxs(nestedCommandTxs), txs: nestedCommandTxs, signature: SIGNATURE } },
  { type: 'entityProviderActivateBoard', data: { targetEntityId: A } },
  { type: 'entityProviderCancelAction', data: { actionHash: H } },
  { type: 'entityProviderProposeControlBoard', data: { targetEntityId: A, newBoardHash: H, actionNonce: 1n, supporterVotes: [{ entityId: B, hankoSignature: SIGNATURE }] } },
  { type: 'entityProviderReleaseControlShares', data: { recipientAddress: SIGNER, controlAmount: 1n, dividendAmount: 2n, purpose: 'release' } },
  { type: 'entityProviderTransfer', data: { to: SIGNER, tokenId: 1n, amount: 2n } },
  { type: 'extendCredit', data: { counterpartyEntityId: B, tokenId: 1, amount: 5n } },
  { type: 'htlcPayment', data: { targetEntityId: B, tokenId: 1, amount: 5n, maxSenderDebit: 6n, route: [A, B], description: 'htlc', deliveryMode: 'instant', startedAtMs: 100, hashlock: H } },
  { type: 'initOrderbookExt', data: { name: 'book', spreadDistribution: { makerBps: 1, takerBps: 2, hubBps: 3, makerReferrerBps: 4, takerReferrerBps: 5 }, referenceTokenId: 1, usdQuoteAuthorityEntityId: A, minTradeSize: 1n, supportedPairs: ['1/2'] } },
  { type: 'j_abort_sent_batch', data: { reason: 'abort', requeueToCurrent: true } },
  { type: 'j_broadcast', data: { hankoSignature: SIGNATURE, feeOverrides: { gasBumpBps: 100, maxFeePerGasWei: '2', maxPriorityFeePerGasWei: '1' } } },
  { type: 'j_clear_batch', data: { reason: 'clear' } },
  { type: 'j_event', data: { from: SIGNER, jurisdictionRef: 'j1', baseHeight: 0, scannedThroughHeight: 0, tipBlockHash: H, eventHistoryRoot: H, rangeHash: H2, blocks: [], signature: SIGNATURE, observedAt: 100 } },
  { type: 'j_rebroadcast', data: { gasBumpBps: 100 } },
  { type: 'lendingBorrow', data: { requestId: 'request-1', hubEntityId: B, tokenId: 1, amount: 5n, termId: '1h', maxInterestBps: 100 } },
  { type: 'lendingClosePosition', data: { hubEntityId: B, positionId: 'position-1' } },
  { type: 'lendingOffer', data: { positionId: 'position-1', hubEntityId: B, tokenId: 1, amount: 5n, termId: '1d', interestBps: 100 } },
  { type: 'lendingRepay', data: { hubEntityId: B, loanId: 'loan-1', tokenId: 1, amount: 5n } },
  { type: 'mintReserves', data: { tokenId: 1, amount: 5n } },
  { type: 'openAccount', data: { targetEntityId: B, disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 20 }, accountDomain: { chainId: 31_337, depositoryAddress: ADDRESS }, watchSeed: H, creditAmount: 5n, tokenId: 1, rebalancePolicy: { r2cRequestSoftLimit: 1n, hardLimit: 2n, maxAcceptableFee: 0n } } },
  { type: 'orderbookSweepCrossJurisdiction', data: { reason: 'sweep' } },
  { type: 'placeSwapOffer', data: { counterpartyEntityId: B, offerId: 'offer-1', giveTokenId: 1, giveTokenDecimals: 6, giveAmount: 5n, wantTokenId: 2, wantTokenDecimals: 6, wantAmount: 7n, maxFee: 1n, minNetReceive: 6n, priceTicks: 10n, timeInForce: 0 } },
  { type: 'prepareCrossJurisdictionSwap', data: { route } },
  { type: 'prepareDispute', data: { counterpartyEntityId: B, description: 'prepare', minCooldownMs: 1, crossJurisdictionRouteId: 'route-1', starterInitialArguments: '0x' } },
  { type: 'processHtlcTimeouts', data: { expiredLocks: [{ accountId: B, lockId: 'lock-1' }] } },
  { type: 'profile-update', data: { profile: { entityId: A, name: 'alice', entityKind: 'person', sectors: ['finance'], avatar: '', bio: '', website: '' } } },
  { type: 'propose', data: { action: { type: 'collective_message', data: { message: 'proposal' } }, proposer: 'owner' } },
  { type: 'proposeCancelSwap', data: { counterpartyEntityId: B, offerId: 'offer-1' } },
  { type: 'r2c', data: { counterpartyId: B, receivingEntityId: A, tokenId: 1, amount: 5n, rebalanceQuoteId: 1, rebalanceFeeTokenId: 1, rebalanceFeeAmount: 1n } },
  { type: 'r2e', data: { receivingEntity: A, tokenId: 1, amount: 5n } },
  { type: 'r2r', data: { toEntityId: B, tokenId: 1, amount: 5n } },
  { type: 'registerCrossJurisdictionSwap', data: { route } },
  { type: 'removeCrossJurisdictionBookOrder', data: { orderId: 'order-1', sourceEntityId: A, sourceAccountId: B, route, reason: 'remove' } },
  { type: 'requestCollateral', data: { counterpartyEntityId: B, tokenId: 1, amount: 5n, feeTokenId: 1, feeAmount: 1n, policyVersion: 1 } },
  { type: 'requestCrossJurisdictionClear', data: { orderId: 'order-1', cancelRemainder: false, route } },
  { type: 'materializeCrossJurisdictionClear', data: { proposerSignerId: 'owner', orderId: 'order-1', binary: '0x01', proof } },
  { type: 'materializeCrossJurisdictionSwap', data: { proposerSignerId: 'owner', route } },
  { type: 'resolveHtlcLock', data: { counterpartyEntityId: B, lockId: 'lock-1', secret: H, crossJurisdictionRouteId: 'route-1', description: 'resolve' } },
  { type: 'runtimeOutput', data: { protocol: 'cross-j', sourceEntityId: A, sourceSignerId: 'owner', targetEntityId: B, entityTxs: [{ type: 'crossJurisdictionSalvage', data: { routeId: 'route-1', binary: '0x01', fillRatio: 1, sourceEntityId: A, sourceCounterpartyEntityId: B } }] } },
  { type: 'scheduledWake', data: { version: 1, proposerSignerId: 'owner', dueAt: 100, jobs: [{ kind: 'hook', id: 'hook-1', dueAt: 100 }] } },
  { type: 'setHubConfig', data: { hubName: 'hub', matchingStrategy: 'amount', policyVersion: 1, routingFeePPM: 1, baseFee: 0n, swapTakerFeeBps: 1, disputeAutoFinalizeMode: 'auto', minCollateralThreshold: 1n, c2rWithdrawSoftLimit: 2n, rebalanceBaseFee: 1n, rebalanceLiquidityFeeBps: 2n, rebalanceGasFee: 3n, rebalanceTimeoutMs: 100 } },
  { type: 'setRebalancePolicy', data: { counterpartyEntityId: B, tokenId: 1, r2cRequestSoftLimit: 1n, hardLimit: 2n, maxAcceptableFee: 1n } },
  { type: 'settle_approve', data: { counterpartyEntityId: B, workspaceHash: H } },
  { type: 'settle_execute', data: { counterpartyEntityId: B, disableC2RShortcut: true } },
  { type: 'settle_propose', data: { counterpartyEntityId: B, ops: [{ type: 'r2c', tokenId: 1, amount: 5n }], executorIsLeft: true, memo: 'settle', continuation: { actions: [{ type: 'r2r', toEntityId: B, tokenId: 1, amount: 1n }], broadcast: true } } },
  { type: 'settle_reject', data: { counterpartyEntityId: B, reason: 'reject' } },
  { type: 'settle_update', data: { counterpartyEntityId: B, ops: [{ type: 'forgive', tokenId: 1 }], executorIsLeft: false, memo: 'update' } },
  { type: 'vote', data: { proposalId: 'proposal-1', voter: 'owner', choice: 'yes', comment: 'yes' } },
] as const satisfies readonly EntityTx[];

type Vector = Readonly<{ name: string; bytes: string }>;
const vectors = (): Vector[] => JSON.parse(readFileSync(VECTORS, 'utf8')) as Vector[];
const validatedCases = (): readonly EntityTx[] => CASES.map((tx, index) =>
  validateEntityTx(tx, `ENTITY_TX_WIRE_${index}`));

if (Bun.env['RSCORE_GENERATE_ENTITY_TX_WIRE'] === '1') {
  test('generate exhaustive EntityTx wire vectors', async () => {
    const rows = validatedCases().map(tx => ({
      name: tx.type, bytes: Buffer.from(encodeBinaryPayload(tx)).toString('hex'),
    }));
    await Bun.write(VECTORS, `${safeStringify(rows, 2)}\n`);
  });
} else describe('EntityTx wire', () => {
  test('production TypeScript admission covers exactly the canonical 63-kind catalog', () => {
    expect(validatedCases().map(tx => tx.type)).toEqual([...ENTITY_TX_TYPES]);
    expect(vectors().map(row => row.name)).toEqual([...ENTITY_TX_TYPES]);
    expect(new Set(ENTITY_TX_TYPES).size).toBe(63);
  });
  test('TypeScript writes the reviewed shared bytes', () => {
    const recorded = new Map(vectors().map(row => [row.name, row.bytes]));
    for (const tx of validatedCases()) {
      expect(Buffer.from(encodeBinaryPayload(tx)).toString('hex')).toBe(recorded.get(tx.type));
    }
  });
  test('TypeScript reads the complete admitted transaction it wrote', () => {
    const expected = new Map(validatedCases().map(tx => [tx.type, tx]));
    for (const { name, bytes } of vectors()) {
      expect(decodeBinaryPayload(Buffer.from(bytes, 'hex'))).toEqual(expected.get(name));
    }
  });
});
