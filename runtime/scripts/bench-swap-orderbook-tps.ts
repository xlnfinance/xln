import {
  applyCommand,
  computeBookHash,
  createBook,
  getBestAsk,
  getBestBid,
  type BookEvent,
  type BookState,
} from '../orderbook';
import { getPerfMs } from '../utils';

type Cli = {
  swaps: number;
  warmup: number;
  minTps: number;
  levels: number;
};

export type SwapOrderbookBenchmarkResult = {
  benchmark: 'swap-orderbook-core';
  swaps: number;
  trades: number;
  elapsedMs: number;
  tps: number;
  minTps: number;
  passed: boolean;
  activeOrders: number;
  tradeQtySum: string;
  bookHash: string;
};

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
  swaps: positiveInt(args, '--swaps', 100_000),
  warmup: nonNegativeInt(args, '--warmup', 10_000),
  minTps: positiveInt(args, '--min-tps', 10_000),
  levels: positiveInt(args, '--levels', 32),
});

export const runSwapOrderbookBenchmark = (cli: Cli): SwapOrderbookBenchmarkResult => {
  if (cli.warmup > 0) {
    const warm = runSweep(cli.warmup, cli.levels);
    if (warm.trades !== cli.warmup) throw new Error(`WARMUP_TRADE_MISMATCH:${warm.trades}/${cli.warmup}`);
  }

  const result = runSweep(cli.swaps, cli.levels);
  if (result.trades !== cli.swaps) throw new Error(`TRADE_MISMATCH:${result.trades}/${cli.swaps}`);
  if (result.book.orders.size !== 0) throw new Error(`BOOK_NOT_DRAINED:${result.book.orders.size}`);
  if (getBestAsk(result.book) !== null) throw new Error(`ASKS_LEFT:${String(getBestAsk(result.book))}`);
  if (getBestBid(result.book) !== null) throw new Error(`BIDS_LEFT:${String(getBestBid(result.book))}`);

  const elapsedSeconds = Math.max(result.elapsedMs / 1000, 0.001);
  const tps = result.trades / elapsedSeconds;
  const output: SwapOrderbookBenchmarkResult = {
    benchmark: 'swap-orderbook-core',
    swaps: cli.swaps,
    trades: result.trades,
    elapsedMs: Number(result.elapsedMs.toFixed(3)),
    tps: Number(tps.toFixed(2)),
    minTps: cli.minTps,
    passed: tps >= cli.minTps,
    activeOrders: result.book.orders.size,
    tradeQtySum: result.book.tradeQtySum.toString(),
    bookHash: computeBookHash(result.book),
  };
  if (!output.passed) {
    throw new Error(`SWAP_TPS_BELOW_TARGET:${tps.toFixed(2)}<${cli.minTps}`);
  }
  return output;
};

const countTrades = (events: readonly BookEvent[]): number =>
  events.reduce((sum, event) => sum + (event.type === 'TRADE' ? 1 : 0), 0);

const seedAsks = (count: number, levels: number): BookState => {
  let book = createBook({
    bucketWidthTicks: 100n,
    maxOrders: Math.max(1, count + 16),
    stpPolicy: 1,
  });
  for (let index = 0; index < count; index += 1) {
    const priceTicks = 25_000_000n + BigInt(index % levels);
    const result = applyCommand(book, {
      kind: 0,
      ownerId: `maker-${index % 4096}`,
      orderId: `ask-${index}`,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks,
      qtyLots: 1n,
    });
    book = result.state;
    if (result.events.some((event) => event.type === 'REJECT')) {
      throw new Error(`SEED_REJECT:${index}:${JSON.stringify(result.events)}`);
    }
  }
  return book;
};

const runSweep = (swaps: number, levels: number): { book: BookState; trades: number; elapsedMs: number } => {
  let book = seedAsks(swaps, levels);
  let trades = 0;
  const startedAt = getPerfMs();
  for (let index = 0; index < swaps; index += 1) {
    const result = applyCommand(book, {
      kind: 0,
      ownerId: `taker-${index % 4096}`,
      orderId: `buy-${index}`,
      side: 0,
      tif: 1,
      postOnly: false,
      priceTicks: 25_000_000n + BigInt(levels),
      qtyLots: 1n,
    });
    book = result.state;
    trades += countTrades(result.events);
  }
  return { book, trades, elapsedMs: getPerfMs() - startedAt };
};

if (import.meta.main) {
  console.log(JSON.stringify(runSwapOrderbookBenchmark(parseCli(globalThis.process.argv.slice(2))), null, 2));
}
