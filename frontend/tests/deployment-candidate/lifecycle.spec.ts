import { expect, test, type APIResponse, type Page } from '@playwright/test';

type DeploymentRelease = Readonly<{
  releaseId: string;
  fileCount: number;
  walletEntrySha256: string;
  docsEntrySha256: string;
}>;

type DeploymentState = Readonly<{
  selection: Readonly<{
    schemaVersion: 1;
    activeReleaseId: string;
    rollbackReleaseId: string | null;
  }>;
  releases: readonly DeploymentRelease[];
}>;

const state = async (page: Page): Promise<DeploymentState> => {
  const response = await page.request.get('/__xln-deployment/state');
  expect(response.ok()).toBe(true);
  return response.json() as Promise<DeploymentState>;
};

const control = async (page: Page, path: string, expectedStatus = 200): Promise<APIResponse> => {
  const response = await page.request.post(path);
  expect(response.status()).toBe(expectedStatus);
  return response;
};

test('selects, rejects, activates, and rolls back immutable releases at one origin', async ({ page }) => {
  test.setTimeout(120_000);
  const consoleFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') consoleFailures.push(message.text());
  });
  page.on('pageerror', (error) => consoleFailures.push(error.message));

  const initial = await state(page);
  expect(initial.releases).toHaveLength(2);
  const install = initial.releases[0];
  const update = initial.releases[1];
  if (!install || !update) throw new Error('DEPLOYMENT_TEST_RELEASE_PAIR_REQUIRED');
  expect(initial.selection).toEqual({
    schemaVersion: 1,
    activeReleaseId: install.releaseId,
    rollbackReleaseId: null,
  });
  const installedPage = await page.goto('/app');
  expect(installedPage?.status()).toBe(200);
  expect(installedPage?.headers()['x-xln-deployment-release']).toBe(install.releaseId);
  expect(installedPage?.headers()['x-xln-content-sha256']).toBe(install.walletEntrySha256);
  await expect(page).toHaveTitle('xln Wallet');

  const corrupt = await control(page, '/__xln-deployment/activate-corrupt', 409);
  expect(await corrupt.text()).toContain('CANDIDATE_RELEASE_FILE_SET_MISMATCH');
  expect((await state(page)).selection.activeReleaseId).toBe(install.releaseId);

  await control(page, '/__xln-deployment/activate-update');
  const updated = await state(page);
  expect(updated.selection.activeReleaseId).toBe(update.releaseId);
  expect(updated.selection.rollbackReleaseId).toBe(install.releaseId);
  const docsPage = await page.goto('/docs');
  expect(docsPage?.status()).toBe(200);
  expect(docsPage?.headers()['x-xln-deployment-release']).toBe(update.releaseId);
  expect(docsPage?.headers()['x-xln-content-sha256']).toBe(update.docsEntrySha256);
  await expect(page).toHaveTitle('xln documentation | xln docs');

  const duplicate = await control(page, '/__xln-deployment/activate-update', 409);
  expect(await duplicate.text()).toContain('DEPLOYMENT_CANDIDATE_ALREADY_ACTIVE');
  expect((await state(page)).selection).toEqual(updated.selection);

  await control(page, '/__xln-deployment/rollback');
  const rolledBack = await state(page);
  expect(rolledBack.selection.activeReleaseId).toBe(install.releaseId);
  expect(rolledBack.selection.rollbackReleaseId).toBe(update.releaseId);
  const restoredPage = await page.goto('/app');
  expect(restoredPage?.headers()['x-xln-deployment-release']).toBe(install.releaseId);
  expect(restoredPage?.headers()['x-xln-content-sha256']).toBe(install.walletEntrySha256);
  expect(consoleFailures).toEqual([]);
});
