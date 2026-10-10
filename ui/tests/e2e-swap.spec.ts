import { expect, test } from '@playwright/test';
import { formatUnits, parseUnits } from 'ethers';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { deriveSwapFillPolicyFee } from '../../core/account/swap/swap-net-authorization';
import { safeParse, safeStringify } from '../../core/protocol/serialization';
import type { RuntimeAdapterSwapHistoryPage } from '../../core/api/runtime-adapter/types';
import { expectDollarScale } from './balance-scale';
import { enterStack, reopenStack, type StackWallet } from './stack';

import { readAccount, readOrders, type DebugWindow } from './swap-evidence';

const directory = process.env['XLN_SWAP_E2E_DIR'] ?? '/tmp/xln-swap-e2e';

test(
  'same-network swap confirms exact amounts and fee once before reload',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(60_000);
    const started = Date.now();
    const pageErrors: string[] = [];
    const authErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      console.log(`BROWSER_${message.type()}: ${message.text().slice(0, 500)}`);
      if (/MAC.*(?:INVALID|FAIL|MISMATCH)|(?:INVALID|FAIL|MISMATCH).*MAC|WS_MESSAGE_AUTH/i.test(message.text()))
        authErrors.push(message.text());
    });
    const wallet = await enterStack(page);
    console.log('SWAP_HOME_MS', Date.now() - started);
    const fundingResponse = page.waitForResponse(
      response => new URL(response.url()).pathname === '/api/faucet/offchain' && response.request().method() === 'POST',
    );
    await Promise.all([
      page.getByTestId('home-faucet').click(),
      fundingResponse.then(async funding => expect(funding.ok(), await funding.text()).toBe(true)),
    ]);
    await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
    await page.getByTestId('account-row').first().click();
    const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
    if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('Expected the fresh wallet hub Account');
    await expect.poll(async () => (await readAccount(page, hubId)).usdc, { timeout: 15_000 }).toBe('100000000');
    const before = await readAccount(page, hubId);
    expect(before.weth).toBe('0');
    expect(before.wethCredit).toBe('0');
    expect(before.wethCapacity).toBe('0');
    await page.getByTestId('back').click();
    await page.getByTestId('home-swap').click();
    const book = page.getByTestId('orderbook').locator('visible=true').first();
    await expect(book).toHaveAttribute('data-status', 'live', { timeout: 15_000 });
    const bestAsk = book.locator('.bk-row.ask').last();
    await expect(bestAsk).toBeVisible();
    await bestAsk.click();
    const feeRow = page.locator('.kv').filter({ hasText: 'Hub fee' });
    await expect(feeRow).toContainText('bps');
    const feeMatch = (await feeRow.innerText()).match(/(\d+) bps/);
    if (!feeMatch?.[1]) throw new Error('Published swap fee unavailable');
    const ticket = {
      give: parseUnits(await page.getByTestId('swap-give').inputValue(), 6).toString(),
      want: parseUnits(await page.getByTestId('swap-want').inputValue(), 18).toString(),
      feeBps: Number(feeMatch[1]),
    };
    const quote = await page.evaluate(async amounts => {
      const debug = (window as DebugWindow).__xln;
      if (!debug) throw new Error('Wallet diagnostics unavailable');
      const xln = await debug.xln();
      const prepared = xln.prepareSwapOrder(1, 2, BigInt(amounts.give), BigInt(amounts.want));
      const authorization = xln.deriveSwapNetAuthorization(prepared.effectiveWant, amounts.feeBps);
      return {
        give: prepared.effectiveGive.toString(),
        want: prepared.effectiveWant.toString(),
        minNet: authorization.minNetReceive.toString(),
      };
    }, ticket);
    expect(BigInt(quote.give)).toBeGreaterThan(0n);
    expect(BigInt(quote.give)).toBeLessThanOrEqual(BigInt(before.usdc));
    expect(BigInt(quote.want)).toBeGreaterThan(0n);
    const submit = page.getByTestId('swap-submit');
    await expect(page.getByText(/Placing this order also prepares incoming capacity/)).toBeVisible();
    await expect(submit).toBeEnabled();
    const preparedAccount = await readAccount(page, hubId);
    // Preview and invalid edits must not silently grant credit. The one Swap
    // action uses the canonical planner to prepare exactly the required limit.
    expect(preparedAccount.wethCredit).toBe('0');
    expect(preparedAccount.wethCapacity).toBe('0');
    expect(preparedAccount.usdc).toBe(before.usdc);
    expect(preparedAccount.weth).toBe(before.weth);
    expect(preparedAccount.offers).toBe(0);
    await expect
      .poll(
        async () => {
          const account = await readAccount(page, hubId);
          return { pending: account.pending, mempool: account.mempool };
        },
        { timeout: 15_000 },
      )
      .toEqual({ pending: false, mempool: 0 });
    const giveInput = page.getByTestId('swap-give');
    const validGive = await giveInput.inputValue();
    const overCapacity = formatUnits(BigInt(preparedAccount.usdcSpendable) + 1_000_000n, 6);
    for (const invalidGive of ['0', 'invalid', overCapacity]) {
      await giveInput.fill(invalidGive);
      await expect(submit).toBeDisabled();
      if (invalidGive === overCapacity)
        await expect(page.getByText('Exceeds what you can send', { exact: true })).toBeVisible();
      const rejected = await readAccount(page, hubId);
      expect(rejected.usdc).toBe(preparedAccount.usdc);
      expect(rejected.weth).toBe(preparedAccount.weth);
      expect(rejected.wethCredit).toBe(preparedAccount.wethCredit);
      expect(rejected.offers).toBe(0);
      expect(rejected.pending).toBe(false);
      expect(rejected.mempool).toBe(0);
    }
    await giveInput.fill(validGive);
    await expect(submit).toBeEnabled();
    await submit.dblclick();
    await expect
      .poll(async () => BigInt((await readAccount(page, hubId)).weth), { timeout: 15_000 })
      .toBeGreaterThan(0n);
    await expect
      .poll(
        async () => {
          const account = await readAccount(page, hubId);
          return { pending: account.pending, mempool: account.mempool, offers: account.offers };
        },
        { timeout: 15_000 },
      )
      .toEqual({ pending: false, mempool: 0, offers: 0 });
    const after = await readAccount(page, hubId);
    expect(after.height).toBeGreaterThan(preparedAccount.height);
    expect(after.root).not.toBe(preparedAccount.root);
    const debit = BigInt(before.usdc) - BigInt(after.usdc);
    const received = BigInt(after.weth) - BigInt(before.weth);
    expect(debit).toBeGreaterThan(0n);
    expect(debit).toBeLessThanOrEqual(BigInt(quote.give));
    expect(received).toBeGreaterThanOrEqual(BigInt(quote.minNet));
    expect(after.wethCredit).toBe(quote.want);
    expect(after.holds.every(hold => hold.outgoing === '0' && hold.incoming === '0')).toBe(true);
    console.log(
      `SWAP_COMMITTED accountHeight=${after.height} usdcDebit=${debit} wethReceived=${received} permanentWethCredit=${after.wethCredit} root=${after.root}`,
    );
    await page.getByTestId('nav-activity').first().click();
    await page.getByRole('button', { name: 'Swaps', exact: true }).click();
    const history = page.getByTestId('swap-history-order');
    await expect(history).toHaveCount(1);
    await history.locator('summary').click();
    await expect(history).not.toContainText('Not recorded');
    await expect(history.locator('[data-field="gave"]')).toHaveAttribute('data-amount', debit.toString());
    const gross = BigInt((await history.locator('[data-field="received"]').getAttribute('data-amount')) ?? '-1');
    const fee = BigInt((await history.locator('[data-field="fee"]').getAttribute('data-amount')) ?? '0');
    expect(gross - fee).toBe(received);
    const orders = await readOrders(page, hubId);
    expect(orders.nextCursor).toBeNull();
    expect(orders.items).toHaveLength(1);
    const order = orders.items[0]!;
    expect(order.closed).toBe(true);
    expect(order.cancelRequested).toBe(false);
    expect(order.resolves).toHaveLength(1);
    const fill = order.resolves[0]!;
    expect(fill.executionGiveAmount).toBe(debit);
    expect(fill.executionWantAmount).toBe(gross);
    expect(fill.feeTokenId).toBe(2);
    expect(fill.feeAmount).toBe(fee);
    expect(fee).toBe(
      deriveSwapFillPolicyFee(
        { giveAmount: order.originalGiveAmount, wantAmount: order.originalWantAmount },
        debit,
        gross,
        ticket.feeBps,
        fill.cancelRemainder,
      ),
    );
    console.log('SWAP_HISTORY_MS', Date.now() - started, 'fee', String(fee));
    await page.getByTestId('nav-home').first().click();
    await expect(page.getByTestId('home-balance-asset')).toHaveValue('0');
    await page.getByTestId('home-balance-asset').selectOption('1');
    const headlineUnits = async (decimals: number) => parseUnits(
      (await page.getByTestId('home-total').innerText()).replaceAll(',', '').replace('−', '-'), decimals,
    ).toString();
    await expect.poll(() => headlineUnits(6)).toBe(after.usdc);
    await page.getByTestId('home-balance-asset').selectOption('2');
    await expect.poll(() => headlineUnits(18)).toBe(after.weth);
    await expect(page.getByTestId('home-send-capacity')).toContainText('WETH');
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: `${directory}/exact-weth-balance.png`, fullPage: true, animations: 'disabled' });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
    expect(pageErrors).toEqual([]);
    expect(authErrors).toEqual([]);
    const evidence = {
      runtimeId: wallet.runtimeId,
      entityId: wallet.entityId,
      hubId,
      ticket,
      quote,
      before,
      after,
      debit,
      gross,
      fee,
      received,
      orders,
      elapsedMs: Date.now() - started,
    };
    await mkdir(directory, { recursive: true });
    await page.context().storageState({ path: `${directory}/storage.json`, indexedDB: true });
    await writeFile(`${directory}/wallet.json`, JSON.stringify(wallet));
    await writeFile(`${directory}/swapped.json`, safeStringify(evidence));
    console.log('SWAP_RELOADED_TO_LOCKED_WALLET_MS', evidence.elapsedMs);
  },
);

test(
  'unlock after swap reload preserves exact balances and one terminal history record',
  { tag: '@functional' },
  async ({ browser, baseURL }) => {
    test.setTimeout(55_000);
    const wallet = JSON.parse(await readFile(`${directory}/wallet.json`, 'utf8')) as StackWallet;
    const evidence = safeParse(await readFile(`${directory}/swapped.json`, 'utf8')) as {
      hubId: string;
      after: Awaited<ReturnType<typeof readAccount>>;
      orders: RuntimeAdapterSwapHistoryPage;
      debit: bigint;
      gross: bigint;
      fee: bigint;
    };
    const context = await browser.newContext({ baseURL, storageState: `${directory}/storage.json` });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (/MAC.*(?:INVALID|FAIL|MISMATCH)|(?:INVALID|FAIL|MISMATCH).*MAC|WS_MESSAGE_AUTH/i.test(message.text()))
        errors.push(message.text());
    });
    const started = Date.now();
    try {
      await page.goto('/');
      await reopenStack(page, wallet);
      await expect(page.getByTestId('home-swap')).toBeEnabled();
      const restored = await readAccount(page, evidence.hubId);
      expect(restored).toEqual(evidence.after);
      await expect(page.getByTestId('token-net-USDC')).toHaveText(formatUnits(BigInt(evidence.after.usdc), 6));
      await expect(page.getByTestId('token-net-WETH')).toHaveText(formatUnits(BigInt(evidence.after.weth), 18));
      await expectDollarScale(page);
      await page.screenshot({ path: '/tmp/xln-home-mixed-desktop.png', fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await expectDollarScale(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: '/tmp/xln-home-mixed-mobile.png', fullPage: true });
      await page.setViewportSize({ width: 1280, height: 860 });
      const recoveredOrders = await readOrders(page, evidence.hubId);
      expect(recoveredOrders).toEqual(evidence.orders);
      await page.getByTestId('nav-activity').first().click();
      await page.getByRole('button', { name: 'Swaps', exact: true }).click();
      const history = page.getByTestId('swap-history-order');
      await expect(history).toHaveCount(1);
      await expect(history.locator('summary')).toContainText('Closed');
      await history.locator('summary').click();
      await expect(history.locator('[data-field="gave"]')).toHaveAttribute('data-amount', String(evidence.debit));
      await expect(history.locator('[data-field="received"]')).toHaveAttribute('data-amount', String(evidence.gross));
      await expect(history.locator('[data-field="fee"]')).toHaveAttribute('data-amount', String(evidence.fee));
      expect(errors).toEqual([]);
      await writeFile(
        '/tmp/xln-swap-reload-proof.json',
        safeStringify({ ...evidence, restored, recoveredOrders, recoveryElapsedMs: Date.now() - started }),
      );
      await page.screenshot({ path: '/tmp/xln-swap-reload-receipt.png', fullPage: true });
      console.log('SWAP_RECOVERY_PROVEN_MS', Date.now() - started);
    } finally {
      await context.close();
    }
  },
);
