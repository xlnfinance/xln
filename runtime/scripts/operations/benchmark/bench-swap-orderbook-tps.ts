import {
  applyCommand,
  commitBookOverlay,
  computeBookHash,
  createBook,
  forkBookState,
  getBestAsk,
  getBestBid,
  type BookEvent,
  type BookState,
} from '../../../orderbook';
import { getPerfMs } from '../../../infra/time';

type Cli = {
  swaps: number;
  warmup: number;
  minTps: number;
  levels: number;
  bookCommandsPerOverlay: number;
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
  /** Matcher-only batching; this benchmark does not execute Account or Entity frames. */
  bookCommandsPerOverlay: number;
  tradeQtySum: string;
  bookHash: string;
};

const argValue = (args: string[], name: string, defaultValue: string): string => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? defaultValue : defaultValue;
};

const positiveInt = (args: string[], name: string, defaultValue: number): number => {
  const value = Number.parseInt(argValue(args, name, String(defaultValue)), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`INVALID_ARG:${name}`);
  return value;
};

const nonNegativeInt = (args: string[], name: string, defaultValue: number): number => {
  const value = Number.parseInt(argValue(args, name, String(defaultValue)), 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`INVALID_ARG:${name}`);
  return value;
};

const parseCli = (args: string[]): Cli => ({
  swaps: positiveInt(args, '--swaps', 100_000),
  warmup: nonNegativeInt(args, '--warmup', 10_000),
  minTps: positiveInt(args, '--min-tps', 10_000),
  levels: positiveInt(args, '--levels', 32),
  bookCommandsPerOverlay: positiveInt(args, '--book-commands-per-overlay', 160),
});

export const runSwapOrderbookBenchmark = (cli: Cli): SwapOrderbookBenchmarkResult => {
  if (cli.warmup > 0) {
    const warm = runSweep(cli.warmup, cli.levels, cli.bookCommandsPerOverlay);
    if (warm.trades !== cli.warmup) throw new Error(`WARMUP_TRADE_MISMATCH:${warm.trades}/${cli.warmup}`);
  }

  const result = runSweep(cli.swaps, cli.levels, cli.bookCommandsPerOverlay);
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
    bookCommandsPerOverlay: cli.bookCommandsPerOverlay,
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

const applyFramedCommands = (
  initial: BookState,
  count: number,
  commandsPerFrame: number,
  commandAt: (index: number) => Parameters<typeof applyCommand>[1],
  observe: (events: readonly BookEvent[]) => void,
): BookState => {
  let published = initial;
  for (let offset = 0; offset < count; offset += commandsPerFrame) {
    const frame = forkBookState(published);
    for (let index = offset; index < Math.min(count, offset + commandsPerFrame); index += 1) {
      const result = applyCommand(frame, commandAt(index));
      if (commitBookOverlay(result.state) !== frame) throw new Error('SWAP_FRAME_CHILD_MERGE_FAILED');
      observe(result.events);
    }
    published = commitBookOverlay(frame);
  }
  return published;
};

const seedAsks = (count: number, levels: number, commandsPerFrame: number): BookState => {
  let book = createBook({
    bucketWidthTicks: 100n,
    maxOrders: Math.max(1, count + 16),
    stpPolicy: 1,
  });
  book = applyFramedCommands(book, count, commandsPerFrame, index => ({
      kind: 0,
      ownerId: `maker-${index % 4096}`,
      orderId: `ask-${index}`,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n + BigInt(index % levels),
      qtyLots: 1n,
    }), events => {
      if (events.some(event => event.type === 'REJECT')) {
        throw new Error(`SEED_REJECT:${JSON.stringify(events)}`);
      }
    });
  return book;
};

const runSweep = (
  swaps: number,
  levels: number,
  commandsPerFrame: number,
): { book: BookState; trades: number; elapsedMs: number } => {
  let book = seedAsks(swaps, levels, commandsPerFrame);
  let trades = 0;
  const startedAt = getPerfMs();
  book = applyFramedCommands(book, swaps, commandsPerFrame, index => ({
    kind: 0,
    ownerId: `taker-${index % 4096}`,
    orderId: `buy-${index}`,
    side: 0,
    tif: 1,
    postOnly: false,
    priceTicks: 25_000_000n + BigInt(levels),
    qtyLots: 1n,
  }), events => {
    trades += countTrades(events);
  });
  return { book, trades, elapsedMs: getPerfMs() - startedAt };
};

if (import.meta.main) {
  console.log(JSON.stringify(runSwapOrderbookBenchmark(parseCli(globalThis.process.argv.slice(2))), null, 2));
}
