import { expect, test, type Page } from '@playwright/test';
import { Wallet } from 'ethers';
import type { RuntimeAdapterViewFrame, RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { enterStack } from './stack';

type DebugWindow = Window & {
  __xln?: {
    adapter: () => RuntimeAdapter | null;
    env: () => RuntimeReplica | null;
    xln: () => Promise<XLNModule>;
    store: { getState: () => { activeEntityId: string | null } };
  };
};

const USDC = 1_000_000n;

/**
 * Exact USDC balances in every place a Move route touches: the signer's ERC20
 * balance and Depository allowance at the chain head, the committed reserve,
 * and the committed on-chain batch. An optional foreign address is read at
 * the same block. Mutations happen only through visible wallet controls.
 */
const readRoutes = (page: Page, recipient: string | null = null) =>
  page.evaluate(async foreign => {
    const debug = (window as DebugWindow).__xln;
    if (!debug) throw new Error('Wallet diagnostics unavailable');
    const adapter = debug.adapter();
    const env = debug.env();
    const entityId = debug.store.getState().activeEntityId;
    if (!adapter || !env || !entityId) throw new Error('Move route wallet owner unavailable');
    const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId });
    const active = frame.activeEntity;
    if (!active || frame.activeEntityId !== entityId) throw new Error('Move route snapshot owner unavailable');
    const signerId = active.core.signerId;
    if (!signerId) throw new Error('Move route signer unavailable');
    const xln = await debug.xln();
    const chain = xln.getEntityJAdapter(env, entityId, signerId);
    if (!chain) throw new Error('Move route chain adapter unavailable');
    if (!chain.getCurrentBlockNumber) throw new Error('Move route chain height reader unavailable');
    const token = (await chain.getTokenRegistry()).find(row => Number(row.tokenId) === 1);
    if (!token) throw new Error('Move route USDC contract unavailable');
    const head = await chain.getCurrentBlockNumber();
    const read = async (owner: string) => {
      const snapshot = await chain.readWalletSnapshot({
        owner,
        tokenAddresses: [token.address],
        allowances: [{ tokenAddress: token.address, spender: chain.addresses.depository }],
        includeNativeBalance: true,
        blockTag: head,
      });
      if (snapshot.tokenErrors?.length)
        throw new Error(`Move route token read failed: ${snapshot.tokenErrors[0]?.error}`);
      const balance = snapshot.tokenBalances[0];
      const allowance = snapshot.allowances?.[0];
      if (typeof balance !== 'bigint' || typeof allowance !== 'bigint' || typeof snapshot.nativeBalance !== 'bigint')
        throw new Error('Move route raw balance unavailable');
      return { balance, allowance, native: snapshot.nativeBalance };
    };
    const own = await read(signerId);
    const batch = active.core.jBatchState;
    return {
      signerId,
      runtimeHeight: frame.height,
      external: own.balance.toString(),
      allowance: own.allowance.toString(),
      native: own.native.toString(),
      reserve: (active.core.reserves.get(1) ?? 0n).toString(),
      foreign: foreign ? (await read(foreign)).balance.toString() : null,
      batch: {
        // Every JBatch operation array must be empty, including unrelated draft operations.
        draftOperations: batch
          ? Object.values(batch.batch)
              .filter(Array.isArray)
              .reduce((sum, rows) => sum + rows.length, 0)
          : 0,
        sent: Boolean(batch?.sentBatch),
      },
    };
  }, recipient);

/** Click one faucet and require the server to accept it; the balance itself is asserted by the caller. */
async function clickFaucet(page: Page, kind: 'gas' | 'erc20' | 'reserve'): Promise<void> {
  const response = page.waitForResponse(
    reply => new URL(reply.url()).pathname === `/api/faucet/${kind}` && reply.request().method() === 'POST',
  );
  await page.getByTestId(`faucet-${kind}`).click();
  const reply = await response;
  expect(reply.ok(), await reply.text()).toBe(true);
  await expect(page.getByTestId('faucet-gas')).toBeEnabled({ timeout: 15_000 });
}

/** Gas plus exactly 100 USDC from one faucet (`erc20` → signer wallet, `reserve` → Depository reserve). */
async function fundThroughAssets(page: Page, kind: 'erc20' | 'reserve'): Promise<void> {
  const before = await readRoutes(page);
  expect(before.external).toBe('0');
  expect(before.reserve).toBe('0');
  expect(before.batch).toEqual({ draftOperations: 0, sent: false });
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-assets').click();
  await expect(page.getByTestId('faucets')).toBeVisible();
  await clickFaucet(page, 'gas');
  await page.getByTestId('faucet-amount').fill('100');
  await clickFaucet(page, kind);
  await expect
    .poll(
      async () => {
        const state = await readRoutes(page);
        return { external: state.external, reserve: state.reserve };
      },
      { timeout: 15_000 },
    )
    .toEqual({
      external: kind === 'erc20' ? (100n * USDC).toString() : '0',
      reserve: kind === 'reserve' ? (100n * USDC).toString() : '0',
    });
  await expect(page.getByTestId('external-balance-USDC')).toHaveText(kind === 'erc20' ? '100.00' : '0.00');
  await expect(page.getByTestId('faucet-reserve-balance')).toHaveText(kind === 'reserve' ? '100.00 USDC' : '0.00 USDC');
  expect(BigInt((await readRoutes(page)).native)).toBeGreaterThan(0n);
}

async function openMove(page: Page, from: 'external' | 'reserve', to: 'external' | 'reserve'): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.getByTestId('home-move').click();
  await page.getByTestId(`move-from-${from}`).click();
  await page.getByTestId(`move-to-${to}`).click();
}

test(
  'Move withdraws reserve USDC to the own wallet through a signed batch and to another address at once, exact to the unit',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await enterStack(page);
    await fundThroughAssets(page, 'reserve');
    const foreign = Wallet.createRandom().address;
    const funded = await readRoutes(page, foreign);
    expect(funded.foreign).toBe('0');

    // Reserve → own wallet: queued as a draft, visible in the pending batch, nothing moves until it is signed.
    await openMove(page, 'reserve', 'external');
    await expect(page.getByTestId('move-from-reserve')).toContainText('100.00 USDC');
    await page.getByTestId('move-external-recipient').fill(funded.signerId);
    await page.getByTestId('move-amount').fill('15');
    await expect(page.getByTestId('move-draft')).toBeEnabled();
    await page.getByTestId('move-draft').click();
    const pending = page.getByTestId('pending-batch');
    await expect(pending).toHaveAttribute('data-mode', 'draft', { timeout: 15_000 });
    await expect(pending).toContainText('Reserve → Wallet');
    // The Move screen shows the batch collapsed; expand it to read the queued amount.
    await pending.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(pending).toContainText('Reserve → Wallet15.00 USDC');
    const drafted = await readRoutes(page, foreign);
    expect(drafted.batch).toEqual({ draftOperations: 1, sent: false });
    expect(drafted.reserve).toBe(funded.reserve);
    expect(drafted.external).toBe(funded.external);
    await page.getByTestId('batch-broadcast').click();
    await expect
      .poll(
        async () => {
          const state = await readRoutes(page, foreign);
          return { external: state.external, reserve: state.reserve, foreign: state.foreign, batch: state.batch };
        },
        { timeout: 20_000 },
      )
      .toEqual({
        external: (BigInt(funded.external) + 15n * USDC).toString(),
        reserve: (BigInt(funded.reserve) - 15n * USDC).toString(),
        foreign: '0',
        batch: { draftOperations: 0, sent: false },
      });
    await expect(page.getByTestId('pending-batch')).toHaveCount(0);
    const withdrawn = await readRoutes(page, foreign);
    expect(withdrawn.runtimeHeight).toBeGreaterThan(funded.runtimeHeight);

    // Reserve → another address: signed and sent immediately, only that address receives.
    await openMove(page, 'reserve', 'external');
    await page.getByTestId('move-external-recipient').fill(foreign);
    await page.getByTestId('move-amount').fill('25.5');
    await expect(page.getByTestId('move-now')).toBeEnabled();
    await page.getByTestId('move-now').click();
    await expect(page.getByTestId('home-total')).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const state = await readRoutes(page, foreign);
          return { external: state.external, reserve: state.reserve, foreign: state.foreign, batch: state.batch };
        },
        { timeout: 20_000 },
      )
      .toEqual({
        external: withdrawn.external,
        reserve: (BigInt(withdrawn.reserve) - 25_500_000n).toString(),
        foreign: '25500000',
        batch: { draftOperations: 0, sent: false },
      });
    await expect(page.getByTestId('pending-batch')).toHaveCount(0);
    const sent = await readRoutes(page, foreign);
    expect(BigInt(sent.external) + BigInt(sent.reserve) + BigInt(sent.foreign ?? 'x')).toBe(100n * USDC);
    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await page.getByTestId('manage-assets').click();
    await expect(page.getByTestId('external-balance-USDC')).toHaveText('15.00', { timeout: 15_000 });
    await expect(page.getByTestId('faucet-reserve-balance')).toHaveText('59.50 USDC');
    expect(pageErrors, 'no uncaught browser errors during the flow').toEqual([]);
  },
);

test(
  'Move deposits wallet USDC into reserve after an explicit allowance, then sends wallet USDC to another address directly',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await enterStack(page);
    await fundThroughAssets(page, 'erc20');
    const foreign = Wallet.createRandom().address;
    const funded = await readRoutes(page, foreign);
    expect(funded.allowance).toBe('0');
    expect(funded.foreign).toBe('0');

    // Wallet → Reserve: the Move screen must see the funded signer wallet before it can offer a deposit.
    await openMove(page, 'external', 'reserve');
    await expect(page.getByTestId('move-from-external')).toContainText('100.00 USDC', { timeout: 15_000 });
    await page.getByTestId('move-amount').fill('40');
    await expect(page.getByTestId('move-now')).toBeDisabled();
    await expect(page.getByTestId('move-approve')).toBeEnabled();
    await page.getByTestId('move-approve').click();
    await expect(page.getByTestId('move-approve')).toHaveCount(0, { timeout: 15_000 });
    expect((await readRoutes(page, foreign)).allowance).toBe((40n * USDC).toString());
    await expect(page.getByTestId('move-now')).toBeEnabled();
    await page.getByTestId('move-now').click();
    await expect(page.getByTestId('home-total')).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const state = await readRoutes(page, foreign);
          return { external: state.external, reserve: state.reserve, allowance: state.allowance, batch: state.batch };
        },
        { timeout: 20_000 },
      )
      .toEqual({
        external: (BigInt(funded.external) - 40n * USDC).toString(),
        reserve: (BigInt(funded.reserve) + 40n * USDC).toString(),
        allowance: '0',
        batch: { draftOperations: 0, sent: false },
      });
    await expect(page.getByTestId('pending-batch')).toHaveCount(0);
    const deposited = await readRoutes(page, foreign);

    // Wallet → another address: a direct ERC20 transfer, never a batch, never touching the reserve.
    await openMove(page, 'external', 'external');
    await page.getByTestId('move-amount').fill('12.5');
    await page.getByTestId('move-external-recipient').fill(deposited.signerId);
    await expect(page.getByText('That is your own wallet', { exact: true })).toBeVisible();
    await expect(page.getByTestId('move-send-external')).toBeDisabled();
    await expect(page.getByTestId('move-draft')).toHaveCount(0);
    await page.getByTestId('move-external-recipient').fill(foreign);
    await expect(page.getByTestId('move-send-external')).toBeEnabled();
    await page.getByTestId('move-send-external').click();
    await expect(page.getByTestId('move-amount')).toHaveValue('', { timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const state = await readRoutes(page, foreign);
          return { external: state.external, foreign: state.foreign, reserve: state.reserve, batch: state.batch };
        },
        { timeout: 15_000 },
      )
      .toEqual({
        external: (BigInt(deposited.external) - 12_500_000n).toString(),
        foreign: '12500000',
        reserve: deposited.reserve,
        batch: { draftOperations: 0, sent: false },
      });
    await expect(page.getByTestId('pending-batch')).toHaveCount(0);
    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await page.getByTestId('manage-assets').click();
    await expect(page.getByTestId('external-balance-USDC')).toHaveText('47.50', { timeout: 15_000 });
    await expect(page.getByTestId('faucet-reserve-balance')).toHaveText('40.00 USDC');
    expect(pageErrors, 'no uncaught browser errors during the flow').toEqual([]);
  },
);
