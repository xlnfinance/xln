import type { Expect, Page, TestInfo } from '@playwright/test';
import { parseEther, type JsonRpcProvider } from 'ethers';
import type { RuntimeAdapterViewFrame, RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { safeStringify } from '../../core/protocol/serialization';
import { requireBoundaryRecord } from '../../core/protocol/boundary-validation';

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
const readAssets = (page: Page, symbol: string) =>
  page.evaluate(async selectedSymbol => {
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
    const xln = await debug.xln();
    const chain = xln.getEntityJAdapter(env, entityId, signerId);
    if (!chain) throw new Error('Assets chain adapter unavailable');
    const token = (await chain.getTokenRegistry()).find(row => row.symbol === selectedSymbol);
    if (!token) throw new Error(`Assets token contract unavailable: ${selectedSymbol}`);
    const tokenId = Number(token.tokenId);
    const delta = account.state.deltas.get(tokenId);
    const derived = delta ? xln.deriveDelta(delta, xln.isLeftEntity(entityId, counterpartyId)) : null;
    const capacity = xln.readAccountCapacity({
      account: account.state,
      ownerEntityId: entityId,
      counterpartyEntityId: counterpartyId,
      tokenId,
    });
    if (!chain.getCurrentBlockNumber) throw new Error('Assets chain height reader unavailable');
    const head = await chain.getCurrentBlockNumber();
    const external = await chain.readWalletSnapshot({
      owner: signerId,
      tokenAddresses: [token.address],
      includeNativeBalance: true,
      blockTag: head,
    });
    if (external.tokenErrors?.length) throw new Error(`Assets token read failed: ${external.tokenErrors[0]?.error}`);
    const balance = external.tokenBalances[0];
    if (typeof balance !== 'bigint' || typeof external.nativeBalance !== 'bigint')
      throw new Error('Assets raw balance unavailable');
    return {
      signerId,
      external: balance.toString(),
      tokenId,
      decimals: token.decimals,
      symbol: token.symbol,
      native: external.nativeBalance.toString(),
      reserve: (active.core.reserves.get(tokenId) ?? 0n).toString(),
      owned: derived ? (derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit).toString() : '0',
      credit: capacity.peerCreditLimit.toString(),
      capacity: capacity.inCapacity.toString(),
      pending: Boolean(account.pendingFrame),
      mempool: account.mempoolCount,
    };
  }, symbol);

async function clickFaucet(page: Page, kind: FaucetKind, expect: Expect, status = 200) {
  const responsePromise = page.waitForResponse(
    response => new URL(response.url()).pathname === `/api/faucet/${kind}` && response.request().method() === 'POST',
  );
  await page.getByTestId(`faucet-${kind}`).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(status);
  // A successful incoming payment can exhaust its own capacity; the gas control still proves shared busy is cleared.
  await expect(page.getByTestId('faucet-gas')).toBeEnabled({ timeout: 15_000 });
  return response;
}

export async function exerciseAssetFaucets(
  page: Page,
  provider: JsonRpcProvider,
  testInfo: TestInfo,
  symbol: string,
  expect: Expect,
  rejectedAmount: string,
): Promise<void> {
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
    const kind = match[1];
    if (kind !== 'erc20' && kind !== 'reserve' && kind !== 'offchain') throw new Error('Faucet kind invalid');
    if (!('amount' in body)) throw new Error('Faucet request amount missing');
    requests[kind].push(String(body.amount));
  });
  await page.getByTestId('home-add-money').click();
  await page.getByTestId('add-money-onchain').click();
  await expect(page.getByTestId('faucets')).toBeVisible();
  for (const token of ['USDC', 'WETH', 'USDT'])
    await expect(page.getByTestId('faucets').getByRole('button', { name: token, exact: true })).toBeVisible();
  await page.getByTestId('faucets').getByRole('button', { name: symbol, exact: true }).click();
  await expect(page.getByTestId(`external-balance-${symbol}`)).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const state = await readAssets(page, symbol);
        return { pending: state.pending, mempool: state.mempool };
      },
      { timeout: 15_000 },
    )
    .toEqual({ pending: false, mempool: 0 });
  const initial = await readAssets(page, symbol);
  const amount = 100n * 10n ** BigInt(initial.decimals);
  expect(initial.symbol).toBe(symbol);
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
  expect((await readAssets(page, symbol)).credit).toBe(initial.credit);
  await page.screenshot({ path: testInfo.outputPath('faucet-before-credit.png'), fullPage: true });

  await page.getByTestId('faucet-amount').fill(rejectedAmount);
  await clickFaucet(page, 'erc20', expect, 413);
  await expect(page.getByTestId('faucet-status')).toContainText(/exceeds.*cap/i);
  const rejected = await readAssets(page, symbol);
  expect(rejected.external).toBe(initial.external);
  expect(rejected.native).toBe(initial.native);
  expect(rejected.reserve).toBe(initial.reserve);
  expect(rejected.owned).toBe(initial.owned);
  await page.getByTestId('faucet-amount').fill('100');
  await clickFaucet(page, 'erc20', expect);
  await expect.poll(async () => (await readAssets(page, symbol)).external, { timeout: 15_000 }).toBe(amount.toString());
  await expect(page.getByTestId(`external-balance-${symbol}`)).toHaveText('100.00');
  await expect(page.getByTestId('faucet-status')).not.toContainText(/exceeds.*cap/i);

  // The token mint can top up gas itself; measure the explicit gas request from the subsequent chain snapshot.
  const beforeGas = await readAssets(page, symbol);
  await expect(page.getByTestId('faucet-amount')).toHaveValue('100');
  const gasResponse = await clickFaucet(page, 'gas', expect);
  const gasReceipt = requireBoundaryRecord(await gasResponse.json(), 'GAS_RECEIPT_INVALID');
  expect(gasReceipt).toMatchObject({ success: true, type: 'gas', userAddress: initial.signerId });
  const gasAmount = gasReceipt['amount'];
  const txHash = gasReceipt['txHash'];
  if (typeof gasAmount !== 'string' || typeof txHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(txHash))
    throw new Error('Gas grant amount or transaction hash missing');
  const gasAdded = parseEther(gasAmount);
  expect(gasAdded).toBeGreaterThan(0n);
  expect(gasAdded).toBeLessThanOrEqual(parseEther('0.1'));
  {
    const transaction = await provider.getTransaction(txHash);
    if (!transaction) throw new Error('Gas grant transaction missing');
    expect(transaction.to?.toLowerCase()).toBe(initial.signerId.toLowerCase());
    expect(transaction.value).toBe(gasAdded);
    expect((await provider.getTransactionReceipt(txHash))?.status).toBe(1);
  }
  await expect
    .poll(async () => (await readAssets(page, symbol)).native, { timeout: 15_000 })
    .toBe((BigInt(beforeGas.native) + gasAdded).toString());
  await expect(page.getByTestId('faucet-amount')).toHaveValue('100');

  const beforeReserve = await readAssets(page, symbol);
  await clickFaucet(page, 'reserve', expect);
  await expect
    .poll(async () => (await readAssets(page, symbol)).reserve, { timeout: 15_000 })
    .toBe((BigInt(beforeReserve.reserve) + amount).toString());
  await expect(page.getByTestId('faucet-offchain')).toBeDisabled();
  await expect(page.getByTestId('receive-spectrum-slider')).toHaveValue('0');
  expect((await readAssets(page, symbol)).credit).toBe('0');
  await spectrum.getByRole('button', { name: '0% collateral', exact: true }).click();
  await expect(page.getByTestId('receive-spectrum-slider')).toHaveValue('100');
  await expect(spectrum.getByRole('checkbox')).toBeChecked();
  expect((await readAssets(page, symbol)).credit).toBe('0');
  await page.getByTestId('receive-spectrum-confirm').click();
  await expect(spectrum).toHaveCount(0, { timeout: 15_000 });
  const ready = await readAssets(page, symbol);
  expect(ready.credit).toBe(((amount * 11n) / 10n).toString());
  expect(ready.owned).toBe('0');
  expect(requests.offchain).toEqual([]);
  await clickFaucet(page, 'offchain', expect);
  await expect
    .poll(
      async () => {
        const state = await readAssets(page, symbol);
        return { owned: state.owned, pending: state.pending, mempool: state.mempool };
      },
      { timeout: 15_000 },
    )
    .toEqual({ owned: amount.toString(), pending: false, mempool: 0 });
  const funded = await readAssets(page, symbol);
  expect(funded.external).toBe(amount.toString());
  expect(funded.reserve).toBe(amount.toString());
  expect(funded.credit).toBe(ready.credit);
  for (const balance of ['faucet-account-balance', 'faucet-reserve-balance']) {
    await expect(page.getByTestId(balance)).toBeVisible();
    await expect(page.getByTestId(balance)).toHaveText(`100.00 ${symbol}`);
  }
  expect(requests).toEqual({
    erc20: [rejectedAmount, '100'],
    gas: [initial.signerId],
    reserve: ['100'],
    offchain: ['100'],
  });
  console.log(
    `FAUCETS_CONFIRMED external=${funded.external} reserve=${funded.reserve} account=${funded.owned} gasAdded=${gasAdded} requests=5 successful=4`,
  );
  await testInfo.attach('faucet-exact-balances', {
    body: safeStringify({ symbol, initial, rejected, funded, gasAdded, gasTransaction: txHash, requests }),
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath('faucet-funded.png'), fullPage: true });
  expect(pageErrors).toEqual([]);
}
