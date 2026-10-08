import { expect, test, type Page } from '@playwright/test';
import { parseUnits } from 'ethers';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { safeStringify } from '../../core/protocol/serialization';
import { enterStack, reopenStack } from './stack';

type DebugWindow = Window & {
  __xln?: {
    adapter: () => RuntimeAdapter | null;
    xln: () => Promise<XLNModule>;
    store: { getState: () => { activeEntityId: string | null } };
  };
};

const USDC = 1_000_000n;

/** The committed USDC lane with the hub, from our side; every mutation goes through visible controls. */
const readHubLane = (page: Page, hubId: string) =>
  page.evaluate(async counterpartyId => {
    const debug = (window as DebugWindow).__xln;
    if (!debug) throw new Error('Wallet diagnostics unavailable');
    const adapter = debug.adapter();
    const entityId = debug.store.getState().activeEntityId;
    if (!adapter || !entityId) throw new Error('Collateral wallet owner unavailable');
    const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId, accountId: counterpartyId });
    const active = frame.activeEntity;
    if (!active || frame.activeEntityId !== entityId) throw new Error('Collateral snapshot owner unavailable');
    const account = active.accounts.items.find(
      item => item.state.leftEntity === counterpartyId || item.state.rightEntity === counterpartyId,
    );
    if (!account) throw new Error('Collateral hub Account unavailable');
    const delta = account.state.deltas.get(1);
    if (!delta) throw new Error('Collateral USDC delta unavailable');
    const xln = await debug.xln();
    const isLeft = xln.isLeftEntity(entityId, counterpartyId);
    const derived = xln.deriveDelta(delta, isLeft);
    // The fee we pay is the counterparty's committed policy, exactly what the Manage sheet reads.
    const policy = account.state.rebalanceFeePolicies?.get(1)?.[isLeft ? 'right' : 'left'] ?? null;
    return {
      accountHeight: account.currentHeight,
      pending: Boolean(account.pendingFrame),
      mempool: account.mempoolCount,
      collateral: delta.collateral.toString(),
      ondelta: delta.ondelta.toString(),
      offdelta: delta.offdelta.toString(),
      signed: (derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit).toString(),
      outCollateral: derived.outCollateral.toString(),
      outPeerCredit: derived.outPeerCredit.toString(),
      theirCreditToUs: derived.ownCreditLimit.toString(),
      requestedCollateral: (account.state.requestedRebalance?.get(1) ?? 0n).toString(),
      ourCreditToThem: derived.peerCreditLimit.toString(),
      policy: policy
        ? {
            policyVersion: policy.policyVersion,
            baseFee: policy.baseFee.toString(),
            gasFee: policy.gasFee.toString(),
            liquidityFeeBps: policy.liquidityFeeBps.toString(),
          }
        : null,
    };
  }, hubId);

type HubLane = Awaited<ReturnType<typeof readHubLane>>;

/** Dollar value of one Home breakdown stat, to the cent. */
async function homeUsd(page: Page, testId: 'home-secured' | 'home-risk'): Promise<number> {
  const text = (await page.getByTestId(testId).textContent()) ?? '';
  const match = text.match(/\$([\d,]+\.\d{2})/);
  if (!match?.[1]) throw new Error(`${testId} shows no dollar amount: ${text}`);
  return Number(match[1].replace(/,/g, ''));
}

/** Integer USDC units as dollars; the wallet prices USDC at a fixed $1 reference. */
const usd = (units: string): number => Number(BigInt(units)) / Number(USDC);

async function openHubAccount(page: Page): Promise<string> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error(`Expected the hub Account page, got ${page.url()}`);
  return hubId;
}

async function settled(page: Page, hubId: string): Promise<HubLane> {
  await expect
    .poll(
      async () => {
        const lane = await readHubLane(page, hubId);
        return { pending: lane.pending, mempool: lane.mempool };
      },
      { timeout: 15_000 },
    )
    .toEqual({ pending: false, mempool: 0 });
  return readHubLane(page, hubId);
}

/** One USDC row of the account's token card ("Collateral", "Their credit line to you", ...). */
const laneRow = (page: Page, label: string) =>
  page.locator('section.card').filter({ hasText: 'USDC' }).locator('.kv').filter({ hasText: label }).locator('.v');

test(
  'Cover it locks hub collateral for the whole uncovered promise; Home moves risk to secured and it survives reload',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const wallet = await enterStack(page);

    await page.getByTestId('home-faucet').click();
    await expect(page.getByTestId('test-money-status')).toContainText('100 USDC received', { timeout: 30_000 });
    await expect.poll(() => homeUsd(page, 'home-risk')).toBe(100);
    expect(await homeUsd(page, 'home-secured')).toBe(0);

    const hubId = await openHubAccount(page);
    const before = await settled(page, hubId);
    expect(before.collateral).toBe('0');
    expect(before.signed).toBe((100n * USDC).toString());
    expect(before.outPeerCredit).toBe((100n * USDC).toString());
    expect(before.policy, 'hub fee policy committed on the account').not.toBeNull();
    const policy = before.policy!;
    await expect(page.getByTestId('account-exposure')).toContainText('$100.00');

    await page.getByTestId('account-cover').click();
    await expect(page.getByTestId('manage-tab-collateral')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('collateral-cover-promise').click();
    const grossText = await page.getByTestId('collateral-amount').inputValue();
    const gross = parseUnits(grossText, 6);
    // Exact cover: the request is the uncovered promise itself, so the prepaid fee and the
    // hub's remaining debt shrink together and no pending tail is left behind.
    expect(gross).toBe(100n * USDC);
    const fee = BigInt(policy.baseFee) + BigInt(policy.gasFee) + (gross * BigInt(policy.liquidityFeeBps)) / 10_000n;
    expect(fee).toBeGreaterThan(0n);
    expect(gross).toBeGreaterThan(fee);
    console.log(`COLLATERAL_REQUEST ${safeStringify({ gross: gross.toString(), fee: fee.toString(), policy })}`);
    await expect(page.getByTestId('collateral-request')).toBeEnabled();
    await page.getByTestId('collateral-request').click();
    await expect(page.getByTestId('collateral-request')).toHaveCount(0, { timeout: 15_000 });

    // The fee is prepaid off-chain out of what the hub owes us; the hub then locks on-chain
    // collateral for exactly the remaining debt, so nothing it owes is left uncovered.
    await expect
      .poll(
        async () => {
          const lane = await readHubLane(page, hubId);
          return {
            collateral: lane.collateral,
            signed: lane.signed,
            outCollateral: lane.outCollateral,
            outPeerCredit: lane.outPeerCredit,
            requestedCollateral: lane.requestedCollateral,
            pending: lane.pending,
            mempool: lane.mempool,
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({
        collateral: (100n * USDC - fee).toString(),
        signed: (100n * USDC - fee).toString(),
        outCollateral: (100n * USDC - fee).toString(),
        outPeerCredit: '0',
        requestedCollateral: '0',
        pending: false,
        mempool: 0,
      });
    const covered = await readHubLane(page, hubId);
    expect(covered.accountHeight).toBeGreaterThan(before.accountHeight);
    console.log(`COLLATERAL_COVERED ${safeStringify({ before, covered })}`);
    await expect(page.getByTestId('account-exposure')).toContainText('$0.00');
    await expect(page.getByTestId('account-cover')).toHaveCount(0);

    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await expect.poll(() => homeUsd(page, 'home-risk'), { timeout: 15_000 }).toBe(0);
    const secured = await homeUsd(page, 'home-secured');
    expect(secured).toBeGreaterThan(99);
    expect(Math.abs(secured - usd(covered.signed))).toBeLessThan(0.006);

    await page.reload();
    await reopenStack(page, wallet);
    await expect.poll(() => homeUsd(page, 'home-secured'), { timeout: 30_000 }).toBe(secured);
    expect(await homeUsd(page, 'home-risk')).toBe(0);
    const restored = await readHubLane(page, hubId);
    expect({
      collateral: restored.collateral,
      ondelta: restored.ondelta,
      offdelta: restored.offdelta,
      signed: restored.signed,
      outPeerCredit: restored.outPeerCredit,
    }).toEqual({
      collateral: covered.collateral,
      ondelta: covered.ondelta,
      offdelta: covered.offdelta,
      signed: covered.signed,
      outPeerCredit: covered.outPeerCredit,
    });
    await openHubAccount(page);
    await expect(page.getByTestId('account-exposure')).toContainText('$0.00');
    expect(pageErrors, 'no uncaught browser errors during the flow').toEqual([]);
  },
);

test(
  'Manage credit tab asks the hub for a credit line and the committed line shows on the account',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const wallet = await enterStack(page);
    const hubId = await openHubAccount(page);
    const before = await settled(page, hubId);
    expect(before.theirCreditToUs).toBe('0');

    await page.getByTestId('account-manage').click();
    await page.getByTestId('manage-tab-credit').click();
    await expect(page.getByTestId('manage-tab-credit')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('credit-amount').fill('50');
    // The request is our signed `credit_request` inside the Account, never an
    // HTTP call: the hub answers with its own line after that frame commits.
    const httpCreditCalls: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/credit')) httpCreditCalls.push(request.url());
    });
    await page.getByTestId('credit-request').click();
    await expect(page.getByTestId('credit-request')).toHaveCount(0, { timeout: 15_000 });

    await expect
      .poll(
        async () => {
          const lane = await readHubLane(page, hubId);
          return { theirCreditToUs: lane.theirCreditToUs, pending: lane.pending, mempool: lane.mempool };
        },
        { timeout: 20_000 },
      )
      .toEqual({ theirCreditToUs: (50n * USDC).toString(), pending: false, mempool: 0 });
    const credited = await readHubLane(page, hubId);
    // A credit line changes capacity only: nothing is owed and no collateral moves.
    expect(credited.signed).toBe(before.signed);
    expect(credited.collateral).toBe(before.collateral);
    expect(credited.ourCreditToThem).toBe(before.ourCreditToThem);
    await expect(laneRow(page, 'Their credit line to you')).toHaveText('50.00');
    expect(httpCreditCalls, 'credit requests never use an HTTP endpoint').toEqual([]);

    await page.reload();
    await reopenStack(page, wallet);
    await openHubAccount(page);
    await expect(laneRow(page, 'Their credit line to you')).toHaveText('50.00', { timeout: 30_000 });
    expect((await readHubLane(page, hubId)).theirCreditToUs).toBe((50n * USDC).toString());
    expect(pageErrors, 'no uncaught browser errors during the flow').toEqual([]);
  },
);
