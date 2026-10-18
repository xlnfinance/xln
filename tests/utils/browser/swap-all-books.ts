import { expect, type Page, type TestInfo } from '../../global-setup.mts';
import { parseUnits } from 'ethers';
import { buildDefaultEntitySwapPairs, getTokenInfo } from '../../../core/account/utils';
import { decodeMarketWireResponse, encodeMarketWireMessage } from '../../../core/network/relay/market/wire';
import type { RelayMarketSnapshotPayload } from '../../../core/network/relay/market/aggregate';
import { safeStringify } from '../../../core/protocol/serialization';
import { readAccount, readOrders } from '../../../ui/tests/swap-evidence';
import { connectBookAccounts } from './swap-book-switch';
import { capturePageScreenshot } from '../e2e-screenshots';

const pairs = buildDefaultEntitySwapPairs().map(pair => ({
  ...pair,
  base: getTokenInfo(pair.baseTokenId),
  quote: getTokenInfo(pair.quoteTokenId),
}));

/** Read the actual relay aggregate on the same market endpoint observed in the browser. */
async function readAggregate(url: string, hubIds: string[]): Promise<RelayMarketSnapshotPayload[]> {
  const request = encodeMarketWireMessage({
    type: 'market_subscribe',
    id: 'all-books-aggregate',
    replace: true,
    hubEntityIds: [...hubIds].sort(),
    pairs: pairs.map(pair => pair.pairId),
    depth: 10,
  });
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const snapshots = new Map<string, RelayMarketSnapshotPayload>();
    const timer = setTimeout(() => fail(new Error('ALL_BOOKS_AGGREGATE_TIMEOUT')), 10_000);
    const fail = (error: unknown) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    };
    socket.onopen = () => socket.send(request);
    socket.onerror = () => fail(new Error('ALL_BOOKS_AGGREGATE_SOCKET_ERROR'));
    socket.onmessage = event => {
      try {
        const message = decodeMarketWireResponse(event.data);
        if (message.type === 'error' || message.type === 'market_status') throw new Error(safeStringify(message));
        if (message.type !== 'market_snapshot') return;
        expect(pairs.map(pair => pair.pairId)).toContain(message.payload.pairId);
        snapshots.set(message.payload.pairId, message.payload);
        if (snapshots.size === pairs.length) {
          clearTimeout(timer);
          socket.close();
          resolve([...snapshots.values()]);
        }
      } catch (error) {
        fail(error);
      }
    };
  });
}

async function selectPair(page: Page, pair: (typeof pairs)[number]): Promise<void> {
  const give = page
    .locator('.field-row')
    .filter({ has: page.getByTestId('swap-give') })
    .getByRole('button');
  const want = page
    .locator('.field-row')
    .filter({ has: page.getByTestId('swap-want') })
    .getByRole('button');
  // The real pickers exclude the opposing token. Flip the current pair first
  // when that is the requested quote; never mutate React or Runtime state.
  if ((await want.innerText()).includes(pair.quote.symbol)) await page.getByTestId('swap-flip').click();
  if (!(await give.innerText()).includes(pair.quote.symbol)) {
    await give.click();
    await page.getByRole('option', { name: new RegExp(pair.quote.symbol) }).click();
  }
  if (!(await want.innerText()).includes(pair.base.symbol)) {
    await want.click();
    await page.getByRole('option', { name: new RegExp(pair.base.symbol) }).click();
  }
  await expect(give).toContainText(pair.quote.symbol);
  await expect(want).toContainText(pair.base.symbol);
}

export async function verifyAllBooks(page: Page, info: TestInfo): Promise<void> {
  const hubs = await connectBookAccounts(page);
  const before = await Promise.all(hubs.map(hub => readAccount(page, hub.id)));
  const snapshots = new Map<string, RelayMarketSnapshotPayload>();
  let relayUrl = '';
  page.on('websocket', socket => {
    if (new URL(socket.url()).searchParams.get('protocol') !== 'market') return;
    relayUrl = socket.url();
    socket.on('framereceived', frame => {
      const message = decodeMarketWireResponse(frame.payload);
      if (message.type !== 'market_snapshot') return;
      if (message.payload.sources.length !== 1) throw new Error('SELECTED_BOOK_HAS_MULTIPLE_SOURCES');
      const [source] = message.payload.sources;
      if (!source) throw new Error('SELECTED_BOOK_SOURCE_MISSING');
      snapshots.set(`${source.hubEntityId}:${message.payload.pairId}`, message.payload);
    });
  });
  await page.getByTestId('home-swap').click();
  const book = page.getByTestId('orderbook').locator('visible=true').first();
  const observed = [];
  for (const hub of hubs) {
    await page.getByRole('button', { name: hub.name, exact: true }).click();
    for (const pair of pairs) {
      await selectPair(page, pair);
      await expect(book.locator('.bk-head .caps')).toHaveText(`${pair.base.symbol}/${pair.quote.symbol} · ${hub.name}`);
      await expect(book).toHaveAttribute('data-status', 'live');
      const snapshot = snapshots.get(`${hub.id}:${pair.pairId}`);
      if (!snapshot) throw new Error(`CURRENT_BOOK_SNAPSHOT_MISSING:${hub.id}:${pair.pairId}`);
      expect(snapshot.sourceCount).toBe(1);
      expect(snapshot.sources.map(source => source.hubEntityId)).toEqual([hub.id]);
      for (const side of ['ask', 'bid'] as const) {
        const rows = book.getByTestId(`book-row-${side}`);
        await expect(rows).toHaveCount(10);
        const prices = (await rows.locator('.bk-price').allInnerTexts()).map(text =>
          parseUnits(text.replaceAll(',', ''), 4).toString(),
        );
        const levels = side === 'ask' ? snapshot.asks : snapshot.bids;
        expect(levels).toHaveLength(10);
        expect(prices).toEqual((side === 'ask' ? [...levels].reverse() : levels).map(level => level.price));
        for (const size of await rows.locator('.bk-size').allInnerTexts())
          expect(parseUnits(size.replaceAll(',', ''), 4)).toBeGreaterThan(0n);
      }
      observed.push({ hub, pairId: pair.pairId, snapshot });
    }
  }
  expect(observed).toHaveLength(hubs.length * pairs.length);
  if (!relayUrl) throw new Error('BROWSER_MARKET_ENDPOINT_NOT_OBSERVED');
  const aggregate = await readAggregate(
    relayUrl,
    hubs.map(hub => hub.id),
  );
  expect(aggregate).toHaveLength(pairs.length);
  for (const snapshot of aggregate) {
    expect(snapshot.sourceCount).toBe(hubs.length);
    expect(snapshot.sources.map(source => source.hubEntityId).sort()).toEqual(hubs.map(hub => hub.id).sort());
    expect(snapshot.asks).toHaveLength(10);
    expect(snapshot.bids).toHaveLength(10);
    const sources = new Set([...snapshot.asks, ...snapshot.bids].flatMap(level => level.sourceHubEntityIds ?? []));
    expect([...sources].sort()).toEqual(hubs.map(hub => hub.id).sort());
  }
  expect(await Promise.all(hubs.map(hub => readAccount(page, hub.id)))).toEqual(before);
  for (const hub of hubs) expect((await readOrders(page, hub.id)).items).toHaveLength(0);
  await capturePageScreenshot(page, info, 'all-pairs-selected-depth.png', { fullPage: false });
  await info.attach('all-current-books', {
    body: safeStringify({ hubs, pairs, before, observed, aggregate }),
    contentType: 'application/json',
  });
}
