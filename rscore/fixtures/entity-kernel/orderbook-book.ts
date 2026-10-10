/**
 * Canonical TypeScript book-level oracle for the Rust orderbook twin.
 *
 * Every case replays one ordered list of book operations through the
 * production `core/orderbook` transitions and records the exact event list,
 * event hash and book commitment after each step. The Rust replay lives in
 * `rscore/crates/entity-kernel/src/orderbook/tests/book_parity.rs`.
 *
 * Regenerate from the repository root:
 *   bun rscore/fixtures/entity-kernel/orderbook-book.ts
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { commitBookOverlay } from '../../../core/orderbook/book-overlay';
import { computeBookCommitmentHash } from '../../../core/orderbook/commitment';
import {
  applyCommand,
  bookOrdersOutsidePriceRange,
  createBook,
  getBookOrders,
  OrderbookCapacityError,
  resumeCrossedBook,
  type ApplyCommandOptions,
  type BookEvent,
  type BookState,
} from '../../../core/orderbook/core';
import { getSwapExactQuoteLotMultipleAtPriceForDimensions } from '../../../core/orderbook/types';
import { safeStringify } from '../../../core/protocol/serialization';

const BASE_TOKEN_DECIMALS = 6;
const QUOTE_TOKEN_DECIMALS = 18;
const BUCKET_WIDTH_TICKS = 100;

type Suspended = readonly string[] | 'all';
type AddStep = Readonly<{
  kind: 'add';
  orderId: string;
  ownerId: string;
  side: 'bid' | 'ask';
  priceTicks: string;
  qtyLots: string;
  timeInForce: 0 | 1 | 2;
  suspended: Suspended;
}>;
type ResumeStep = Readonly<{ kind: 'resume'; suspended: Suspended }>;
type SweepStep = Readonly<{ kind: 'sweep'; minPriceTicks: string; maxPriceTicks: string }>;
type BookStep = AddStep | ResumeStep | SweepStep;

type StepResult = Readonly<{
  outcome: 'applied' | 'book-full' | 'idle';
  events: readonly string[];
  takerOrderId: string | null;
  sweptOrderIds: readonly string[];
  orderIds: readonly string[];
  eventHash: string;
  bookCommitmentHash: string;
}>;

const projectEvent = (event: BookEvent): string => {
  switch (event.type) {
    case 'ACK':
      return 'ACK';
    case 'REDUCED':
      return 'REDUCED';
    case 'REJECT':
      return `REJECT:${event.reason}:${event.blockingOrderId ?? '-'}`;
    case 'TRADE':
      return `TRADE:${event.price}:${event.qty}:${event.makerOrderId}:${event.takerOrderId}:` +
        `${event.makerQtyBefore}:${event.takerQtyTotal}`;
    case 'CANCELED':
      return 'CANCELED';
  }
};

const options = (suspended: Suspended): ApplyCommandOptions => ({
  makerDisposition: maker =>
    suspended === 'all' || suspended.includes(maker.orderId) ? 'suspended' : 'eligible',
  executionQtyMultipleAtPrice: priceTicks => getSwapExactQuoteLotMultipleAtPriceForDimensions(
    BASE_TOKEN_DECIMALS,
    QUOTE_TOKEN_DECIMALS,
    priceTicks,
  ),
});

const snapshot = (
  book: BookState,
  outcome: StepResult['outcome'],
  events: readonly BookEvent[],
  extra: Partial<Pick<StepResult, 'takerOrderId' | 'sweptOrderIds'>> = {},
): StepResult => ({
  outcome,
  events: events.map(projectEvent),
  takerOrderId: extra.takerOrderId ?? null,
  sweptOrderIds: extra.sweptOrderIds ?? [],
  orderIds: getBookOrders(book).map(order => order.orderId),
  eventHash: book.eventHash.toString(),
  bookCommitmentHash: computeBookCommitmentHash(book),
});

const applyAdd = (book: BookState, step: AddStep): [BookState, StepResult] => {
  try {
    const result = applyCommand(book, {
      kind: 0,
      ownerId: step.ownerId,
      orderId: step.orderId,
      side: step.side === 'bid' ? 0 : 1,
      tif: step.timeInForce,
      postOnly: false,
      priceTicks: BigInt(step.priceTicks),
      qtyLots: BigInt(step.qtyLots),
    }, options(step.suspended));
    const next = commitBookOverlay(result.state);
    return [next, snapshot(next, 'applied', result.events)];
  } catch (error) {
    // Production same-J and cross-J callers turn exactly this error into a
    // zero-fill cancel of the incoming offer and discard the working book.
    if (!(error instanceof OrderbookCapacityError)) throw error;
    return [book, snapshot(book, 'book-full', [])];
  }
};

const applyResume = (book: BookState, step: ResumeStep): [BookState, StepResult] => {
  const resumed = resumeCrossedBook(book, options(step.suspended));
  if (!resumed) return [book, snapshot(book, 'idle', [])];
  const next = commitBookOverlay(resumed.state);
  return [next, snapshot(next, 'applied', resumed.events, { takerOrderId: resumed.takerOrderId })];
};

/** Mirrors `sweepSamePairOutOfBandOffers`: cancel in generator order. */
const applySweep = (book: BookState, step: SweepStep): [BookState, StepResult] => {
  const swept = [...bookOrdersOutsidePriceRange(
    book,
    BigInt(step.minPriceTicks),
    BigInt(step.maxPriceTicks),
  )];
  let next = book;
  for (const order of swept) {
    next = commitBookOverlay(applyCommand(next, {
      kind: 1,
      ownerId: order.ownerId,
      orderId: order.orderId,
    }).state);
  }
  return [next, snapshot(next, 'applied', [], { sweptOrderIds: swept.map(order => order.orderId) })];
};

const applyStep = (book: BookState, step: BookStep): [BookState, StepResult] => {
  if (step.kind === 'add') return applyAdd(book, step);
  if (step.kind === 'resume') return applyResume(book, step);
  return applySweep(book, step);
};

const add = (
  orderId: string,
  ownerId: string,
  side: AddStep['side'],
  priceTicks: bigint,
  suspended: Suspended = [],
  qtyLots = 1n,
): AddStep => ({
  kind: 'add',
  orderId,
  ownerId,
  side,
  priceTicks: priceTicks.toString(),
  qtyLots: qtyLots.toString(),
  timeInForce: 0,
  suspended,
});

type BookCase = Readonly<{ name: string; maxOrders: number; steps: readonly BookStep[] }>;

const cases: readonly BookCase[] = [
  {
    // A crossed resume whose taker hits its own resting order cancels that
    // taker. A cancel of a resting order always folds tag 5 into the event hash.
    name: 'resume-stp-cancels-resting-taker',
    maxOrders: 16,
    steps: [
      add('x:ask', 'owner-x', 'ask', 100n),
      add('x:bid', 'owner-x', 'bid', 100n, ['x:ask']),
      { kind: 'resume', suspended: [] },
    ],
  },
  {
    // The newest crossed order is suspended by its queued resolve. Resume must
    // pick takers only among eligible orders, so nothing trades.
    name: 'resume-skips-suspended-taker',
    maxOrders: 16,
    steps: [
      add('a:ask', 'owner-a', 'ask', 100n),
      add('b:bid', 'owner-b', 'bid', 100n, ['a:ask']),
      { kind: 'resume', suspended: ['b:bid'] },
    ],
  },
  {
    // The raw top ask is suspended. The newest eligible crossing order is the
    // next ask, so it is the taker and trades at the resting bid price.
    name: 'resume-takes-newest-eligible-order',
    maxOrders: 16,
    steps: [
      add('a1:ask', 'owner-a1', 'ask', 99n),
      add('b:bid', 'owner-b', 'bid', 101n, ['a1:ask']),
      add('a2:ask', 'owner-a2', 'ask', 100n, ['b:bid']),
      { kind: 'resume', suspended: ['a1:ask'] },
    ],
  },
  {
    // Out-of-band sweep cancel order: per side (bids, then asks), prices below
    // the band ascending, then prices above it descending, FIFO within a price.
    name: 'out-of-band-sweep-cancel-order',
    maxOrders: 64,
    steps: [
      add('bid-85-a', 'owner-1', 'bid', 85n, 'all'),
      add('bid-100', 'owner-2', 'bid', 100n, 'all'),
      add('bid-85-b', 'owner-3', 'bid', 85n, 'all'),
      add('bid-90', 'owner-4', 'bid', 90n, 'all'),
      add('bid-150', 'owner-5', 'bid', 150n, 'all'),
      add('bid-210-a', 'owner-6', 'bid', 210n, 'all'),
      add('bid-200', 'owner-7', 'bid', 200n, 'all'),
      add('bid-210-b', 'owner-8', 'bid', 210n, 'all'),
      add('ask-60-a', 'owner-9', 'ask', 60n, 'all'),
      add('ask-50', 'owner-10', 'ask', 50n, 'all'),
      add('ask-60-b', 'owner-11', 'ask', 60n, 'all'),
      add('ask-160', 'owner-12', 'ask', 160n, 'all'),
      add('ask-300-a', 'owner-13', 'ask', 300n, 'all'),
      add('ask-310', 'owner-14', 'ask', 310n, 'all'),
      add('ask-300-b', 'owner-15', 'ask', 300n, 'all'),
      { kind: 'sweep', minPriceTicks: '105', maxPriceTicks: '195' },
    ],
  },
];

const executeCase = (testCase: BookCase) => {
  let book = createBook({
    bucketWidthTicks: BigInt(BUCKET_WIDTH_TICKS),
    maxOrders: testCase.maxOrders,
    stpPolicy: 1,
  });
  const results: StepResult[] = [];
  for (const step of testCase.steps) {
    const [next, result] = applyStep(book, step);
    book = next;
    results.push(result);
  }
  return {
    name: testCase.name,
    maxOrders: testCase.maxOrders,
    steps: testCase.steps.map((step, index) => ({ step, expected: results[index] })),
  };
};

export const executeOrderbookBookParityVector = () => ({
  version: 1,
  canonicalSource: 'TypeScript core/orderbook/core.ts',
  bucketWidthTicks: BUCKET_WIDTH_TICKS,
  baseTokenDecimals: BASE_TOKEN_DECIMALS,
  quoteTokenDecimals: QUOTE_TOKEN_DECIMALS,
  cases: cases.map(executeCase),
});

if (import.meta.main) {
  const target = join(import.meta.dir, 'orderbook-book-v1.json');
  await writeFile(target, `${safeStringify(executeOrderbookBookParityVector(), 2)}\n`, 'utf8');
  process.stdout.write(`${target}\n`);
}
