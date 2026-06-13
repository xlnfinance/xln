import { expect, test } from 'bun:test';
import { createMarketSubscriptionStack } from '../relay/market-subscriptions';
import type { MarketSnapshotPayload } from '../market-snapshot';

type FakeSocket = {
  ip: string;
  sent: unknown[];
  send(payload: string): void;
};

const HUB_ID = `0x${'a'.repeat(64)}`;

const makeSocket = (ip = '127.0.0.1'): FakeSocket => ({
  ip,
  sent: [],
  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  },
});

const makeSnapshot = (hubEntityId: string, pairId: string, depth: number): MarketSnapshotPayload => ({
  format: 'exact-price-levels-v2',
  hubEntityId,
  pairId,
  depth,
  displayDecimals: 4,
  priceScale: '100000000',
  bucketWidthTicks: null,
  bids: [],
  asks: [],
  spread: null,
  spreadPercent: '-',
  source: 'orderbookExt',
  entityHeight: 1,
  entityStateHash: null,
  hubUpdatedAt: 1,
  updatedAt: 1,
});

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

test('market subscription stack subscribes, sends snapshots, and cleans up counters', async () => {
  const ws = makeSocket('10.0.0.1');
  const stack = createMarketSubscriptionStack<FakeSocket>({
    maxSubscriptions: 2,
    maxSubscriptionsPerIp: 1,
    maxCellsPerSubscription: 4,
    getClientIp: socket => socket.ip,
    fetchSnapshots: (hubEntityId, pairIds, depth) => pairIds.map(pairId => makeSnapshot(hubEntityId, pairId, depth)),
  });

  await stack.handleMessage(ws, {
    type: 'market_subscribe',
    id: 'sub-1',
    hubEntityId: HUB_ID,
    pairs: ['3/1'],
    depth: 5,
  });

  expect(ws.sent).toHaveLength(2);
  expect(ws.sent[0]).toMatchObject({
    type: 'ack',
    inReplyTo: 'sub-1',
    status: 'market_subscribed',
    data: { hubEntityIds: [HUB_ID], pairs: ['1/3'], depth: 5 },
  });
  expect(ws.sent[1]).toMatchObject({
    type: 'market_snapshot',
    payload: { hubEntityId: HUB_ID, pairId: '1/3', depth: 5 },
  });
  expect(stack.snapshot().total).toBe(1);

  await stack.handleMessage(ws, { type: 'market_unsubscribe', id: 'unsub-1' });
  expect(ws.sent.at(-1)).toEqual({ type: 'ack', inReplyTo: 'unsub-1', status: 'market_unsubscribed' });
  expect(stack.snapshot().total).toBe(0);
  stack.clear();
});

test('market subscription stack accepts cross-j venue ids without numeric-pair coercion', async () => {
  const ws = makeSocket('10.0.0.2');
  const stack = createMarketSubscriptionStack<FakeSocket>({
    maxSubscriptions: 2,
    maxSubscriptionsPerIp: 1,
    maxCellsPerSubscription: 4,
    getClientIp: socket => socket.ip,
    fetchSnapshots: (hubEntityId, pairIds, depth) => pairIds.map(pairId => makeSnapshot(hubEntityId, pairId, depth)),
  });
  const venueId = `cross:stack:1:0x${'b'.repeat(40)}:3/stack:2:0x${'c'.repeat(40)}:3`;

  await stack.handleMessage(ws, {
    type: 'market_subscribe',
    id: 'sub-cross',
    hubEntityId: HUB_ID,
    pairs: [venueId],
    depth: 5,
  });

  expect(ws.sent).toHaveLength(2);
  expect(ws.sent[0]).toMatchObject({
    type: 'ack',
    inReplyTo: 'sub-cross',
    status: 'market_subscribed',
    data: { hubEntityIds: [HUB_ID], pairs: [venueId], depth: 5 },
  });
  expect(ws.sent[1]).toMatchObject({
    type: 'market_snapshot',
    payload: { hubEntityId: HUB_ID, pairId: venueId, depth: 5 },
  });
  expect(stack.snapshot().total).toBe(1);
  stack.clear();
});

test('market subscription stack preserves semantic cross-j venue order', async () => {
  const ws = makeSocket('10.0.0.3');
  const stack = createMarketSubscriptionStack<FakeSocket>({
    maxSubscriptions: 2,
    maxSubscriptionsPerIp: 1,
    maxCellsPerSubscription: 4,
    getClientIp: socket => socket.ip,
    fetchSnapshots: (hubEntityId, pairIds, depth) => pairIds.map(pairId => makeSnapshot(hubEntityId, pairId, depth)),
  });
  const venueId = 'cross:tron:2/testnet:1';

  await stack.handleMessage(ws, {
    type: 'market_subscribe',
    id: 'sub-cross-order',
    hubEntityId: HUB_ID,
    pairs: [venueId],
    depth: 5,
  });

  expect(ws.sent[0]).toMatchObject({
    type: 'ack',
    inReplyTo: 'sub-cross-order',
    status: 'market_subscribed',
    data: { pairs: [venueId] },
  });
  expect(ws.sent[1]).toMatchObject({
    type: 'market_snapshot',
    payload: { pairId: venueId },
  });
  stack.clear();
});

test('market subscription stack reports terminal no-market when a valid subscription has no snapshots', async () => {
  const ws = makeSocket('10.0.0.4');
  const stack = createMarketSubscriptionStack<FakeSocket>({
    maxSubscriptions: 2,
    maxSubscriptionsPerIp: 1,
    maxCellsPerSubscription: 4,
    getClientIp: socket => socket.ip,
    fetchSnapshots: () => [],
  });

  await stack.handleMessage(ws, {
    type: 'market_subscribe',
    id: 'sub-empty',
    hubEntityId: HUB_ID,
    pairs: ['1/2'],
    depth: 5,
  });

  expect(ws.sent).toHaveLength(2);
  expect(ws.sent[0]).toMatchObject({
    type: 'ack',
    inReplyTo: 'sub-empty',
    status: 'market_subscribed',
  });
  expect(ws.sent[1]).toEqual({
    type: 'market_status',
    inReplyTo: 'sub-empty',
    status: 'no_market',
    data: { hubEntityIds: [HUB_ID], pairs: ['1/2'], depth: 5 },
  });
  stack.clear();
});

test('market subscription stack rejects overbroad subscriptions', async () => {
  const ws = makeSocket();
  const stack = createMarketSubscriptionStack<FakeSocket>({
    maxSubscriptions: 2,
    maxSubscriptionsPerIp: 2,
    maxCellsPerSubscription: 2,
    getClientIp: socket => socket.ip,
    fetchSnapshots: () => [],
  });

  await stack.handleMessage(ws, {
    type: 'market_subscribe',
    id: 'sub-wide',
    hubEntityIds: [HUB_ID],
    pairs: ['1/2', '1/3', '1/4'],
  });

  expect(ws.sent).toEqual([
    {
      type: 'error',
      inReplyTo: 'sub-wide',
      code: 'E_BAD_QUERY',
      error: 'market subscription too broad: cells=3 max=2',
    },
  ]);
  expect(stack.snapshot().total).toBe(0);
  stack.clear();
});

test('market subscription stack reports snapshot fetch errors instead of leaving subscribers waiting', async () => {
  const ws = makeSocket('10.0.0.3');
  const handlerErrors: unknown[] = [];
  const stack = createMarketSubscriptionStack<FakeSocket>({
    maxSubscriptions: 2,
    maxSubscriptionsPerIp: 1,
    maxCellsPerSubscription: 4,
    getClientIp: socket => socket.ip,
    fetchSnapshots: () => {
      const error = new Error(`Unknown market hub: ${HUB_ID}`) as Error & { code?: string };
      error.code = 'E_UNKNOWN_HUB';
      throw error;
    },
    onHandlerError: error => handlerErrors.push(error),
  });

  await stack.handleMessage(ws, {
    type: 'market_subscribe',
    id: 'sub-unknown-hub',
    hubEntityId: HUB_ID,
    pairs: ['1/2'],
    depth: 5,
  });

  expect(ws.sent).toHaveLength(2);
  expect(ws.sent[0]).toMatchObject({
    type: 'ack',
    inReplyTo: 'sub-unknown-hub',
    status: 'market_subscribed',
  });
  expect(ws.sent[1]).toEqual({
    type: 'error',
    inReplyTo: 'sub-unknown-hub',
    code: 'E_UNKNOWN_HUB',
    error: `Unknown market hub: ${HUB_ID}`,
  });
  expect(handlerErrors).toHaveLength(1);
  expect(stack.snapshot().total).toBe(0);
  stack.clear();
});

test('market subscription publisher removes failing subscribers instead of repeating snapshot errors', async () => {
  const ws = makeSocket('10.0.0.5');
  const handlerErrors: unknown[] = [];
  let fetchCalls = 0;
  const stack = createMarketSubscriptionStack<FakeSocket>({
    maxSubscriptions: 2,
    maxSubscriptionsPerIp: 1,
    maxCellsPerSubscription: 4,
    getClientIp: socket => socket.ip,
    fetchSnapshots: (hubEntityId, pairIds, depth) => {
      fetchCalls += 1;
      if (fetchCalls > 1) {
        const error = new Error('snapshot builder failed') as Error & { code?: string };
        error.code = 'E_SNAPSHOT_FAILED';
        throw error;
      }
      return pairIds.map(pairId => makeSnapshot(hubEntityId, pairId, depth));
    },
    onHandlerError: error => handlerErrors.push(error),
  });

  await stack.handleMessage(ws, {
    type: 'market_subscribe',
    id: 'sub-publisher-fail',
    hubEntityId: HUB_ID,
    pairs: ['1/2'],
    depth: 5,
  });
  expect(stack.snapshot().total).toBe(1);

  await wait(1_150);
  expect(ws.sent.at(-1)).toEqual({
    type: 'error',
    inReplyTo: undefined,
    code: 'E_SNAPSHOT_FAILED',
    error: 'snapshot builder failed',
  });
  expect(handlerErrors).toHaveLength(1);
  expect(stack.snapshot().total).toBe(0);

  const sentAfterCleanup = ws.sent.length;
  const errorsAfterCleanup = handlerErrors.length;
  await wait(1_150);
  expect(ws.sent).toHaveLength(sentAfterCleanup);
  expect(handlerErrors).toHaveLength(errorsAfterCleanup);
  stack.clear();
});
