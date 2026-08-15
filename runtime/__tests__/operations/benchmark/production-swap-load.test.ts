import { describe, expect, test } from 'bun:test';

import {
  PRODUCTION_SWAP_LOAD_LATENCY_BUCKETS_MS,
  decodeProductionSwapLoadConfig,
  decodeProductionSwapLoadObservation,
  defaultProductionSwapLoadConfig,
} from '../../../scripts/operations/benchmark/production-swap-load/schema';
import {
  assertExactCrashRecovery,
  summarizeProductionSwapLoadStep,
} from '../../../scripts/operations/benchmark/production-swap-load/metrics';
import { decodeProductionSwapLoadTopology } from '../../../scripts/operations/benchmark/production-swap-load/topology';
import {
  decodeLoadBurstReport,
  decodeHubMinTradeSize,
  selectLocalHubIdentity,
} from '../../../scripts/operations/benchmark/production-swap-load/worker-boundary';
import {
  decodeLoadBookPage,
  deriveExecutableBidForAsk,
  deriveMinimumLotAlignedBaseAmount,
} from '../../../scripts/operations/benchmark/production-swap-load/worker-book-boundary';
import {
  computeSwapPriceTicksForDimensions,
  getStaticSwapTokenDimensions,
  getSwapLotScale,
  quoteAmountAtPrice,
} from '../../../orderbook';
import {
  assertSwapNetAuthorization,
  deriveSwapNetAuthorization,
} from '../../../account/swap/swap-net-authorization';

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

  test('burst report binds economic completion to committed trade count and durable roots', () => {
    const root = `0x${'ab'.repeat(32)}`;
    const report = decodeLoadBurstReport({
      schema: 'xln-production-swap-load-burst-v1', mode: 'same',
      schedule: 'visible_depth_runtime_input_batches', configuredBurstSize: 10,
      runtimeInputBatches: 2,
      completedEconomicSwaps: 10, completionAuthority: 'committed_orderbook_trade_count',
      enqueueAckElapsedMs: 10, commandObservedElapsedMs: 20,
      economicCompletionElapsedMs: 250, completedTps: 40,
      tradeCountBefore: 5, tradeCountAfter: 15,
      submittedEconomicSwaps: 10, uncompletedEconomicSwapsAfterRun: 0,
      driverRssBefore: 100, driverRssAfter: 110,
      walBytesBefore: 1_000, walBytesAfter: 2_000,
      durableBefore: { height: 20, canonicalStateHash: root },
      durableAfter: { height: 21, canonicalStateHash: root },
    });
    expect(report.completedEconomicSwaps).toBe(10);
    expect(report.walBytesAfter).toBe(2_000);
    expect(() => decodeLoadBurstReport({ ...report, alternateCompletion: true }))
      .toThrow('PRODUCTION_SWAP_LOAD_REPORT_FIELDS_INVALID');
  });

  test('book projection rejects malformed network buckets without minting BookState', () => {
    const price = 25_000_000n;
    const secondPrice = 25_010_000n;
    const bucketId = 25_000n;
    const level = { priceTicks: price, orderIds: ['ask-1'], totalQtyLots: 1n };
    const secondLevel = { priceTicks: secondPrice, orderIds: ['ask-2'], totalQtyLots: 2n };
    const bucket = {
      bucketId,
      pricesAsc: [price, secondPrice],
      levels: new Map([[price.toString(), level], [secondPrice.toString(), secondLevel]]),
    };
    const order = {
      orderId: 'ask-1', ownerId: 'maker', side: 1, priceTicks: price,
      qtyLots: 1n, seq: 1, bucketId,
    };
    const secondOrder = {
      orderId: 'ask-2', ownerId: 'maker', side: 1, priceTicks: secondPrice,
      qtyLots: 2n, seq: 2, bucketId,
    };
    const page = {
      items: [{ pairId: '1/2', book: {
        params: { bucketWidthTicks: 1_000n, maxOrders: 100, stpPolicy: 1 },
        orders: new Map([['ask-1', order], ['ask-2', secondOrder]]), bidBuckets: new Map(),
        askBuckets: new Map([[bucketId.toString(), bucket]]),
        bidBucketIdsDesc: [], askBucketIdsAsc: [bucketId], nextSeq: 3,
        tradeCount: 7, tradeQtySum: 3n, lastTradePriceTicks: price,
        lastAcceptedUsdAskPriceTicks: price, eventHash: 4n,
      }}],
      nextCursor: null, prevCursor: null, firstCursor: '1/2', lastCursor: '1/2',
      pageIndex: 0, pageCount: 1, totalItems: 1, limit: 10,
    };
    expect(decodeLoadBookPage(page, '1/2')).toEqual({
      tradeCount: 7,
      executableAskPriceTicks: [price, secondPrice],
    });
    expect(() => decodeLoadBookPage({
      ...page,
      items: [{ ...page.items[0], book: { ...page.items[0]!.book, askBuckets: { bad: bucket } } }],
    }, '1/2')).toThrow('PRODUCTION_SWAP_LOAD_ASK_BUCKETS_INVALID');
    expect(() => decodeLoadBookPage({
      ...page,
      items: [{
        ...page.items[0],
        book: {
          ...page.items[0]!.book,
          orders: new Map([['ask-1', order], ['ask-2', { ...secondOrder, priceTicks: price }]]),
        },
      }],
    }, '1/2')).toThrow('PRODUCTION_SWAP_LOAD_ASK_ORDER_INVALID');
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

  test('committed Hub profile is the only minimum-trade authority', () => {
    const core = {
      entityId: `0x${'11'.repeat(32)}`, entityEncryptionPublicKey: '0x01',
      height: 4, timestamp: 5, profile: {}, config: {}, nonces: new Map(),
      proposals: new Map(), reserves: new Map(), lastFinalizedJHeight: 0,
      jBlockChain: [], htlcRoutes: new Map(), htlcFeesEarned: 0n, lockBook: new Map(),
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
