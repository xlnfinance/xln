import { test, expect, type Page } from '@playwright/test';
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
