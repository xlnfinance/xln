/**
 * A limit order away from the market rests on the hub Account: it holds the
 * exact give amount, shows as one open order, and a UI cancel closes it and
 * releases that hold to the unit. The book is also a ticket: a tapped level
 * fills give/want at that level's price, and Flip turns the pair around.
 */
import { expect, test, type Page } from '@playwright/test';
import { parseUnits } from 'ethers';
import { safeStringify } from '../../core/protocol/serialization';
import { enterStack } from './stack';
import { readAccount, readOrders } from './swap-evidence';

const USDC = 1;
const PRICE_SCALE = 10_000n;
// 10 USDC for 0.005 WETH is a bid at exactly 2,000.0000 USDC per WETH: below
// the stack book, but inside the hub's +/-30% band around its midpoint, which
// zero-fill cancels anything farther away (outside-anchor-band).
const REST = {
  give: '10',
  want: '0.005',
  giveUnits: 10_000_000n,
  wantUnits: 5_000_000_000_000_000n,
  priceText: '2,000.0000',
};
const BAND_BPS = 3_000n;

const visibleBook = (page: Page) => page.getByTestId('orderbook').locator('visible=true').first();
const priceTicks = (text: string): bigint => parseUnits(text.replaceAll(',', ''), 4);
const limitPrice = (page: Page) => page.locator('.kv').filter({ hasText: 'Limit price' }).locator('.v');
const pill = (page: Page, input: 'swap-give' | 'swap-want') =>
  page.locator('.field-row', { has: page.getByTestId(input) }).locator('button.pill');

async function fundAndReadHub(page: Page): Promise<string> {
  const funding = page.waitForResponse(
    response => new URL(response.url()).pathname === '/api/faucet/offchain' && response.request().method() === 'POST',
  );
  await page.getByTestId('home-faucet').click();
  const response = await funding;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('Expected the fresh wallet hub Account');
  await expect.poll(async () => (await readAccount(page, hubId)).usdc, { timeout: 15_000 }).toBe('100000000');
  await page.getByTestId('back').click();
  return hubId;
}

const settled = async (page: Page, hubId: string) => {
  const account = await readAccount(page, hubId);
  return { pending: account.pending, mempool: account.mempool };
};

const usdcHold = async (page: Page, hubId: string) =>
  (await readAccount(page, hubId)).holds.find(hold => hold.tokenId === USDC)?.outgoing;

test(
  'resting limit order holds exact USDC, shows open, and cancel releases the hold',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(60_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await enterStack(page);
    const hubId = await fundAndReadHub(page);
    const capacity = page.getByTestId('home-send-capacity');
    const pendingHold = page.locator('.wallet-pending');
    await expect(capacity).toHaveText('Payment capacity: 100 USDC · includes available credit');
    await expect(pendingHold).toHaveCount(0);

    await page.getByTestId('home-swap').click();
    const book = visibleBook(page);
    await expect(book).toHaveAttribute('data-status', 'live', { timeout: 15_000 });
    const bestBid = book.getByTestId('book-row-bid').first();
    await expect(bestBid).toBeVisible();
    const bestBidTicks = priceTicks(await bestBid.locator('.bk-price').innerText());
    const bestAskTicks = priceTicks(await book.getByTestId('book-row-ask').last().locator('.bk-price').innerText());
    const mid = (bestBidTicks + bestAskTicks) / 2n;
    // A bid below the best bid cannot cross any ask, so it must rest.
    expect(bestBidTicks, 'stack book must bid above the resting test price').toBeGreaterThan(
      priceTicks(REST.priceText),
    );
    expect(
      mid - (mid * BAND_BPS) / 10_000n,
      'resting test price must sit inside the hub price band',
    ).toBeLessThanOrEqual(priceTicks(REST.priceText));

    await page.getByTestId('swap-give').fill(REST.give);
    await page.getByTestId('swap-want').fill(REST.want);
    await expect(limitPrice(page)).toHaveText(`${REST.priceText} USDC per WETH`);
    const spectrum = page.getByTestId('receive-spectrum');
    const submit = page.getByTestId('swap-submit');
    await expect(spectrum).toBeVisible();
    await spectrum.getByRole('button', { name: 'Accept it as credit instead', exact: true }).click();
    await expect(page.getByTestId('receive-spectrum-confirm')).toHaveText('Extend credit limit');
    await page.getByTestId('receive-spectrum-confirm').click();
    await expect(spectrum).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => settled(page, hubId), { timeout: 15_000 }).toEqual({ pending: false, mempool: 0 });
    const prepared = await readAccount(page, hubId);
    expect(prepared.offers).toBe(0);
    expect(prepared.usdc).toBe('100000000');
    await expect(submit).toHaveText('Swap USDC for WETH');
    await expect(submit).toBeEnabled();
    await submit.click();

    const cancel = page.getByTestId('swap-offer-cancel');
    const openRow = page.locator('div.row', { has: cancel });
    await expect(openRow).toHaveCount(1, { timeout: 15_000 });
    await expect(openRow.locator('.t')).toHaveText('10.0000 USDC for 0.0050 WETH');
    await expect(openRow.locator('.state')).toHaveText('open');
    await expect.poll(() => settled(page, hubId), { timeout: 15_000 }).toEqual({ pending: false, mempool: 0 });
    const resting = await readAccount(page, hubId);
    expect(resting.offers).toBe(1);
    expect(resting.usdc).toBe(prepared.usdc);
    expect(resting.weth).toBe('0');
    expect(await usdcHold(page, hubId)).toBe(REST.giveUnits.toString());
    expect(BigInt(prepared.usdcSpendable) - BigInt(resting.usdcSpendable)).toBe(REST.giveUnits);
    const open = await readOrders(page, hubId);
    expect(open.items).toHaveLength(1);
    const order = open.items[0]!;
    expect({
      give: order.originalGiveAmount,
      want: order.originalWantAmount,
      closed: order.closed,
      fills: order.resolves.length,
    }).toEqual({ give: REST.giveUnits, want: REST.wantUnits, closed: false, fills: 0 });
    // The order now rests in the hub book at its own price level.
    const own = book.locator('[data-testid="book-row-bid"].own');
    await expect(own).toHaveCount(1);
    await expect(own.locator('.bk-price')).toHaveText(REST.priceText);

    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await expect(pendingHold).toHaveText('10 USDC pending · View activity');
    await expect(capacity).toHaveText('Payment capacity: 90 USDC · includes available credit');

    await page.getByTestId('home-swap').click();
    await expect(openRow).toHaveCount(1);
    await cancel.click();
    await expect(openRow).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await readAccount(page, hubId)).offers, { timeout: 15_000 }).toBe(0);
    await expect.poll(() => settled(page, hubId), { timeout: 15_000 }).toEqual({ pending: false, mempool: 0 });
    const cancelled = await readAccount(page, hubId);
    expect(cancelled.usdc).toBe(prepared.usdc);
    expect(cancelled.weth).toBe('0');
    expect(cancelled.usdcSpendable).toBe(prepared.usdcSpendable);
    expect(cancelled.holds.every(hold => hold.outgoing === '0' && hold.incoming === '0')).toBe(true);
    await expect(visibleBook(page).locator('[data-testid="book-row-bid"].own')).toHaveCount(0);
    const closed = await readOrders(page, hubId);
    expect(closed.items).toHaveLength(1);
    const terminal = closed.items[0]!;
    expect(terminal.offerId).toBe(order.offerId);
    expect(terminal.closed).toBe(true);
    expect(terminal.resolves).toHaveLength(1);
    expect(terminal.resolves[0]!.cancelRemainder).toBe(true);

    await page.getByTestId('nav-activity').first().click();
    await page.getByRole('button', { name: 'Swaps', exact: true }).click();
    const history = page.getByTestId('swap-history-order');
    await expect(history).toHaveCount(1);
    await expect(history.locator('summary')).toHaveText('USDC → WETH · Closed · 1 executions');
    await history.locator('summary').click();
    await expect(history.locator('.caps')).toHaveText(
      `Account frame #${terminal.resolves[0]!.height} · Remainder cancelled`,
    );
    await expect(history.locator('.kv').filter({ hasText: 'Requested' }).locator('.v')).toHaveText(
      '10.000000 USDC → 0.005000000000000000 WETH',
    );

    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await expect(pendingHold).toHaveCount(0);
    await expect(capacity).toHaveText('Payment capacity: 100 USDC · includes available credit');
    expect(pageErrors).toEqual([]);
    await test.info().attach('limit-order-lifecycle', {
      body: safeStringify({ hubId, prepared, resting, open, cancelled, closed }, 2),
      contentType: 'application/json',
    });
  },
);

test(
  'book level fills the ticket at its price and Flip reverses the pair',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(60_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    // An unfunded wallet has no spend cap, so the ticket takes the full level.
    await enterStack(page);
    await page.getByTestId('home-swap').click();
    const book = visibleBook(page);
    await expect(book).toHaveAttribute('data-status', 'live', { timeout: 15_000 });
    await expect(book.locator('.bk-head .caps')).toContainText('WETH/USDC');
    const bestAsk = book.getByTestId('book-row-ask').last();
    await expect(bestAsk).toBeVisible();
    const askPrice = await bestAsk.locator('.bk-price').innerText();
    const askSize = await bestAsk.locator('.bk-size').innerText();
    await bestAsk.click();

    const give = page.getByTestId('swap-give');
    const want = page.getByTestId('swap-want');
    await expect(pill(page, 'swap-give')).toContainText('USDC');
    await expect(pill(page, 'swap-want')).toContainText('WETH');
    await expect(limitPrice(page)).toHaveText(`${askPrice} USDC per WETH`);
    const giveText = await give.inputValue();
    const wantText = await want.inputValue();
    const giveUnits = parseUnits(giveText, 6);
    const wantUnits = parseUnits(wantText, 18);
    // Taking an ask buys its whole size: we receive the level's base size and pay
    // its quote cost at the level price.
    expect(wantUnits).toBeGreaterThan(0n);
    expect(giveUnits).toBe((wantUnits * priceTicks(askPrice) * 10n ** 6n) / (PRICE_SCALE * 10n ** 18n));
    const sizeAtFour = (wantUnits + 5n * 10n ** 13n) / 10n ** 14n;
    expect(askSize).toBe(
      `${(sizeAtFour / 10_000n).toLocaleString('en-US')}.${(sizeAtFour % 10_000n).toString().padStart(4, '0')}`,
    );
    await expect(page.getByTestId('swap-submit')).toHaveText('Swap USDC for WETH');

    await page.getByTestId('swap-flip').click();
    await expect(pill(page, 'swap-give')).toContainText('WETH');
    await expect(pill(page, 'swap-want')).toContainText('USDC');
    await expect(give).toHaveValue(wantText);
    await expect(want).toHaveValue(giveText);
    await expect(limitPrice(page)).toHaveText(`${askPrice} USDC per WETH`);
    await expect(page.getByTestId('swap-submit')).toHaveText('Swap WETH for USDC');
    await expect(book.locator('.bk-head .caps')).toContainText('WETH/USDC');

    await page.getByTestId('swap-flip').click();
    await expect(pill(page, 'swap-give')).toContainText('USDC');
    await expect(give).toHaveValue(giveText);
    await expect(want).toHaveValue(wantText);
    await expect(page.getByTestId('swap-submit')).toHaveText('Swap USDC for WETH');
    expect(pageErrors).toEqual([]);
  },
);
