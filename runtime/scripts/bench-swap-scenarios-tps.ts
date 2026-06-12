import {
  applyCommand,
  computeBookHash,
  createBook,
  getBestAsk,
  getBestBid,
  type BookEvent,
  type BookState,
  type Side,
} from '../orderbook';
import { getPerfMs } from '../utils';
import { runSwapRuntimeBenchmark } from './bench-swap-runtime-tps';

type Cli = {
  swaps: number;
  warmup: number;
  minTps: number;
  levels: number;
};

type ScenarioResult = {
  name: string;
  operations: number;
  elapsedMs: number;
  tps: number;
  passed: boolean;
  trades: number;
  rejects: number;
  cancels: number;
  activeOrders: number;
  bookHash: string;
};

type ScenarioBenchmarkResult = {
  benchmark: 'swap-scenarios';
  swaps: number;
  minTps: number;
  passed: boolean;
  aggregateOperations: number;
  aggregateElapsedMs: number;
  aggregateTps: number;
  scenarios: ScenarioResult[];
  runtime: Awaited<ReturnType<typeof runSwapRuntimeBenchmark>>;
};

const BASE_PRICE = 25_000_000n;

const argValue = (args: string[], name: string, fallback: string): string => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};

const positiveInt = (args: string[], name: string, fallback: number): number => {
  const value = Number.parseInt(argValue(args, name, String(fallback)), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`INVALID_ARG:${name}`);
  return value;
};

const nonNegativeInt = (args: string[], name: string, fallback: number): number => {
  const value = Number.parseInt(argValue(args, name, String(fallback)), 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`INVALID_ARG:${name}`);
  return value;
};

const parseCli = (args: string[]): Cli => ({
  swaps: positiveInt(args, '--swaps', 25_000),
  warmup: nonNegativeInt(args, '--warmup', 2_500),
  minTps: positiveInt(args, '--min-tps', 10_000),
  levels: positiveInt(args, '--levels', 32),
});

const makeBook = (maxOrders: number): BookState =>
  createBook({
    bucketWidthTicks: 100n,
    maxOrders: Math.max(1, maxOrders + 16),
    stpPolicy: 1,
  });

const countEvents = (events: readonly BookEvent[], type: BookEvent['type']): number =>
  events.reduce((sum, event) => sum + (event.type === type ? 1 : 0), 0);

const requireEvent = (events: readonly BookEvent[], type: BookEvent['type'], context: string): void => {
  if (events.some((event) => event.type === type)) return;
  throw new Error(`${context}:missing_${type}`);
};

const priceFor = (side: Side, index: number, levels: number): bigint =>
  side === 1
    ? BASE_PRICE + BigInt(index % levels)
    : BASE_PRICE - BigInt(index % levels);

const seedSide = (count: number, side: Side, levels: number): BookState => {
  let book = makeBook(count);
  for (let index = 0; index < count; index += 1) {
    const result = applyCommand(book, {
      kind: 0,
      ownerId: `maker-${side}-${index % 4096}`,
      orderId: `${side === 1 ? 'ask' : 'bid'}-${index}`,
      side,
      tif: 0,
      postOnly: false,
      priceTicks: priceFor(side, index, levels),
      qtyLots: 1,
    });
    book = result.state;
    if (result.events.some((event) => event.type === 'REJECT')) {
      throw new Error(`SEED_REJECT:${side}:${index}:${JSON.stringify(result.events)}`);
    }
  }
  return book;
};

const finishScenario = (
  name: string,
  book: BookState,
  operations: number,
  elapsedMs: number,
  minTps: number,
  stats: { trades?: number; rejects?: number; cancels?: number },
): ScenarioResult => {
  const elapsedSeconds = Math.max(elapsedMs / 1000, 0.001);
  const tps = operations / elapsedSeconds;
  return {
    name,
    operations,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    tps: Number(tps.toFixed(2)),
    passed: tps >= minTps,
    trades: stats.trades ?? 0,
    rejects: stats.rejects ?? 0,
    cancels: stats.cancels ?? 0,
    activeOrders: book.orders.size,
    bookHash: computeBookHash(book),
  };
};

const runAskFillScenario = (swaps: number, levels: number, minTps: number): ScenarioResult => {
  let book = seedSide(swaps, 1, levels);
  let trades = 0;
  const startedAt = getPerfMs();
  for (let index = 0; index < swaps; index += 1) {
    const result = applyCommand(book, {
      kind: 0,
      ownerId: `buyer-${index % 4096}`,
      orderId: `buy-ask-${index}`,
      side: 0,
      tif: 1,
      postOnly: false,
      priceTicks: BASE_PRICE + BigInt(levels),
      qtyLots: 1,
    });
    book = result.state;
    trades += countEvents(result.events, 'TRADE');
  }
  if (trades !== swaps) throw new Error(`ASK_FILL_TRADE_MISMATCH:${trades}/${swaps}`);
  if (getBestAsk(book) !== null) throw new Error(`ASK_FILL_ASKS_LEFT:${String(getBestAsk(book))}`);
  return finishScenario('orderbook.ask_fill', book, swaps, getPerfMs() - startedAt, minTps, { trades });
};

const runBidFillScenario = (swaps: number, levels: number, minTps: number): ScenarioResult => {
  let book = seedSide(swaps, 0, levels);
  let trades = 0;
  const startedAt = getPerfMs();
  for (let index = 0; index < swaps; index += 1) {
    const result = applyCommand(book, {
      kind: 0,
      ownerId: `seller-${index % 4096}`,
      orderId: `sell-bid-${index}`,
      side: 1,
      tif: 1,
      postOnly: false,
      priceTicks: BASE_PRICE - BigInt(levels),
      qtyLots: 1,
    });
    book = result.state;
    trades += countEvents(result.events, 'TRADE');
  }
  if (trades !== swaps) throw new Error(`BID_FILL_TRADE_MISMATCH:${trades}/${swaps}`);
  if (getBestBid(book) !== null) throw new Error(`BID_FILL_BIDS_LEFT:${String(getBestBid(book))}`);
  return finishScenario('orderbook.bid_fill', book, swaps, getPerfMs() - startedAt, minTps, { trades });
};

const runRestingCancelScenario = (swaps: number, side: Side, levels: number, minTps: number): ScenarioResult => {
  let book = makeBook(1);
  let cancels = 0;
  const label = side === 1 ? 'ask' : 'bid';
  const startedAt = getPerfMs();
  for (let index = 0; index < swaps; index += 1) {
    const ownerId = `rest-${label}-${index % 4096}`;
    const orderId = `rest-${label}-${index}`;
    const placed = applyCommand(book, {
      kind: 0,
      ownerId,
      orderId,
      side,
      tif: 0,
      postOnly: true,
      priceTicks: priceFor(side, index, levels),
      qtyLots: 1,
    });
    requireEvent(placed.events, 'ACK', `REST_${label.toUpperCase()}_PLACE:${index}`);
    book = placed.state;
    const canceled = applyCommand(book, { kind: 1, ownerId, orderId });
    requireEvent(canceled.events, 'CANCELED', `REST_${label.toUpperCase()}_CANCEL:${index}`);
    book = canceled.state;
    cancels += 1;
  }
  if (book.orders.size !== 0) throw new Error(`REST_${label.toUpperCase()}_ORDERS_LEFT:${book.orders.size}`);
  return finishScenario(`orderbook.resting_${label}_cancel`, book, swaps * 2, getPerfMs() - startedAt, minTps, { cancels });
};

const runSelfTradeScenario = (swaps: number, levels: number, minTps: number): ScenarioResult => {
  let book = makeBook(1);
  let rejects = 0;
  let cancels = 0;
  const startedAt = getPerfMs();
  for (let index = 0; index < swaps; index += 1) {
    const ownerId = `self-${index % 4096}`;
    const makerOrderId = `self-ask-${index}`;
    const placed = applyCommand(book, {
      kind: 0,
      ownerId,
      orderId: makerOrderId,
      side: 1,
      tif: 0,
      postOnly: true,
      priceTicks: BASE_PRICE + BigInt(index % levels),
      qtyLots: 1,
    });
    requireEvent(placed.events, 'ACK', `STP_PLACE:${index}`);
    book = placed.state;
    const rejected = applyCommand(book, {
      kind: 0,
      ownerId,
      orderId: `self-buy-${index}`,
      side: 0,
      tif: 1,
      postOnly: false,
      priceTicks: BASE_PRICE + BigInt(levels),
      qtyLots: 1,
    });
    requireEvent(rejected.events, 'REJECT', `STP_TAKER:${index}`);
    if (!rejected.events.some((event) => event.type === 'REJECT' && /STP/i.test(event.reason))) {
      throw new Error(`STP_REJECT_REASON_MISMATCH:${index}:${JSON.stringify(rejected.events)}`);
    }
    book = rejected.state;
    rejects += 1;
    const canceled = applyCommand(book, { kind: 1, ownerId, orderId: makerOrderId });
    requireEvent(canceled.events, 'CANCELED', `STP_CANCEL_MAKER:${index}`);
    book = canceled.state;
    cancels += 1;
  }
  if (book.tradeCount !== 0) throw new Error(`STP_TRADED:${book.tradeCount}`);
  if (book.orders.size !== 0) throw new Error(`STP_ORDERS_LEFT:${book.orders.size}`);
  return finishScenario('orderbook.self_trade_cancel_taker', book, swaps * 3, getPerfMs() - startedAt, minTps, { rejects, cancels });
};

const runOrderbookScenarios = (cli: Cli): ScenarioResult[] => [
  runAskFillScenario(cli.swaps, cli.levels, cli.minTps),
  runBidFillScenario(cli.swaps, cli.levels, cli.minTps),
  runRestingCancelScenario(cli.swaps, 1, cli.levels, cli.minTps),
  runRestingCancelScenario(cli.swaps, 0, cli.levels, cli.minTps),
  runSelfTradeScenario(cli.swaps, cli.levels, cli.minTps),
];

export const runSwapScenarioBenchmark = async (cli: Cli): Promise<ScenarioBenchmarkResult> => {
  if (cli.warmup > 0) runOrderbookScenarios({ ...cli, swaps: cli.warmup, warmup: 0, minTps: 1 });
  const scenarios = runOrderbookScenarios(cli);
  const runtime = await runSwapRuntimeBenchmark({ swaps: cli.swaps, warmup: cli.warmup, minTps: cli.minTps });
  const aggregateOperations = scenarios.reduce((sum, scenario) => sum + scenario.operations, 0) + runtime.sameSwaps + runtime.crossSwaps;
  const aggregateElapsedMs = scenarios.reduce((sum, scenario) => sum + scenario.elapsedMs, 0) + runtime.elapsedMs;
  const aggregateTps = aggregateOperations / Math.max(aggregateElapsedMs / 1000, 0.001);
  const passed = scenarios.every((scenario) => scenario.passed) && runtime.passed;
  const output: ScenarioBenchmarkResult = {
    benchmark: 'swap-scenarios',
    swaps: cli.swaps,
    minTps: cli.minTps,
    passed,
    aggregateOperations,
    aggregateElapsedMs: Number(aggregateElapsedMs.toFixed(3)),
    aggregateTps: Number(aggregateTps.toFixed(2)),
    scenarios,
    runtime,
  };
  if (!passed) {
    const failed = scenarios.filter((scenario) => !scenario.passed).map((scenario) => `${scenario.name}:${scenario.tps}`).join(',');
    throw new Error(`SWAP_SCENARIO_TPS_BELOW_TARGET:${failed || `runtime:${runtime.tps}`}<${cli.minTps}`);
  }
  return output;
};

if (import.meta.main) {
  console.log(JSON.stringify(await runSwapScenarioBenchmark(parseCli(globalThis.process.argv.slice(2))), null, 2));
}
