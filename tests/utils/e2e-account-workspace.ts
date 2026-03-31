import { expect, type Page } from '@playwright/test';

export type AccountWorkspaceTabId =
  | 'open'
  | 'send'
  | 'receive'
  | 'swap'
  | 'move'
  | 'history'
  | 'configure'
  | 'activity'
  | 'appearance';

export async function clickWithDialogAccept(
  page: Page,
  action: () => Promise<void>,
): Promise<Array<{ type: string; message: string }>> {
  const dialogs: Array<{ type: string; message: string }> = [];
  const onDialog = async (dialog: { type: () => string; message: () => string; accept: () => Promise<void> }) => {
    dialogs.push({
      type: String(dialog.type() || 'unknown'),
      message: String(dialog.message() || ''),
    });
    await dialog.accept();
  };
  page.on('dialog', onDialog);
  try {
    await action();
  } finally {
    page.off('dialog', onDialog);
  }
  return dialogs;
}

export async function openAccountWorkspaceTab(page: Page, tabId: AccountWorkspaceTabId): Promise<void> {
  const targetTab = page.locator(`[data-testid="account-workspace-tab-${tabId}"]:visible`).first();
  const backButton = page.locator('[data-testid="account-panel-back"]:visible').first();
  const accountsTab = page.locator('[data-testid="tab-accounts"]:visible').first();
  const mobileToggle = page.getByTestId('account-workspace-mobile-toggle').first();

  const focusedAccountVisible = await backButton.waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true)
    .catch(() => false);
  if (focusedAccountVisible) {
    await backButton.click({ force: true });
    await expect(backButton).not.toBeVisible({ timeout: 20_000 });
  }

  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();
  const tabVisible = await targetTab.isVisible({ timeout: 1_000 }).catch(() => false);
  if (!tabVisible && await mobileToggle.isVisible().catch(() => false)) {
    await mobileToggle.click();
  }
  await expect(targetTab).toBeVisible({ timeout: 20_000 });
  await targetTab.click();
}

export async function selectEntityInputOption(
  page: Page,
  testId: string,
  entityId: string,
): Promise<void> {
  const root = page.locator(`[data-testid="${testId}"]:visible`).first();
  await expect(root).toBeVisible({ timeout: 20_000 });
  const trigger = root.locator('.closed-trigger, .dropdown-toggle').first();
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await trigger.click();
  const option = page.getByTestId(`${testId}-option-${entityId.toLowerCase()}`).first();
  await expect(option).toBeVisible({ timeout: 20_000 });
  await option.click();
}

function getCompactEntityId(entityId: string): string {
  const canonical = String(entityId || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(canonical)) return canonical;
  return `${canonical.slice(0, 10)}...${canonical.slice(-6)}`;
}

async function entityInputHasSelection(
  page: Page,
  testId: string,
  entityId: string,
): Promise<boolean> {
  const root = page.locator(`[data-testid="${testId}"]:visible`).first();
  const trigger = root.locator('.closed-trigger, .dropdown-toggle').first();
  const text = String(await trigger.textContent().catch(() => '') || '').trim().toLowerCase();
  if (!text) return false;
  const canonical = String(entityId || '').trim().toLowerCase();
  if (!canonical) return false;
  const compact = getCompactEntityId(canonical);
  return text.includes(canonical) || text.includes(compact);
}

export async function startDisputeFromManageUi(
  page: Page,
  counterpartyId: string,
  waitUntilQueued: () => Promise<boolean>,
): Promise<void> {
  await queueDisputeActionFromManageUi(page, counterpartyId, 'start', waitUntilQueued);
}

export async function finalizeDisputeFromManageUi(
  page: Page,
  counterpartyId: string,
  waitUntilQueued: () => Promise<boolean>,
): Promise<void> {
  await queueDisputeActionFromManageUi(page, counterpartyId, 'finalize', waitUntilQueued);
}

async function queueDisputeActionFromManageUi(
  page: Page,
  counterpartyId: string,
  action: 'start' | 'finalize',
  waitUntilQueued: () => Promise<boolean>,
): Promise<void> {
  const buttonTestId = action === 'start'
    ? 'configure-dispute-start'
    : 'configure-dispute-finalize';
  const visibleBackButton = page.locator('[data-testid="account-panel-back"]:visible').first();
  const focusedAccountVisible = await visibleBackButton.waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true)
    .catch(() => false);
  if (focusedAccountVisible) {
    await visibleBackButton.click({ force: true });
    await expect(visibleBackButton).not.toBeVisible({ timeout: 20_000 });
  }

  const accountsTab = page.locator('[data-testid="tab-accounts"]:visible').first();
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();

  const manageTab = page.locator('[data-testid="account-workspace-tab-configure"]:visible').first();
  const manageVisible = await manageTab.isVisible({ timeout: 1_500 }).catch(() => false);
  if (!manageVisible) {
    const lateFocusedAccount = await visibleBackButton.waitFor({ state: 'visible', timeout: 1_500 })
      .then(() => true)
      .catch(() => false);
    if (lateFocusedAccount) {
      await visibleBackButton.click({ force: true });
      await expect(visibleBackButton).not.toBeVisible({ timeout: 20_000 });
      await expect(accountsTab).toBeVisible({ timeout: 20_000 });
      await accountsTab.click();
    }
  }
  await expect(manageTab).toBeVisible({ timeout: 20_000 });
  await manageTab.click();

  const disputeTab = page.locator('[data-testid="configure-tab-dispute"]:visible').first();
  await expect(disputeTab).toBeVisible({ timeout: 20_000 });
  await disputeTab.click();

  const disputeButton = page.locator(`[data-testid="${buttonTestId}"]:visible`).first();
  const selectedCounterparty = await entityInputHasSelection(page, 'configure-account-selector', counterpartyId);
  if (!selectedCounterparty) {
    await selectEntityInputOption(page, 'configure-account-selector', counterpartyId);
    await expect(disputeTab).toBeVisible({ timeout: 20_000 });
    await disputeTab.click();
  }

  await expect(disputeButton).toBeVisible({ timeout: 20_000 });
  await expect(disputeButton).toBeEnabled({ timeout: 20_000 });

  const dialogs = await clickWithDialogAccept(page, async () => {
    await disputeButton.click();
  });
  const alertDialog = dialogs.find((entry) => entry.type === 'alert');
  if (alertDialog) {
    throw new Error(`dispute ${action} alert: ${alertDialog.message}`);
  }

  await expect.poll(waitUntilQueued, {
    timeout: 15_000,
    intervals: [500, 1000, 2000],
  }).toBe(true);
}
