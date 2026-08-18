import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  PRODUCTION_SWAP_LOAD_LATENCY_BUCKETS_MS,
  decodeProductionSwapLoadConfig,
  decodeProductionSwapLoadObservation,
  defaultProductionSwapLoadConfig,
} from '../../../scripts/operations/hlt/schema';
import {
  assertExactCrashRecovery,
  summarizeProductionSwapLoadStep,
} from '../../../scripts/operations/hlt/metrics';
import { decodeProductionSwapLoadTopology } from '../../../scripts/operations/hlt/topology';
import {
  decodeAccountPage,
  decodeLoadSustainedReport,
  decodeHubMinTradeSize,
  selectLocalHubIdentity,
} from '../../../scripts/operations/hlt/boundary/worker-boundary';
import {
  decodeLoadBookPage,
  deriveExecutableBidForAsk,
  deriveMinimumLotAlignedBaseAmount,
} from '../../../scripts/operations/hlt/boundary/worker-book-boundary';
import {
  assertProductionSwapFullySettled,
  decodeProductionSwapSettlementEvidence,
} from '../../../scripts/operations/hlt/settlement';
import { sameBilateralAccountHead } from '../../../scripts/operations/hlt/settlement-reader';
import {
  applyCommand,
  computeSwapPriceTicksForDimensions,
  createBook,
  getStaticSwapTokenDimensions,
  getSwapLotScale,
  getSwapExactQuoteLotMultipleAtPriceForDimensions,
  quoteAmountFromWeightedLotsForDecimals,
  quoteAmountAtPrice,
} from '../../../orderbook';
import { projectBookPricePageTree } from '../../../orderbook/pages/page';
import {
  assertSwapNetAuthorization,
  deriveSwapNetAuthorization,
} from '../../../account/swap/swap-net-authorization';
import { prepareSwapOfferAmounts } from '../../../account/tx/handlers/swap/offer/quantization';
import { parseWorkerArgs } from '../../../scripts/operations/hlt/worker-runtime';
import {
  connectedRuntimeHttpBase,
  deriveLoadLaneIdentities,
  CONTROL_CONCURRENCY,
  partitionLoadControlBatches,
  partitionLoadProvisioningBatches,
  runtimeHttpBaseFromWsUrl,
} from '../../../scripts/operations/hlt/lanes/worker-lanes';
import { parseSameLoadSchedule } from '../../../scripts/operations/hlt/workload/load-schedule';
import {
  buildIndependentMakerTakerPlan,
  buildParallelLaneOfferPlan,
} from '../../../scripts/operations/hlt/workload/worker-same-plan';
import { buildLaneRoundOfferInputs } from '../../../scripts/operations/hlt/workload/worker-same-lanes';
import {
  deriveSameOrderbookPriceBandBounds,
  evaluateSameOrderbookPriceBand,
} from '../../../entity/tx/handlers/account/orderbook/helpers';
import { getSwapPairPolicyByBaseQuote } from '../../../account/utils';
import { admitOrderbookAccountTxBatch } from '../../../entity/consensus/account/orderbook-account-admission';
import { makeAccount as makeCanonicalAccount } from '../../helpers/cross-j';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { createEmptyEnv } from '../../../runtime';
import type { AccountTx } from '../../../types/account';

const root = (byte: string): string => `0x${byte.repeat(64)}`;
const histogram = (...counts: Array<readonly [number, number]>): number[] => {
  const values = Array.from({ length: PRODUCTION_SWAP_LOAD_LATENCY_BUCKETS_MS.length }, () => 0);
  for (const [bucketMs, count] of counts) {
    const index = PRODUCTION_SWAP_LOAD_LATENCY_BUCKETS_MS.findIndex(value => value === bucketMs);
    if (index < 0) throw new Error(`TEST_LATENCY_BUCKET_UNKNOWN:${bucketMs}`);
    values[index] = count;
  }
  return values;
};

const observation = (overrides: Record<string, unknown> = {}) => decodeProductionSwapLoadObservation({
  completionAuthority: 'committed_orderbook_trade_count',
  atMs: 1_000,
  offeredTotal: 0,
  completedTotal: 0,
  rejectedTotal: 0,
  duplicateTotal: 0,
  lostTotal: 0,
  queueDepth: 0,
  rssBytes: 100,
  heapUsedBytes: 50,
  cpuUserMicros: 1_000,
  cpuSystemMicros: 500,
  diskBytes: 1_000,
  runtimeHeight: 10,
  canonicalStateHash: root('a'),
  latencyHistogram: histogram([1, 1], [2, 1], [4, 1]),
  stagesMs: { wal: 2 },
  ...overrides,
});

describe('production swap load evidence', () => {
  test('configuration has no protocol Account-count ceiling', () => {
    expect(decodeProductionSwapLoadConfig({
      ...defaultProductionSwapLoadConfig(),
      accountsPerHub: 100_000_000,
    }).accountsPerHub).toBe(100_000_000);
  });
  test('matcher settlements enter one Account lane atomically', async () => {
    const account = makeCanonicalAccount(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`);
    const txs: AccountTx[] = Array.from({ length: 5 }, (_, index) => ({
      type: 'swap_resolve',
      data: { offerId: `offer-${index}`, fillRatio: 65_535, cancelRemainder: true },
    }));
    await admitOrderbookAccountTxBatch(
      createAccountConsensusContext(createEmptyEnv('orderbook-account-batch')),
      account,
      account.state.leftEntity,
      txs,
    );
    expect(account.mempool).toEqual(txs);
    await expect(admitOrderbookAccountTxBatch(
      createAccountConsensusContext(createEmptyEnv('orderbook-account-batch-duplicate')),
      account,
      account.state.leftEntity,
      txs,
    )).rejects.toThrow('ORDERBOOK_ACCOUNT_TX_ADMISSION_FAILED');
    expect(account.mempool).toEqual(txs);
  });

  test('compact Account view decodes consumed state without minting a full replica', () => {
    const leftEntity = `0x${'11'.repeat(32)}`;
    const rightEntity = `0x${'22'.repeat(32)}`;
    const delta = {
      tokenId: 1, collateral: 0n, ondelta: 0n, offdelta: 0n,
      leftCreditLimit: 10n, rightCreditLimit: 20n,
      leftAllowance: 0n, rightAllowance: 0n, leftHold: 0n, rightHold: 0n,
    };
    const pendingFrame = {
      height: 1, timestamp: 1, jHeight: 0, accountTxs: [], prevFrameHash: 'genesis',
      accountStateRoot: root('a'), stateHash: root('b'), byLeft: true, deltas: [],
    };
    const item = {
      state: {
        leftEntity, rightEntity, domain: {}, watchSeed: '', deltas: new Map([[1, delta]]),
        locks: new Map(), swapOffers: new Map(), leftPendingJClaims: {}, rightPendingJClaims: {},
        lastFinalizedJHeight: 0, disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 20 },
        jNonce: 0, requestedRebalance: new Map(), requestedRebalanceFeeState: new Map(),
      },
      status: 'active', mempool: [], currentFrame: {}, currentHeight: 0,
      pendingSignatures: [], rollbackCount: 0, proofHeader: {}, proofBody: {},
      pendingWithdrawals: new Map(), shadow: {},
      pendingFrame,
    };
    const page = {
      items: [item], nextCursor: null, prevCursor: null, firstCursor: rightEntity,
      lastCursor: rightEntity, pageIndex: 0, pageCount: 1, totalItems: 1, limit: 1,
    };
    const decoded = decodeAccountPage(page);
    expect(decoded?.state.deltas.get(1)?.rightCreditLimit).toBe(20n);
    expect(decoded?.state.disputeConfig).toEqual({ leftResponseSeconds: 10, rightResponseSeconds: 20 });
    expect(() => decodeAccountPage({
      ...page,
      items: [{ ...item, pendingFrame: { ...pendingFrame, extra: true } }],
    })).toThrow('production-swap-load account.pendingFrame.fields');
  });

  test('same-j sustained load enforces one order per Account per round', () => {
    const args = parseWorkerArgs([
      '--work-dir', '/tmp/load', '--port-base', '20000', '--mode', 'same',
      '--swaps', '100', '--lanes', '100', '--rounds', '10', '--cadence-ms', '1000',
    ]);
    expect(args.lanes).toBe(100);
    expect(args.swaps).toBe(100);
    expect(args.rounds).toBe(10);
    expect(args.cadenceMs).toBe(1_000);
    expect(args.laneOffset).toBe(0);
    expect(() => parseWorkerArgs([
      '--work-dir', '/tmp/load', '--port-base', '20000', '--mode', 'same',
      '--swaps', '100', '--lanes', '99',
    ])).toThrow('PRODUCTION_SWAP_LOAD_SUSTAINED_REQUIRES_ONE_SWAP_PER_LANE');
    expect(() => parseWorkerArgs([
      '--work-dir', '/tmp/load', '--port-base', '20000', '--mode', 'same',
      '--swaps', '31', '--lanes', '32',
    ])).toThrow('PRODUCTION_SWAP_LOAD_LANES_WITHOUT_ORDERS');
    expect(parseWorkerArgs([
      '--work-dir', '/tmp/load', '--port-base', '20000', '--mode', 'same',
      '--swaps', '481', '--lanes', '481',
    ]).lanes).toBe(481);
  });

  test('one-stack same-j ladder allocates disjoint Account lanes and stops on invalid stages', () => {
    expect(parseSameLoadSchedule('32:32,160:160,640:640,1000:1000')).toEqual([
      { swaps: 32, lanes: 32, laneOffset: 0 },
      { swaps: 160, lanes: 160, laneOffset: 32 },
      { swaps: 640, lanes: 640, laneOffset: 192 },
      { swaps: 1000, lanes: 1000, laneOffset: 832 },
    ]);
    expect(() => parseSameLoadSchedule('32:32,31:31'))
      .toThrow('PRODUCTION_SWAP_LOAD_SCHEDULE_NOT_ASCENDING');
    expect(() => parseSameLoadSchedule('161:32'))
      .toThrow('PRODUCTION_SWAP_LOAD_SCHEDULE_ACCOUNT_FRAME_CAP_INVALID');
  });

  test('load lanes derive unique identities and an exact authenticated control origin', () => {
    const identities = deriveLoadLaneIdentities('test-only-load-root', 3);
    const makers = deriveLoadLaneIdentities('test-only-load-root', 3, 'maker');
    const next = deriveLoadLaneIdentities('test-only-load-root', 3, 'taker', 3);
    expect(new Set(identities.map(identity => identity.entityId)).size).toBe(3);
    expect(new Set(identities.map(identity => identity.signerId)).size).toBe(3);
    expect(new Set([...identities, ...makers].map(identity => identity.entityId)).size).toBe(6);
    expect(new Set([...identities, ...next].map(identity => identity.entityId)).size).toBe(6);
    expect(runtimeHttpBaseFromWsUrl('ws://127.0.0.1:20008/rpc')).toBe('http://127.0.0.1:20008');
    expect(connectedRuntimeHttpBase({ wsUrl: 'ws://127.0.0.1:20008/rpc' }))
      .toBe('http://127.0.0.1:20008');
    expect(() => runtimeHttpBaseFromWsUrl('http://127.0.0.1:20008/rpc'))
      .toThrow('PRODUCTION_SWAP_LOAD_CONTROL_URL_INVALID');
  });

  test('user provisioning stays below the authenticated Runtime API burst', () => {
    const control = partitionLoadControlBatches(
      Array.from({ length: CONTROL_CONCURRENCY * 2 + 1 }, (_, index) => index),
    );
    expect(control.map(batch => batch.length))
      .toEqual([CONTROL_CONCURRENCY, CONTROL_CONCURRENCY, 1]);
    expect(control.flat()).toEqual(Array.from({ length: CONTROL_CONCURRENCY * 2 + 1 }, (_, index) => index));
    const provisioning = partitionLoadProvisioningBatches(
      Array.from({ length: 101 }, (_, index) => index),
    );
    expect(provisioning.map(batch => batch.length)).toEqual([16, 16, 16, 16, 16, 16, 5]);
    expect(provisioning.every(batch => batch.length <= 16)).toBe(true);
  });

  test('parallel lane plan emits exact marketable offers without exceeding five per Account frame', () => {
    const midpoint = 25_000_000n;
    const { maxAllowed } = deriveSameOrderbookPriceBandBounds(midpoint);
    const plans = buildParallelLaneOfferPlan(`0x${'11'.repeat(32)}`, 'test-load', 30, 3, 10_000_000n, maxAllowed);
    expect(plans.map(plan => plan.offers.length)).toEqual([10, 10, 10]);
    for (const plan of plans) {
      expect(plan.quoteCredit).toBeGreaterThan(0n);
      expect(plan.baseCredit).toBeGreaterThan(0n);
      for (const tx of plan.offers) {
        if (tx.type !== 'placeSwapOffer') throw new Error('TEST_LOAD_OFFER_TYPE_INVALID');
        expect(prepareSwapOfferAmounts({ type: 'swap_offer', data: tx.data }).ok).toBe(true);
        expect(evaluateSameOrderbookPriceBand({
          priceTicks: maxAllowed,
          side: 0,
          bestBid: 24_995_000n,
          bestAsk: 25_005_000n,
          pairPolicy: getSwapPairPolicyByBaseQuote(2, 1),
          hasExplicitPairPolicy: true,
        }).rejectReason).toBeUndefined();
      }
    }
  });

  test('independent maker and taker lanes authorize opposite sides at one exact price', () => {
    const priceTicks = 25_000_000n;
    const plan = buildIndependentMakerTakerPlan(
      `0x${'11'.repeat(32)}`,
      'test-load',
      9,
      3,
      10_000_000n,
      priceTicks,
    );
    expect(plan.makerPlans.map(item => item.offers.length)).toEqual([3, 3, 3]);
    expect(plan.takerPlans.map(item => item.offers.length)).toEqual([3, 3, 3]);
    for (const maker of plan.makerPlans.flatMap(item => item.offers)) {
      if (maker.type !== 'placeSwapOffer') throw new Error('TEST_LOAD_MAKER_TYPE_INVALID');
      expect(maker.data.giveTokenId).toBe(2);
      expect(maker.data.wantTokenId).toBe(1);
      expect(prepareSwapOfferAmounts({ type: 'swap_offer', data: maker.data }).ok).toBe(true);
    }
    for (const taker of plan.takerPlans.flatMap(item => item.offers)) {
      if (taker.type !== 'placeSwapOffer') throw new Error('TEST_LOAD_TAKER_TYPE_INVALID');
      expect(taker.data.giveTokenId).toBe(1);
      expect(taker.data.wantTokenId).toBe(2);
      expect(prepareSwapOfferAmounts({ type: 'swap_offer', data: taker.data }).ok).toBe(true);
    }
  });

  test('each sustained round emits exactly one order per user Account', () => {
    const plans = buildIndependentMakerTakerPlan(
      `0x${'11'.repeat(32)}`,
      'round-test',
      30,
      3,
      10_000_000n,
      25_000_000n,
    );
    const identities = Array.from({ length: 3 }, (_, index) => ({
      entityId: `0x${(index + 1).toString(16).padStart(64, '0')}`,
      signerId: `0x${(index + 1).toString(16).padStart(40, '0')}`,
    }));
    const round = buildLaneRoundOfferInputs(identities, plans.takerPlans, 4);
    expect(round).toHaveLength(3);
    expect(round.every(input => input.entityTxs.length === 1)).toBe(true);
    expect(new Set(round.map(input => input.entityTxs[0]!.data.offerId)).size).toBe(3);
  });

  test('hub identity selector excludes cohosted secondary and remote gossip hubs', () => {
    const localRuntimeId = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const entity = (entityId: string, runtimeId: string, chainId: number, signerId?: string) => ({
      entityId,
      runtimeId,
      ...(signerId ? { signerId } : {}),
      label: `hub-${chainId}`,
      height: 9,
      isHub: true,
      jurisdiction: { chainId },
    });
    const selected = selectLocalHubIdentity([
      entity('0x' + '11'.repeat(32), localRuntimeId, 31_337, '0x' + 'a1'.repeat(20)),
      entity('0x' + '22'.repeat(32), localRuntimeId, 31_338, '0x' + 'a2'.repeat(20)),
      entity('0x' + '33'.repeat(32), '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 31_337),
      entity('0x' + '44'.repeat(32), '0xcccccccccccccccccccccccccccccccccccccccc', 31_337, '0x' + 'a4'.repeat(20)),
    ], localRuntimeId, 31_337);
    expect(selected.entityId).toBe('0x' + '11'.repeat(32));
    expect(selected.signerId).toBe('0x' + 'a1'.repeat(20));
  });

  test('sustained report separates offered order rate from fully bilateral economic settlement', () => {
    const root = `0x${'ab'.repeat(32)}`;
    const settlementEvidence = {
      expectedSwaps: 10,
      tradeCountBefore: 5,
      tradeCountAfter: 15,
      matchedElapsedMs: 250,
      fullySettledElapsedMs: 500,
      createdOfferIds: Array.from({ length: 10 }, (_, index) => `offer-${index}`),
      accounts: [{
        accountKey: 'load/hub',
        createdOfferIds: Array.from({ length: 10 }, (_, index) => `offer-${index}`),
        committedOfferIds: Array.from({ length: 10 }, (_, index) => `offer-${index}`),
        committedResolveIds: Array.from({ length: 10 }, (_, index) => `offer-${index}`),
        liveOfferIds: [], pendingFrame: false, pendingProposal: false, mempoolTxs: 0,
      }],
      runtimes: [
        { role: 'hub', processing: 0, pendingOutputs: 0, pendingNetworkOutputs: 0, networkInbox: 0, runtimeEntityInputs: 0, runtimeTxs: 0, runtimeJInputs: 0, retryEntries: 0 },
        { role: 'load', processing: 0, pendingOutputs: 0, pendingNetworkOutputs: 0, networkInbox: 0, runtimeEntityInputs: 0, runtimeTxs: 0, runtimeJInputs: 0, retryEntries: 0 },
        { role: 'market-maker', processing: 0, pendingOutputs: 0, pendingNetworkOutputs: 0, networkInbox: 0, runtimeEntityInputs: 0, runtimeTxs: 0, runtimeJInputs: 0, retryEntries: 0 },
      ],
      bestBidPriceTicks: 24_999_000n,
      bestAskPriceTicks: 25_001_000n,
    };
    const report = decodeLoadSustainedReport({
      schema: 'xln-production-swap-load-sustained-v1', mode: 'same',
      schedule: 'one_order_per_account_per_round', configuredUsers: 4,
      configuredRounds: 5, cadenceMs: 1_000,
      offeredOrderRate: 4, offeredEconomicSwapRate: 2,
      loadMakerAccountCount: 2, loadTakerAccountCount: 2,
      loadParticipantAccountCount: 4, maxOrdersPerAccountFrame: 1,
      runtimeInputBatches: 5, roundSubmissionLagMs: [0, 1, 0, 2, 0],
      matchedEconomicSwaps: 10, fullySettledEconomicSwaps: 10,
      completionAuthority: 'committed_trade_count_and_bilateral_runtime_quiescence',
      enqueueAckElapsedMs: 10, commandObservedElapsedMs: 20,
      matchedElapsedMs: 250, fullySettledElapsedMs: 500,
      matchedTps: 40, fullySettledTps: 20,
      tradeCountBefore: 5, tradeCountAfter: 15,
      submittedEconomicSwaps: 10, uncompletedEconomicSwapsAfterRun: 0,
      driverRssBefore: 100, driverRssAfter: 110,
      walBytesBefore: 1_000, walBytesAfter: 2_000,
      crossedBookAfterRun: false,
      durableBefore: { height: 20, canonicalStateHash: root },
      durableAfter: { height: 21, canonicalStateHash: root },
      loadDurableBefore: { height: 30, canonicalStateHash: root },
      loadDurableAfter: { height: 31, canonicalStateHash: root },
      settlementEvidence,
    });
    expect(report.matchedTps).toBe(40);
    expect(report.fullySettledTps).toBe(20);
    expect(report.loadParticipantAccountCount).toBe(4);
    expect(report.offeredOrderRate).toBe(4);
    expect(report.walBytesAfter).toBe(2_000);
    expect(() => decodeLoadSustainedReport({ ...report, alternateCompletion: true }))
      .toThrow('PRODUCTION_SWAP_LOAD_REPORT_FIELDS_INVALID');
    expect(() => decodeLoadSustainedReport({ ...report, loadParticipantAccountCount: 3 }))
      .toThrow('PRODUCTION_SWAP_LOAD_REPORT_ACCOUNT_COUNTS_INVALID');
    expect(() => decodeLoadSustainedReport({ ...report, crossedBookAfterRun: true }))
      .toThrow('PRODUCTION_SWAP_LOAD_REPORT_CROSSED_BOOK_REMAINS');
  });

  test('settlement authority rejects pending bilateral and Runtime work', () => {
    const base = {
      expectedSwaps: 1, tradeCountBefore: 7, tradeCountAfter: 8,
      matchedElapsedMs: 10, fullySettledElapsedMs: 20,
      createdOfferIds: ['offer-1'],
      accounts: [{
        accountKey: 'load/hub', createdOfferIds: ['offer-1'],
        committedOfferIds: ['offer-1'], committedResolveIds: ['offer-1'],
        liveOfferIds: [], pendingFrame: false, pendingProposal: false, mempoolTxs: 0,
      }],
      runtimes: [
        { role: 'hub', processing: 0, pendingOutputs: 0, pendingNetworkOutputs: 0, networkInbox: 0, runtimeEntityInputs: 0, runtimeTxs: 0, runtimeJInputs: 0, retryEntries: 0 },
        { role: 'load', processing: 0, pendingOutputs: 0, pendingNetworkOutputs: 0, networkInbox: 0, runtimeEntityInputs: 0, runtimeTxs: 0, runtimeJInputs: 0, retryEntries: 0 },
        { role: 'market-maker', processing: 0, pendingOutputs: 0, pendingNetworkOutputs: 0, networkInbox: 0, runtimeEntityInputs: 0, runtimeTxs: 0, runtimeJInputs: 0, retryEntries: 0 },
      ],
      bestBidPriceTicks: 10n, bestAskPriceTicks: 11n,
    };
    expect(assertProductionSwapFullySettled(decodeProductionSwapSettlementEvidence(base)))
      .toEqual({ matchedTps: 100, fullySettledTps: 50 });
    expect(() => decodeProductionSwapSettlementEvidence({ ...base, untrusted: true }))
      .toThrow('PRODUCTION_SWAP_SETTLEMENT_FIELDS_INVALID');
    expect(() => assertProductionSwapFullySettled(decodeProductionSwapSettlementEvidence({
      ...base, accounts: [{ ...base.accounts[0], pendingProposal: true }],
    }))).toThrow('PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_NOT_DRAINED:load/hub');
    expect(() => assertProductionSwapFullySettled(decodeProductionSwapSettlementEvidence({
      ...base,
      runtimes: base.runtimes.map(runtime => runtime.role === 'load'
        ? { ...runtime, pendingNetworkOutputs: 1 }
        : runtime),
    }))).toThrow('PRODUCTION_SWAP_SETTLEMENT_RUNTIME_NOT_DRAINED:load');
    expect(() => assertProductionSwapFullySettled(decodeProductionSwapSettlementEvidence({
      ...base, bestBidPriceTicks: 11n,
    }))).toThrow('PRODUCTION_SWAP_SETTLEMENT_BOOK_CROSSED');
  });

  test('settlement waits for identical bilateral certified Account heads', () => {
    const head = { accountKey: `${`0x${'11'.repeat(32)}`}:${`0x${'22'.repeat(32)}`}`, currentHeight: 7, currentStateHash: `0x${'33'.repeat(32)}` };
    expect(sameBilateralAccountHead(head, { ...head })).toBe(true);
    expect(sameBilateralAccountHead(head, { ...head, currentHeight: 6 })).toBe(false);
    expect(sameBilateralAccountHead(head, { ...head, currentStateHash: `0x${'44'.repeat(32)}` })).toBe(false);
  });

  test('settlement reader never requests or decodes a full Book', () => {
    const source = readFileSync(new URL(
      '../../../scripts/operations/hlt/settlement-reader.ts',
      import.meta.url,
    ), 'utf8');
    expect(source).not.toContain('readLoadBook');
    expect(source).not.toContain('.adapter.read<');
    expect(source).not.toContain('decodeLoadBookPage');
    expect(source).toContain("type: 'settlement-evidence'");
  });

  test('book projection rejects malformed network pages without minting BookState', () => {
    const price = 25_000_000n;
    const secondPrice = 25_010_000n;
    let canonical = createBook({ bucketWidthTicks: 1_000n, maxOrders: 100, stpPolicy: 1 });
    canonical = applyCommand(canonical, {
      kind: 0, ownerId: 'maker', orderId: 'ask-1', side: 1, tif: 0,
      postOnly: true, priceTicks: price, qtyLots: 1n,
    }).state;
    canonical = applyCommand(canonical, {
      kind: 0, ownerId: 'maker', orderId: 'ask-2', side: 1, tif: 0,
      postOnly: true, priceTicks: secondPrice, qtyLots: 2n,
    }).state;
    const portable = {
      params: canonical.params,
      bidPages: projectBookPricePageTree(canonical.bidPages),
      askPages: projectBookPricePageTree(canonical.askPages),
      nextSeq: canonical.nextSeq,
      tradeCount: canonical.tradeCount,
      tradeQtySum: canonical.tradeQtySum,
      lastTradePriceTicks: canonical.lastTradePriceTicks,
      lastAcceptedUsdAskPriceTicks: canonical.lastAcceptedUsdAskPriceTicks,
      eventHash: canonical.eventHash,
    };
    const page = {
      items: [{ pairId: '1/2', book: {
        ...portable,
        tradeCount: 7, tradeQtySum: 3n, lastTradePriceTicks: price,
        lastAcceptedUsdAskPriceTicks: price, eventHash: 4n,
      }}],
      nextCursor: null, prevCursor: null, firstCursor: '1/2', lastCursor: '1/2',
      pageIndex: 0, pageCount: 1, totalItems: 1, limit: 10,
    };
    expect(decodeLoadBookPage(page, '1/2')).toEqual({
      tradeCount: 7,
      bestBidPriceTicks: null,
      bestAskPriceTicks: price,
      executableAskPriceTicks: [price, secondPrice],
      visibleBidOrders: 0,
      visibleAskOrders: 2,
    });
    expect(() => decodeLoadBookPage({
      ...page,
      items: [{ ...page.items[0], book: { ...page.items[0]!.book, askPages: { bad: true } } }],
    }, '1/2')).toThrow('PRODUCTION_SWAP_LOAD_ASK_PAGES_MAP_INVALID');
    const askPages = new Map(portable.askPages);
    const firstPageKey = askPages.keys().next().value;
    if (!firstPageKey) throw new Error('expected ask page');
    const firstPage = askPages.get(firstPageKey);
    if (!firstPage) throw new Error('expected ask page value');
    askPages.set(firstPageKey, { ...firstPage, totalQtyLots: firstPage.totalQtyLots + 1n });
    expect(() => decodeLoadBookPage({
      ...page,
      items: [{
        ...page.items[0],
        book: { ...page.items[0]!.book, askPages },
      }],
    }, '1/2')).toThrow('BOOK_PAGE_AGGREGATE_INVALID');
  });

  test('burst amount is lot-aligned and meets production minimum trade size', () => {
    const price = 25_000_000n;
    const minimumQuote = 10n * 10n ** 6n;
    const amount = deriveMinimumLotAlignedBaseAmount(2, 1, minimumQuote, price);
    expect(amount % getSwapLotScale(2)).toBe(0n);
    expect(quoteAmountAtPrice(2, 1, amount, price)).toBeGreaterThanOrEqual(minimumQuote);
  });

  test('bid uses an integral quote lot that preserves a partial maker ask minimum', () => {
    const askPrice = 25_025_000n;
    const bid = deriveExecutableBidForAsk(2, 1, 10_000_000n, askPrice);
    expect(bid).toEqual({ baseAmount: 3_998_000_000_000_000n, quoteAmount: 10_004_995n });
    expect(computeSwapPriceTicksForDimensions(
      1,
      2,
      bid.quoteAmount,
      bid.baseAmount,
      getStaticSwapTokenDimensions(1, 2),
    )).toBeGreaterThanOrEqual(askPrice);

    const makerGive = 17_850_000n * getSwapLotScale(2);
    const makerWant = quoteAmountAtPrice(2, 1, makerGive, askPrice);
    const maker = { giveAmount: makerGive, wantAmount: makerWant, ...deriveSwapNetAuthorization(makerWant, 0) };
    expect(() => assertSwapNetAuthorization(
      maker,
      bid.baseAmount,
      bid.quoteAmount,
      0n,
      false,
    )).not.toThrow();
    expect(() => assertSwapNetAuthorization(
      maker,
      3_997_000_000_000_000n,
      10_002_492n,
      0n,
      false,
    )).toThrow('SWAP_NET_AUTH_MIN_RECEIVE_NOT_MET');
  });

  test('same-j orders use the exact quote lattice instead of choosing a rounding winner', () => {
    const filledBase = 3_077_000_000_000_000n;
    const filledQuote = quoteAmountFromWeightedLotsForDecimals(18, 6, 25_005_000n * 3_077n);
    expect(filledQuote).toBe(7_694_038n);
    expect(getSwapExactQuoteLotMultipleAtPriceForDimensions(18, 6, 25_005_000n)).toBe(2n);
    const offer = {
      giveAmount: 10_200_000_000_000_000_000n,
      wantAmount: 25_505_100_000n,
      maxFee: 0n,
      minNetReceive: 25_505_100_000n,
    };
    expect(() => assertSwapNetAuthorization(offer, filledBase, filledQuote, 0n, false))
      .toThrow('SWAP_NET_AUTH_MIN_RECEIVE_NOT_MET');
    const executableBase = 3_076_000_000_000_000n;
    const executableQuote = quoteAmountFromWeightedLotsForDecimals(18, 6, 25_005_000n * 3_076n);
    expect(executableQuote).toBe(7_691_538n);
    expect(() => assertSwapNetAuthorization(offer, executableBase, executableQuote, 0n, false))
      .not.toThrow();
  });

  test('matcher snaps partial fills at the maker price and drops only unexecutable taker dust', () => {
    const multipleAtPrice = (priceTicks: bigint): bigint =>
      getSwapExactQuoteLotMultipleAtPriceForDimensions(18, 6, priceTicks);
    let book = createBook({ bucketWidthTicks: 10_000n, maxOrders: 10, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker',
      orderId: 'maker-ask',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_005_000n,
      qtyLots: 10_200_000n,
    }, { executionQtyMultipleAtPrice: multipleAtPrice }).state;
    const result = applyCommand(book, {
      kind: 0,
      ownerId: 'taker',
      orderId: 'taker-bid',
      side: 0,
      tif: 0,
      postOnly: false,
      priceTicks: 25_006_000n,
      qtyLots: 3_077n,
    }, { executionQtyMultipleAtPrice: multipleAtPrice });
    expect(result.events.find(event => event.type === 'TRADE')).toMatchObject({
      price: 25_005_000n,
      qty: 3_076n,
    });
    expect(result.state.orders.get('maker-ask')?.qtyLots).toBe(10_196_924n);
    expect(result.state.orders.has('taker-bid')).toBe(false);
  });

  test('every visible maker level survives canonical Account price quantization', () => {
    const dimensions = getStaticSwapTokenDimensions(1, 2);
    for (const priceTicks of [25_005_000n, 25_010_000n, 25_015_000n, 25_020_000n, 25_025_000n]) {
      const bid = deriveExecutableBidForAsk(2, 1, 10_000_000n, priceTicks);
      const prepared = prepareSwapOfferAmounts({
        type: 'swap_offer',
        data: {
          offerId: `load-${priceTicks}`,
          giveTokenId: 1,
          giveAmount: bid.quoteAmount,
          wantTokenId: 2,
          wantAmount: bid.baseAmount,
          ...dimensions,
          priceTicks,
          ...deriveSwapNetAuthorization(bid.baseAmount, 1),
        },
      });
      expect(prepared).toEqual({
        ok: true,
        prepared: {
          priceTicks,
          effectiveGiveAmount: bid.quoteAmount,
          effectiveWantAmount: bid.baseAmount,
        },
      });
    }
  });

  test('committed Hub profile is the only minimum-trade authority', () => {
    const core = {
      entityId: `0x${'11'.repeat(32)}`, entityEncryptionPublicKey: '0x01',
      height: 4, timestamp: 5, profile: {}, config: {}, nonces: new Map(),
      proposals: new Map(), reserves: new Map(), lastFinalizedJHeight: 0,
      htlcRoutes: new Map(), htlcFeesEarned: 0n, lockBook: new Map(),
      orderbookHubProfile: {
        entityId: `0x${'11'.repeat(32)}`, name: 'H1',
        spreadDistribution: {
          makerBps: 0, takerBps: 10_000, hubBps: 0,
          makerReferrerBps: 0, takerReferrerBps: 0,
        },
        referenceTokenId: 1, usdQuoteAuthorityEntityId: `0x${'11'.repeat(32)}`,
        minTradeSize: 10_000_001n, supportedPairs: ['1/2'],
      },
    };
    expect(decodeHubMinTradeSize(core)).toBe(10_000_001n);
    expect(() => decodeHubMinTradeSize({ ...core, futureField: true }))
      .toThrow('PRODUCTION_SWAP_LOAD_HUB_CORE_FIELDS_INVALID');
  });

  test('cross-j hubs must share one Runtime process and WAL while load and MM stay separate', () => {
    const runtimeId = `0x${'a'.repeat(40)}`;
    const topology = {
      sourceHub: { runtimeId, pid: 10, walPath: '/tmp/hub-wal' },
      targetHub: { runtimeId, pid: 10, walPath: '/tmp/hub-wal' },
      loadRuntime: { runtimeId: `0x${'b'.repeat(40)}`, pid: 11, walPath: '/tmp/load-wal' },
      marketMakerPid: 12,
      jurisdictionChainIds: [31_337, 31_338],
      networking: 'relay-p2p',
      persistence: 'leveldb-wal',
    };
    expect(() => decodeProductionSwapLoadTopology(topology, 'cross')).not.toThrow();
    expect(() => decodeProductionSwapLoadTopology({
      ...topology,
      targetHub: { runtimeId: `0x${'c'.repeat(40)}`, pid: 13, walPath: '/tmp/other-wal' },
    }, 'cross')).toThrow('PRODUCTION_SWAP_LOAD_CROSS_J_HUBS_NOT_ATOMICALLY_COHOSTED');
    expect(() => decodeProductionSwapLoadTopology({ ...topology, marketMakerPid: 11 }, 'cross'))
      .toThrow('PRODUCTION_SWAP_LOAD_MARKET_MAKER_NOT_SEPARATE');
  });

  test('default ladder is 10k through 100k and every step stays below ten minutes', () => {
    const config = decodeProductionSwapLoadConfig(defaultProductionSwapLoadConfig('hybrid'));
    expect(config.offeredRates).toEqual([10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000, 100_000]);
    expect(config.stepDurationMs).toBeLessThanOrEqual(600_000);
    expect(config.warningRamBps).toBe(5_000);
    expect(config.hardRamBps).toBe(7_000);
  });

  test('disk/network observations reject extra fields, invalid roots, and regressing counters', () => {
    expect(() => observation({ alternateCompletion: true })).toThrow('PRODUCTION_SWAP_LOAD_OBSERVATION_FIELDS_INVALID');
    expect(() => observation({ canonicalStateHash: '0x01' })).toThrow('PRODUCTION_SWAP_LOAD_CANONICAL_ROOT_INVALID');
    expect(() => summarizeProductionSwapLoadStep(defaultProductionSwapLoadConfig(), 10_000, 10_000, [
      observation({ completedTotal: 2 }),
      observation({ atMs: 2_000, completedTotal: 1 }),
    ])).toThrow('PRODUCTION_SWAP_LOAD_COUNTER_REGRESSION:completedTotal');
    expect(() => observation({ latencyHistogram: [] }))
      .toThrow('PRODUCTION_SWAP_LOAD_LATENCY_HISTOGRAM_LENGTH_INVALID');
  });

  test('completed TPS uses economic completions and hard-stops on loss or 70% RAM', () => {
    const result = summarizeProductionSwapLoadStep(defaultProductionSwapLoadConfig(), 10_000, 1_000, [
      observation(),
      observation({
        atMs: 2_000,
        offeredTotal: 10_000,
        completedTotal: 9_000,
        lostTotal: 1,
        queueDepth: 1_000,
        rssBytes: 700,
        cpuUserMicros: 501_000,
        cpuSystemMicros: 500_500,
        diskBytes: 2_000,
        runtimeHeight: 11,
        canonicalStateHash: root('b'),
        latencyHistogram: histogram([4, 1], [8, 1], [16, 1], [32, 1]),
        stagesMs: { wal: 3, signatures: 5 },
      }),
    ]);
    expect(result.completedTps).toBe(9_000);
    expect(result.latencyMs).toEqual({ p50: 4, p95: 32, p99: 32 });
    expect(result.status).toBe('hard-stop');
    expect(result.averageCpuCores).toBe(1);
    expect(result.stagesMs).toEqual({ wal: 5, signatures: 5 });
  });

  test('crash recovery requires the exact durable height and canonical root', () => {
    const before = observation({ runtimeHeight: 41, canonicalStateHash: root('c') });
    expect(() => assertExactCrashRecovery(before, observation({ runtimeHeight: 41, canonicalStateHash: root('c') }))).not.toThrow();
    expect(() => assertExactCrashRecovery(before, observation({ runtimeHeight: 42, canonicalStateHash: root('d') })))
      .toThrow('PRODUCTION_SWAP_LOAD_CRASH_ROOT_MISMATCH');
  });
});
