import { expect, type Page, type TestInfo } from '../../global-setup.mts';
import { getHealth } from '../e2e-baseline';
import type { RuntimeAdapterViewFrame } from '../../../core/api/public/runtime-module';
import { type DebugWindow, readAccount, readOrders } from '../../../ui/tests/swap-evidence';
import { capturePageScreenshot } from '../e2e-screenshots';
import { safeStringify } from '../../../core/protocol/serialization';

type BookObservation = { header: string; status: string; rows: string[] };
type ObservedWindow = Window & { __bookSwitchObservation?: { records: BookObservation[]; observer: MutationObserver } };

async function observeSwitch(page: Page, info: TestInfo, header: string, action: () => Promise<void>): Promise<void> {
  await page.evaluate(() => {
    const book = document.querySelector('[data-testid="orderbook"]');
    if (!book) throw new Error('BOOK_OBSERVATION_TARGET_MISSING');
    const records: BookObservation[] = [];
    const capture = () =>
      records.push({
        header: book.querySelector('.bk-head .caps')?.textContent?.trim() ?? '',
        status: book.getAttribute('data-status') ?? '',
        rows: [...book.querySelectorAll('.bk-price')].map(row => row.textContent?.trim() ?? ''),
      });
    const observer = new MutationObserver(capture);
    observer.observe(book, { childList: true, subtree: true, attributes: true, characterData: true });
    (window as ObservedWindow).__bookSwitchObservation = { records, observer };
    capture();
  });
  await action();
  const book = page.getByTestId('orderbook').locator('visible=true').first();
  await expect(book.locator('.bk-head .caps')).toHaveText(header);
  await expect(book).toHaveAttribute('data-status', 'live');
  await expect(book.getByTestId('book-row-ask').last()).toBeVisible();
  const records = await page.evaluate(() => {
    const observation = (window as ObservedWindow).__bookSwitchObservation;
    if (!observation) throw new Error('BOOK_OBSERVATION_MISSING');
    observation.observer.disconnect();
    return observation.records;
  });
  await info.attach(`book-switch-${header}`, { body: safeStringify(records), contentType: 'application/json' });
  const loading = records.filter(row => row.header === header && row.status === 'syncing');
  expect(loading.length, 'observe the real new market subscription before its reply').toBeGreaterThan(0);
  expect(
    loading.filter(row => row.rows.length > 0),
    'a new market must not display the previous market rows',
  ).toEqual([]);
}

export async function verifyBookSwitching(page: Page, info: TestInfo): Promise<void> {
  const health = await getHealth(page);
  const hubs = ['H1', 'H2', 'H3'].map(name => {
    const id = health?.hubs?.find(hub => hub.name === name && hub.online)?.entityId;
    if (!id || !/^0x[0-9a-f]{64}$/.test(id)) throw new Error(`BOOK_HUB_UNAVAILABLE:${name}`);
    return { name, id };
  });
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  for (const [index, hub] of hubs.slice(1).entries()) {
    await page.getByRole('button', { name: 'Connect another account', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Open account', exact: true });
    await sheet.getByPlaceholder('or paste an entity id, 0x…').fill(hub.id);
    await sheet.getByPlaceholder('0.00').fill('50');
    await sheet.getByRole('button', { name: 'Propose account', exact: true }).click();
    await expect(page.getByTestId('account-row')).toHaveCount(index + 2);
  }
  for (const hub of hubs) {
    await expect
      .poll(async () => {
        return page.evaluate(async counterpartyId => {
          const debug = (window as DebugWindow).__xln;
          const adapter = debug?.adapter();
          const entityId = debug?.store.getState().activeEntityId;
          if (!adapter || !entityId) throw new Error('Wallet Account owner unavailable');
          const account = await adapter.read<
            NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number]
          >(`entity/${entityId}/account/${counterpartyId}`);
          return {
            usdc: account.state.deltas.has(1),
            pending: Boolean(account.pendingFrame),
            mempool: account.mempoolCount,
          };
        }, hub.id);
      })
      .toEqual({ usdc: true, pending: false, mempool: 0 });
  }
  const before = await Promise.all(hubs.map(hub => readAccount(page, hub.id)));
  await page.getByTestId('home-swap').click();
  const book = page.getByTestId('orderbook').locator('visible=true').first();
  await expect(book.locator('.bk-head .caps')).toHaveText('WETH/USDC · H1');
  await expect(book).toHaveAttribute('data-status', 'live');
  await book.getByTestId('book-row-ask').last().click();
  await expect(page.getByTestId('swap-want')).not.toHaveValue('');
  for (const hub of hubs.slice(1)) {
    await observeSwitch(page, info, `WETH/USDC · ${hub.name}`, () =>
      page.getByRole('button', { name: hub.name, exact: true }).click(),
    );
  }
  const picker = page
    .locator('.field-row')
    .filter({ has: page.getByTestId('swap-want') })
    .getByRole('button');
  await picker.click();
  await observeSwitch(page, info, 'USDC/USDT · H3', () => page.getByRole('option', { name: /USDT/ }).click());
  await capturePageScreenshot(page, info, 'swap-selected-book-after-pair-switch.png', { fullPage: false });
  expect(await Promise.all(hubs.map(hub => readAccount(page, hub.id)))).toEqual(before);
  for (const hub of hubs) expect((await readOrders(page, hub.id)).items).toHaveLength(0);
  await info.attach('book-switch-accounts', {
    body: safeStringify({ hubs, before, after: await Promise.all(hubs.map(hub => readAccount(page, hub.id))) }),
    contentType: 'application/json',
  });
}
