import { expect, test } from '@playwright/test';
import { safeStringify } from '../../core/protocol/serialization';
import { enterStack, fundFromHub } from './stack';
import { readAccount, readPools } from './lending/financial-evidence';

test(
  'lending close prepares incoming capacity before a manual committed payout',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(50_000);
    const errors: string[] = [];
    const authErrors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      console.log(`BROWSER_${message.type()}: ${message.text().slice(0, 500)}`);
      if (/MAC.*(?:INVALID|FAIL|MISMATCH)|(?:INVALID|FAIL|MISMATCH).*MAC|WS_MESSAGE_AUTH/i.test(message.text()))
        authErrors.push(message.text());
    });
    await enterStack(page);
    const ownerId = (await page.getByTestId('home-entity-id').textContent())?.trim();
    if (!ownerId) throw new Error('Lender Entity unavailable');
    const fundingResponse = page.waitForResponse(
      response => new URL(response.url()).pathname === '/api/faucet/offchain' && response.request().method() === 'POST',
    );
    await Promise.all([
      fundFromHub(page, '100'),
      fundingResponse.then(async funding => expect(funding.ok(), await funding.text()).toBe(true)),
    ]);
    await page.getByTestId('account-row').first().click();
    const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
    if (!hubId) throw new Error('Lender hub Account unavailable');
    const parties = { ownerId, hubId, tokenId: 1 };
    await expect.poll(async () => (await readAccount(page, parties)).balance).toBe('100000000');
    const funded = await readAccount(page, parties);
    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await page.getByTestId('manage-lend').click();
    await page.getByTestId('lend-side-borrow').click();
    await expect(page.getByText('Approval transfers the principal to your account once.', { exact: false })).toBeVisible();
    await expect(page.getByTestId('receive-spectrum')).toHaveCount(0);
    await page.getByTestId('lend-side-lend').click();
    await page.getByTestId('lend-amount').fill('100');
    await page.getByTestId('lend-submit').click();
    await expect
      .poll(async () => (await readPools(page, parties)).map(pool => pool.status), { timeout: 15_000 })
      .toEqual(['open']);
    await expect.poll(async () => (await readAccount(page, parties)).balance).toBe('0');
    const offered = await readAccount(page, parties);
    const pools = await readPools(page, parties);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ principal: '100000000', available: '100000000', borrowed: '0' });
    expect(offered.debt).toBe('0');
    expect(BigInt(funded.balance) - BigInt(offered.balance)).toBe(100000000n);

    // After funding the pool, the hub owes no Account balance. The existing credit
    // editor can lower the permanent grant to 1 USDC, creating a real receive deficit.
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await page.getByTestId('account-row').first().click();
    await page.getByRole('button', { name: 'Extend credit', exact: true }).click();
    const creditDialog = page.getByRole('dialog', { name: 'Extend credit', exact: true });
    await creditDialog.locator('input').fill('1');
    await creditDialog.getByRole('button', { name: 'Extend credit', exact: true }).click();
    await expect(creditDialog).toHaveCount(0);
    await expect.poll(async () => (await readAccount(page, parties)).credit).toBe('1000000');
    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await page.getByTestId('manage-lend').click();
    const spectrum = page.getByTestId('receive-spectrum');
    const close = page.getByTestId('lending-close');
    await expect(spectrum).toBeVisible();
    await expect(spectrum).toContainText('USDC');
    await expect(spectrum).toContainText('Testnet');
    await expect(spectrum).toContainText('This preparation submits no collateral request.');
    await expect(page.getByTestId('receive-spectrum-slider')).toHaveValue('0');
    await expect(close).toBeDisabled();
    const before = await readAccount(page, parties);
    expect(before.incoming).toBe('1000000');
    await spectrum.getByRole('button', { name: 'Accept it as credit instead', exact: true }).click();
    await expect(page.getByTestId('receive-spectrum-slider')).toHaveValue('100');
    await expect(spectrum.getByRole('checkbox')).toBeChecked();
    await expect(close).toBeDisabled();
    const chosen = await readAccount(page, parties);
    expect(chosen.balance).toBe(before.balance);
    expect(chosen.credit).toBe(before.credit);
    expect(await readPools(page, parties)).toEqual(pools);
    await expect(page.getByTestId('receive-spectrum-confirm')).toHaveText('Extend credit limit');
    await page.getByTestId('receive-spectrum-confirm').click();
    await expect(spectrum).toHaveCount(0, { timeout: 15_000 });
    await expect(close).toBeEnabled();
    const prepared = await readAccount(page, parties);
    // Grant 1 + missing 99 = required total 100; the optional buffer applies to all 100.
    expect(prepared.credit).toBe('110000000');
    expect(prepared.balance).toBe('0');
    expect(prepared.debt).toBe('0');
    expect(await readPools(page, parties)).toEqual(pools);
    const tariff = page.getByTestId('lending-close-tariff');
    if (!prepared.feePolicy) throw new Error('Committed lending collateral tariff missing');
    await expect(tariff).toHaveAttribute('data-policy-version', String(prepared.feePolicy.version));
    await expect(tariff).toHaveAttribute('data-base', prepared.feePolicy.base);
    await expect(tariff).toHaveAttribute('data-gas', prepared.feePolicy.gas);
    await expect(tariff).toHaveAttribute('data-bps', prepared.feePolicy.bps);
    const preCloseText = await close.locator('..').innerText();
    await page.screenshot({ path: '/tmp/xln-lending-receive-ready.png', fullPage: true });
    console.log(
      `LENDING_READY ${safeStringify({ parties, funded, offered, pools, before, chosen, prepared, preCloseText })}`,
    );
    await close.click();
    await expect
      .poll(async () => (await readPools(page, parties)).map(pool => pool.status), { timeout: 15_000 })
      .toEqual(['closed']);
    await expect.poll(async () => (await readAccount(page, parties)).balance).toBe('100000000');
    await expect
      .poll(async () => {
        const account = await readAccount(page, parties);
        return { pending: account.pending, mempool: account.mempool };
      })
      .toEqual({ pending: false, mempool: 0 });
    const after = await readAccount(page, parties);
    const closedPools = await readPools(page, parties);
    expect(closedPools[0]).toMatchObject({
      positionId: pools[0]!.positionId,
      principal: '100000000',
      available: '0',
      borrowed: '0',
      status: 'closed',
    });
    expect(after.credit).toBe(prepared.credit);
    expect(after.debt).toBe('0');
    expect(BigInt(after.balance) - BigInt(prepared.balance)).toBe(100000000n);
    expect(after.root).not.toBe(prepared.root);
    const evidence = safeStringify(
      { parties, funded, offered, pools, before, chosen, prepared, preCloseText, after, closedPools },
      2,
    );
    await test.info().attach('lending-committed-payout', { body: evidence, contentType: 'application/json' });
    console.log(`LENDING_CLOSED ${evidence}`);
    expect(errors).toEqual([]);
    expect(authErrors).toEqual([]);
    expect(preCloseText, 'Lending payout must disclose its committed collateral tariff before close').toContain(
      'collateral tariff',
    );
  },
);
