import { allowBrowserIssue, expect, test } from '../../global-setup.mts';
import { resolveRuntimeImportAppUrl } from '../../utils/runtime/e2e-runtime-import';
import { API_BASE_URL, APP_BASE_URL } from '../../utils/e2e-baseline';

test('browser console errors enter the shared unread incident service', { tag: '@functional' }, async ({ page }) => {
  const importUrl = await resolveRuntimeImportAppUrl(page, {
    appBaseUrl: APP_BASE_URL, apiBaseUrl: API_BASE_URL, access: 'admin',
  });
  await page.goto(importUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const view = window as typeof window & {
      __xln?: { adapter?: { status(): { connected: boolean; authLevel?: string | null } } };
    };
    const status = view.__xln?.adapter?.status();
    return status?.connected === true && status.authLevel === 'admin';
  }, null, { timeout: 10_000 });
  allowBrowserIssue({
    type: 'console',
    severity: 'error',
    message: 'E2E_BROWSER_TELEMETRY_PROBE',
  });
  await page.evaluate(() => {
    console.error('E2E_BROWSER_TELEMETRY_PROBE');
  });

  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${API_BASE_URL}/api/debug/incidents?state=unread&limit=1000`);
        if (!response.ok()) return null;
        const body = (await response.json()) as {
          incidents?: Array<Record<string, unknown>>;
        };
        return (
          body.incidents?.find(
            candidate => candidate['source'] === 'browser' && candidate['message'] === 'E2E_BROWSER_TELEMETRY_PROBE',
          ) ?? null
        );
      },
      {
        timeout: 10_000,
        intervals: [100, 250, 500],
        message: 'browser console error must reach the shared incident registry',
      },
    )
    .not.toBeNull();

  const response = await page.request.get(`${API_BASE_URL}/api/debug/incidents?state=unread&limit=1000`);
  const body = (await response.json()) as {
    incidents: Array<Record<string, unknown>>;
  };
  const stored = body.incidents.find(candidate => candidate['message'] === 'E2E_BROWSER_TELEMETRY_PROBE');
  expect(stored).toMatchObject({
    state: 'unread',
    source: 'browser',
    code: 'CONSOLE_ERROR',
    count: 1,
  });
  expect(stored?.['sample']).toBeUndefined();
});
