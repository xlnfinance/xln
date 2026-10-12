import { expect, test, type Page } from '@playwright/test';
import type { RuntimeAdapterViewFrame, RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { enterStack } from './stack';

type FaucetKind = 'erc20' | 'gas' | 'reserve' | 'offchain';
type DebugWindow = Window & {
  __xln?: {
    adapter: () => RuntimeAdapter | null;
    env: () => RuntimeReplica | null;
    xln: () => Promise<XLNModule>;
    store: { getState: () => { activeEntityId: string | null } };
  };
};

/** All mutations use visible controls; exact balances come from the committed Account and real chain. */
const readAssets = (page: Page) =>
  page.evaluate(async () => {
    const debug = (window as DebugWindow).__xln;
    if (!debug) throw new Error('Wallet diagnostics unavailable');
    const adapter = debug.adapter();
    const env = debug.env();
    const entityId = debug.store.getState().activeEntityId;
    if (!adapter || !env || !entityId) throw new Error('Assets wallet owner unavailable');
    const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId });
    const active = frame.activeEntity;
    if (!active || frame.activeEntityId !== entityId) throw new Error('Assets snapshot owner unavailable');
    const signerId = active.core.signerId;
    const account = active.accounts.items[0];
    if (!signerId || !account) throw new Error('Assets signer or Account unavailable');
    const counterpartyId = account.state.leftEntity === entityId ? account.state.rightEntity : account.state.leftEntity;
    const delta = account.state.deltas.get(1);
    if (!delta) throw new Error('Assets USDC delta unavailable');
    const xln = await debug.xln();
    const derived = xln.deriveDelta(delta, xln.isLeftEntity(entityId, counterpartyId));
    const capacity = xln.readAccountCapacity({
      account: account.state,
      ownerEntityId: entityId,
      counterpartyEntityId: counterpartyId,
      tokenId: 1,
    });
    const chain = xln.getEntityJAdapter(env, entityId, signerId);
    if (!chain) throw new Error('Assets chain adapter unavailable');
    const token = (await chain.getTokenRegistry()).find(row => Number(row.tokenId) === 1);
    if (!token) throw new Error('Assets USDC contract unavailable');
    if (!chain.getCurrentBlockNumber) throw new Error('Assets chain height reader unavailable');
    const head = await chain.getCurrentBlockNumber();
    const external = await chain.readWalletSnapshot({
      owner: signerId,
      tokenAddresses: [token.address],
      includeNativeBalance: true,
      blockTag: head,
    });
    if (external.tokenErrors?.length) throw new Error(`Assets token read failed: ${external.tokenErrors[0]?.error}`);
    const usdc = external.tokenBalances[0];
    if (typeof usdc !== 'bigint' || typeof external.nativeBalance !== 'bigint')
      throw new Error('Assets raw balance unavailable');
    return {
      signerId,
      external: usdc.toString(),
      native: external.nativeBalance.toString(),
      reserve: (active.core.reserves.get(1) ?? 0n).toString(),
      owned: (derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit).toString(),
      credit: capacity.peerCreditLimit.toString(),
      capacity: capacity.inCapacity.toString(),
      pending: Boolean(account.pendingFrame),
      mempool: account.mempoolCount,
    };
  });

async function clickFaucet(page: Page, kind: FaucetKind, status = 200) {
  const responsePromise = page.waitForResponse(
    response => new URL(response.url()).pathname === `/api/faucet/${kind}` && response.request().method() === 'POST',
  );
  await page.getByTestId(`faucet-${kind}`).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(status);
  // A successful incoming payment can exhaust its own capacity; the gas control still proves shared busy is cleared.
  await expect(page.getByTestId('faucet-gas')).toBeEnabled({ timeout: 15_000 });
}

test(
  'Assets faucets fund four real balances once and require explicit incoming credit consent',
  { tag: '@functional' },
  async ({ page }, testInfo) => {
    test.setTimeout(50_000);
    const pageErrors: string[] = [];
    const requests: Record<FaucetKind, string[]> = { erc20: [], gas: [], reserve: [], offchain: [] };
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => {
      if (request.method() !== 'POST') return;
      const match = new URL(request.url()).pathname.match(/^\/api\/faucet\/(erc20|gas|reserve|offchain)$/);
      if (!match?.[1]) return;
      const body: unknown = request.postDataJSON();
      if (!body || typeof body !== 'object') throw new Error('Faucet request body missing');
      if (match[1] === 'gas') {
        // The server chooses the gas grant; its exact credited amount is
        // checked against the real native balance below, not invented here.
        expect(body).not.toHaveProperty('amount');
        if (!('userAddress' in body) || typeof body.userAddress !== 'string') throw new Error('Gas recipient missing');
        requests.gas.push(body.userAddress);
        return;
      }
      if (!('amount' in body)) throw new Error('Faucet request amount missing');
      requests[match[1] as FaucetKind].push(String(body.amount));
    });
    await enterStack(page);
    await page.getByTestId('home-add-money').click();
    await page.getByTestId('add-money-onchain').click();
    await expect(page.getByTestId('faucets')).toBeVisible();
    await expect(page.getByTestId('external-balance-USDC')).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const state = await readAssets(page);
          return { pending: state.pending, mempool: state.mempool };
        },
        { timeout: 15_000 },
      )
      .toEqual({ pending: false, mempool: 0 });
    const initial = await readAssets(page);
    expect(initial.external).toBe('0');
    expect(initial.reserve).toBe('0');
    expect(initial.owned).toBe('0');
    expect(initial.credit).toBe('0');
    expect(initial.capacity).toBe('0');
    await expect(page.getByTestId('faucet-amount')).toHaveValue('100');
    const spectrum = page.getByTestId('receive-spectrum');
    await expect(spectrum).toBeVisible();
    await expect(page.getByTestId('receive-spectrum-slider')).toHaveValue('0');
    await expect(spectrum.getByRole('button', { name: '100% collateral', exact: true })).toHaveClass(/active/);
    await expect(page.getByTestId('faucet-offchain')).toBeDisabled();
    expect((await readAssets(page)).credit).toBe(initial.credit);
    await page.screenshot({ path: testInfo.outputPath('faucet-before-credit.png'), fullPage: true });

    await page.getByTestId('faucet-amount').fill('101');
    await clickFaucet(page, 'erc20', 413);
    await expect(page.getByTestId('faucet-status')).toContainText(/exceeds.*cap/i);
    const rejected = await readAssets(page);
    expect(rejected.external).toBe(initial.external);
    expect(rejected.native).toBe(initial.native);
    expect(rejected.reserve).toBe(initial.reserve);
    expect(rejected.owned).toBe(initial.owned);
    await page.getByTestId('faucet-amount').fill('100');
    await clickFaucet(page, 'erc20');
    await expect.poll(async () => (await readAssets(page)).external, { timeout: 15_000 }).toBe('100000000');
    await expect(page.getByTestId('external-balance-USDC')).toHaveText('100.00');
    await expect(page.getByTestId('faucet-status')).not.toContainText(/exceeds.*cap/i);

    // The token mint can top up gas itself; measure the explicit gas request from the subsequent chain snapshot.
    const beforeGas = await readAssets(page);
    await expect(page.getByTestId('faucet-amount')).toHaveValue('100');
    await clickFaucet(page, 'gas');
    await expect
      .poll(async () => (await readAssets(page)).native, { timeout: 15_000 })
      .toBe((BigInt(beforeGas.native) + 100_000_000_000_000_000n).toString());
    await expect(page.getByTestId('faucet-amount')).toHaveValue('100');

    const beforeReserve = await readAssets(page);
    await clickFaucet(page, 'reserve');
    await expect
      .poll(async () => (await readAssets(page)).reserve, { timeout: 15_000 })
      .toBe((BigInt(beforeReserve.reserve) + 100_000_000n).toString());
    await expect(page.getByTestId('faucet-offchain')).toBeDisabled();
    await expect(page.getByTestId('receive-spectrum-slider')).toHaveValue('0');
    expect((await readAssets(page)).credit).toBe('0');
    await spectrum.getByRole('button', { name: '0% collateral', exact: true }).click();
    await expect(page.getByTestId('receive-spectrum-slider')).toHaveValue('100');
    await expect(spectrum.getByRole('checkbox')).toBeChecked();
    expect((await readAssets(page)).credit).toBe('0');
    await page.getByTestId('receive-spectrum-confirm').click();
    await expect(spectrum).toHaveCount(0, { timeout: 15_000 });
    const ready = await readAssets(page);
    expect(ready.credit).toBe('110000000');
    expect(ready.owned).toBe('0');
    expect(requests.offchain).toEqual([]);
    await clickFaucet(page, 'offchain');
    await expect
      .poll(
        async () => {
          const state = await readAssets(page);
          return { owned: state.owned, pending: state.pending, mempool: state.mempool };
        },
        { timeout: 15_000 },
      )
      .toEqual({ owned: '100000000', pending: false, mempool: 0 });
    const funded = await readAssets(page);
    expect(funded.external).toBe('100000000');
    expect(funded.reserve).toBe('100000000');
    expect(funded.credit).toBe(ready.credit);
    for (const balance of ['faucet-account-balance', 'faucet-reserve-balance']) {
      await expect(page.getByTestId(balance)).toBeVisible();
      await expect(page.getByTestId(balance)).toHaveText('100.00 USDC');
    }
    expect(requests).toEqual({ erc20: ['101', '100'], gas: [initial.signerId], reserve: ['100'], offchain: ['100'] });
    console.log(
      `FAUCETS_CONFIRMED external=${funded.external} reserve=${funded.reserve} account=${funded.owned} gasAdded=100000000000000000 requests=5 successful=4`,
    );
    await page.screenshot({ path: testInfo.outputPath('faucet-funded.png'), fullPage: true });
    expect(pageErrors).toEqual([]);
  },
);
