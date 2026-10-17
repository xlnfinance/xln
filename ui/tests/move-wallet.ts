import type { Expect, Page } from '@playwright/test';
import type { RuntimeAdapterViewFrame, RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';

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
export const readRoutes = (page: Page, recipient: string | null = null) =>
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

// Both runner packages supply their own expect instance; never load two Playwright runtimes.
/** Click one faucet and require the server to accept it; the balance itself is asserted by the caller. */
export async function clickFaucet(page: Page, kind: 'gas' | 'erc20' | 'reserve', expect: Expect): Promise<void> {
  const response = page.waitForResponse(
    reply => new URL(reply.url()).pathname === `/api/faucet/${kind}` && reply.request().method() === 'POST',
  );
  await page.getByTestId(`faucet-${kind}`).click();
  const reply = await response;
  expect(reply.ok(), await reply.text()).toBe(true);
  await expect(page.getByTestId('faucet-gas')).toBeEnabled({ timeout: 15_000 });
}

/** Gas plus exactly 100 USDC from one faucet (`erc20` → signer wallet, `reserve` → Depository reserve). */
export async function fundThroughAssets(page: Page, kind: 'erc20' | 'reserve', expect: Expect): Promise<void> {
  const before = await readRoutes(page);
  expect(before.external).toBe('0');
  expect(before.reserve).toBe('0');
  expect(before.batch).toEqual({ draftOperations: 0, sent: false });
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-assets').click();
  await expect(page.getByTestId('faucets')).toBeVisible();
  await clickFaucet(page, 'gas', expect);
  await page.getByTestId('faucet-amount').fill('100');
  await clickFaucet(page, kind, expect);
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

export async function openMove(page: Page, from: 'external' | 'reserve', to: 'external' | 'reserve'): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.getByTestId('home-move').click();
  await page.getByTestId(`move-from-${from}`).click();
  await page.getByTestId(`move-to-${to}`).click();
}
