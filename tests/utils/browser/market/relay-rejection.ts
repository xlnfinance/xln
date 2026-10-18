import WebSocket from 'ws';
import { expect, type Page, type TestInfo } from '../../../global-setup.mts';
import { API_BASE_URL } from '../../e2e-baseline';
import { requireOwnedRelay } from './relay-silence';
import { readAccount, readOrders, expectDeliveryDrained } from '../../../../ui/tests/swap-evidence';
import { decodeMarketWireResponse, encodeMarketWireMessage } from '../../../../core/network/relay/market/wire';
import { safeStringify } from '../../../../core/protocol/serialization';

async function subscriptionLimit(page: Page) {
  const response = await page.request.get(`${API_BASE_URL}/api/health`, { timeout: 3000 });
  expect(response.ok()).toBe(true);
  const health: unknown = await response.json();
  if (!health || typeof health !== 'object' || !('relay' in health)) throw new Error('RELAY_HEALTH_MISSING');
  const relay = health.relay;
  if (!relay || typeof relay !== 'object' || !('marketSubscriptions' in relay)) throw new Error('RELAY_LIMIT_MISSING');
  const limit = relay.marketSubscriptions;
  if (!limit || typeof limit !== 'object' || !('maxPerIp' in limit) || !('total' in limit))
    throw new Error('RELAY_LIMIT_INVALID');
  if (typeof limit.maxPerIp !== 'number' || typeof limit.total !== 'number') throw new Error('RELAY_LIMIT_INVALID');
  // This real stand uses the production default; never lower its admission limit for the test.
  expect(limit.maxPerIp).toBe(8);
  return { maxPerIp: limit.maxPerIp, total: limit.total };
}

function subscribe(socket: WebSocket, hubId: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`REAL_MARKET_SUBSCRIPTION_TIMEOUT:${id}`)), 3000);
    const fail = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    socket.once('error', fail);
    socket.once('close', () => fail(new Error(`REAL_MARKET_SUBSCRIPTION_CLOSED:${id}`)));
    socket.once('open', () => {
      socket.send(
        encodeMarketWireMessage({ type: 'market_subscribe', id, hubEntityIds: [hubId], pairs: ['1/2'], depth: 20 }),
      );
    });
    socket.on('message', (bytes, isBinary) => {
      // The shared relay also publishes binary Runtime envelopes; market wire is text.
      if (isBinary) return;
      try {
        const message = decodeMarketWireResponse(bytes.toString());
        if (message.type === 'error') {
          fail(new Error(message.error));
          return;
        }
        if (message.type === 'ack' && message.inReplyTo === id && message.status === 'market_subscribed') {
          clearTimeout(timeout);
          resolve();
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** Exercise actual local relay admission, preserving the wallet's signed Account and orders. */
export async function verifyRelayRejection(page: Page, info: TestInfo): Promise<void> {
  const owner = await requireOwnedRelay(page);
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('RELAY_ACCOUNT_MISSING');
  await page.getByTestId('back').click();
  await expectDeliveryDrained(page, expect);
  const before = await readAccount(page, hubId);
  const orders = await readOrders(page, hubId);
  const limit = await subscriptionLimit(page);
  expect(limit.total).toBe(0);
  const url = new URL('/relay', API_BASE_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const sockets: WebSocket[] = [];
  try {
    for (let index = 0; index < limit.maxPerIp; index += 1) {
      const socket = new WebSocket(url);
      sockets.push(socket);
      await subscribe(socket, hubId, `real_capacity_${index}`);
    }
    expect((await subscriptionLimit(page)).total).toBe(limit.maxPerIp);
    const rejected = page
      .waitForEvent('websocket', { predicate: socket => new URL(socket.url()).pathname === '/relay' })
      .then(socket =>
        socket.waitForEvent('framereceived', {
          predicate: frame => frame.payload.toString().includes('E_RATE_LIMITED'),
        }),
      );
    await page.getByTestId('home-swap').click();
    const message = decodeMarketWireResponse((await rejected).payload.toString());
    if (message.type !== 'error') throw new Error('EXPECTED_REAL_RELAY_REJECTION');
    expect(message.code).toBe('E_RATE_LIMITED');
    expect(message.inReplyTo).toMatch(/^market_sub_/);
    expect(message.error).toBe(`market subscription IP capacity exceeded: max=${limit.maxPerIp}`);
    const book = page.getByTestId('orderbook').locator('visible=true').first();
    await expect(book).toBeVisible();
    await expect(book).toHaveAttribute('data-status', 'unavailable');
    await expect(book).toContainText(message.error);
    await expect(book).not.toHaveAttribute('data-status', 'syncing');
    await expect(book).not.toHaveAttribute('data-status', 'no-market');
    await expect(book.getByTestId('book-row-ask')).toHaveCount(0);
    await expect(book.getByTestId('book-row-bid')).toHaveCount(0);
    expect((await subscriptionLimit(page)).total).toBe(limit.maxPerIp);
    expect(await readAccount(page, hubId)).toEqual(before);
    expect(await readOrders(page, hubId)).toEqual(orders);
    await info.attach('real-relay-rejection', {
      body: safeStringify({ owner, limit, message, before, orders }),
      contentType: 'application/json',
    });
    await page.screenshot({ path: info.outputPath('relay-rejected.png') });
  } finally {
    for (const socket of sockets) socket.close();
  }
  await expect.poll(async () => (await subscriptionLimit(page)).total).toBe(0);
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.getByTestId('home-swap').click();
  const book = page.getByTestId('orderbook').locator('visible=true').first();
  await expect(book).toHaveAttribute('data-status', 'live');
  await expect(book.getByTestId('book-row-ask')).toHaveCount(10);
  await expect(book.getByTestId('book-row-bid')).toHaveCount(10);
  expect(await requireOwnedRelay(page)).toEqual(owner);
  expect(await readAccount(page, hubId)).toEqual(before);
  expect(await readOrders(page, hubId)).toEqual(orders);
  await info.attach('real-relay-capacity-recovered', {
    body: safeStringify({ owner, account: await readAccount(page, hubId), orders: await readOrders(page, hubId) }),
    contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath('relay-capacity-recovered.png') });
}
