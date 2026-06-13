import { test, expect, type Page } from '@playwright/test';
import { deriveDelta } from '../runtime/account-utils';
import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline } from './utils/e2e-baseline';
import { connectRuntimeToHubWithCredit } from './utils/e2e-connect';
import {
  createRuntime,
  getActiveEntity,
  gotoApp,
  selectDemoMnemonic,
} from './utils/e2e-demo-users';

type LendingStateResponse = {
  success?: boolean;
  error?: string;
  pools?: Array<{
    positionId: string;
    availableAmount: string;
    borrowedAmount: string;
    status: string;
  }>;
  loans?: Array<{
    loanId: string;
    repaymentAmount: string;
    status: string;
  }>;
};

const TOKEN_ID = 1;

const tokenAmount = (whole: bigint): string => (whole * 10n ** 18n).toString();

type DeltaSnapshot = {
  ondelta: string;
  offdelta: string;
  collateral: string;
  leftCreditLimit: string;
  rightCreditLimit: string;
  leftAllowance: string;
  rightAllowance: string;
  leftHold: string;
  rightHold: string;
};

async function faucetOffchain(
  page: Page,
  entityId: string,
  hubEntityId: string,
  tokenId: number,
  amount: string,
): Promise<void> {
  let ok = false;
  let lastBody: Record<string, unknown> = { error: 'not-run' };

  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const runtimeId = await page.evaluate(() => String((window as any).isolatedEnv?.runtimeId || ''));
    expect(runtimeId, 'runtimeId must exist before faucet').toBeTruthy();

    const response = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
      data: {
        userEntityId: entityId,
        userRuntimeId: runtimeId,
        hubEntityId,
        tokenId,
        amount,
      },
    });
    lastBody = await response.json().catch(() => ({} as Record<string, unknown>));
    ok = response.status() === 200;
    if (ok) return;

    const code = String(lastBody.code || '');
    const transient =
      response.status() === 202 ||
      response.status() === 503 ||
      code === 'FAUCET_TOKEN_SURFACE_NOT_READY' ||
      code === 'FAUCET_ACCOUNT_NOT_OPEN' ||
      code === 'FAUCET_ACCOUNT_NOT_READY';
    if (!transient) break;
    await page.waitForTimeout(500);
  }

  expect(ok, `offchain faucet failed: ${JSON.stringify(lastBody)}`).toBe(true);
}

async function accountOutCapacity(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
): Promise<bigint> {
  const delta = await page.evaluate(({ counterpartyId, entityId, tokenId }) => {
    const view = window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, {
          state?: {
            accounts?: Map<string, { deltas?: Map<number, unknown> }>;
          };
        }>;
      };
    };
    const env = view.isolatedEnv;
    if (!env?.eReplicas) return null;

    const entityKey = String(entityId || '').toLowerCase();
    const accountKey = String(counterpartyId || '').toLowerCase();
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      if (!String(replicaKey).toLowerCase().startsWith(`${entityKey}:`)) continue;
      const account = replica.state?.accounts?.get(accountKey) ?? replica.state?.accounts?.get(counterpartyId);
      const delta = account?.deltas?.get(tokenId);
      if (!delta || typeof delta !== 'object') return null;
      const raw = delta as Record<string, unknown>;
      const readBig = (value: unknown): string => {
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return String(value);
        if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return value.trim();
        return '0';
      };
      return {
        ondelta: readBig(raw.ondelta),
        offdelta: readBig(raw.offdelta),
        collateral: readBig(raw.collateral),
        leftCreditLimit: readBig(raw.leftCreditLimit),
        rightCreditLimit: readBig(raw.rightCreditLimit),
        leftAllowance: readBig(raw.leftAllowance),
        rightAllowance: readBig(raw.rightAllowance),
        leftHold: readBig(raw.leftHold),
        rightHold: readBig(raw.rightHold),
      } satisfies DeltaSnapshot;
    }

    return null;
  }, { counterpartyId, entityId, tokenId });

  if (!delta) return 0n;
  return deriveDelta({
    tokenId,
    ondelta: BigInt(delta.ondelta),
    offdelta: BigInt(delta.offdelta),
    collateral: BigInt(delta.collateral),
    leftCreditLimit: BigInt(delta.leftCreditLimit),
    rightCreditLimit: BigInt(delta.rightCreditLimit),
    leftAllowance: BigInt(delta.leftAllowance),
    rightAllowance: BigInt(delta.rightAllowance),
    leftHold: BigInt(delta.leftHold),
    rightHold: BigInt(delta.rightHold),
  }, String(entityId).toLowerCase() < String(counterpartyId).toLowerCase()).outCapacity;
}

async function readLendingState(
  page: Page,
  input: { hubEntityId: string; userEntityId: string },
): Promise<LendingStateResponse> {
  const url = new URL('/api/lending/state', API_BASE_URL);
  url.searchParams.set('hubEntityId', input.hubEntityId);
  url.searchParams.set('userEntityId', input.userEntityId);
  url.searchParams.set('tokenId', String(TOKEN_ID));
  const response = await page.request.get(url.toString());
  const body = await response.json().catch(() => ({})) as LendingStateResponse;
  expect(response.ok(), `lending state failed: ${JSON.stringify(body)}`).toBe(true);
  return body;
}

async function waitForLendingState(
  page: Page,
  input: { hubEntityId: string; userEntityId: string },
  predicate: (state: LendingStateResponse) => boolean,
  message: string,
): Promise<LendingStateResponse> {
  await expect
    .poll(async () => {
      const state = await readLendingState(page, input);
      return predicate(state);
    }, {
      timeout: 45_000,
      intervals: [250, 500, 1000],
      message,
    })
    .toBe(true);
  return await readLendingState(page, input);
}

async function openLendingWorkspace(page: Page): Promise<void> {
  await page.getByTestId('tab-accounts').first().click();
  const lendingTab = page.getByTestId('account-workspace-tab-lending').first();
  await expect(lendingTab).toBeVisible({ timeout: 20_000 });
  await lendingTab.click();
  await expect(page.getByTestId('lending-panel').first()).toBeVisible({ timeout: 20_000 });
}

test.describe('E2E Lending Flow', () => {
  test('funds hub pool, borrows from it, and repays from the Lending tab', async ({ page }) => {
    test.setTimeout(180_000);

    const health = await ensureE2EBaseline(page, {
      timeoutMs: 180_000,
      requireHubMesh: true,
      requireMarketMaker: false,
      minHubCount: 1,
    });
    const hubId = health.hubMesh?.hubIds?.[0] || health.hubs?.[0]?.entityId || '';
    expect(hubId, 'baseline must expose a hub').toMatch(/^0x[a-fA-F0-9]{64}$/);

    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 45_000, settleMs: 500 });
    await createRuntime(page, 'lending-alice', selectDemoMnemonic('alice'), {
      fresh: true,
      requireOnline: true,
    });
    const identity = await getActiveEntity(page);
    expect(identity?.entityId, 'runtime entity must be selected').toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(identity?.signerId, 'runtime signer must be selected').toMatch(/^0x[a-fA-F0-9]{40}$/);

    await connectRuntimeToHubWithCredit(
      page,
      { entityId: identity!.entityId, signerId: identity!.signerId },
      hubId,
      '10000',
      [TOKEN_ID],
      { requireOnline: true },
    );
    await faucetOffchain(page, identity!.entityId, hubId, TOKEN_ID, '2000');
    await expect
      .poll(
        async () => (await accountOutCapacity(page, identity!.entityId, hubId, TOKEN_ID)) >= BigInt(tokenAmount(1000n)),
        {
          timeout: 45_000,
          intervals: [250, 500, 1000],
          message: 'lender must have outbound USDC before funding a pool',
        },
      )
      .toBe(true);

    await openLendingWorkspace(page);
    await expect(page.getByTestId('lending-available').first()).toBeVisible();

    const offerForm = page.getByTestId('lending-offer-form').first();
    await offerForm.locator('input[placeholder="Amount"]').fill('1000');
    await offerForm.getByTestId('lending-offer-term').selectOption('1d');
    await offerForm.getByTestId('lending-offer-rate').fill('100');
    await offerForm.getByTestId('lending-offer-submit').click();

    await waitForLendingState(
      page,
      { hubEntityId: hubId, userEntityId: identity!.entityId },
      (state) => (state.pools ?? []).some((pool) =>
        pool.status === 'open' &&
        BigInt(pool.availableAmount) >= BigInt(tokenAmount(1000n))
      ),
      'funded lending pool must enter hub state',
    );
    await page.getByTestId('lending-refresh').click();
    await expect(page.getByTestId('lending-pool-row').first()).toContainText('1d', { timeout: 20_000 });

    const borrowForm = page.getByTestId('lending-borrow-form').first();
    await borrowForm.locator('input[placeholder="Amount"]').fill('100');
    await borrowForm.getByTestId('lending-borrow-term').selectOption('1d');
    await borrowForm.getByTestId('lending-borrow-max-rate').fill('150');
    await borrowForm.getByTestId('lending-borrow-submit').click();

    const borrowedState = await waitForLendingState(
      page,
      { hubEntityId: hubId, userEntityId: identity!.entityId },
      (state) => (state.loans ?? []).some((loan) => loan.status === 'active'),
      'borrowed loan must become active in hub state',
    );
    const activeLoan = borrowedState.loans?.find((loan) => loan.status === 'active');
    expect(activeLoan?.repaymentAmount).toBe(tokenAmount(101n));
    await page.getByTestId('lending-refresh').click();
    await expect(page.getByTestId('lending-loan-row').first()).toContainText('1d', { timeout: 20_000 });

    await page.getByTestId('lending-repay-submit').first().click();
    await waitForLendingState(
      page,
      { hubEntityId: hubId, userEntityId: identity!.entityId },
      (state) => (state.loans ?? []).some((loan) => loan.status === 'repaid'),
      'repay must close the loan in hub state',
    );
    await page.getByTestId('lending-refresh').click();
    await expect(page.getByTestId('lending-loans').first()).toContainText('No active loans', { timeout: 20_000 });
  });
});
