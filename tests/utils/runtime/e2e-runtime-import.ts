import type { Page } from '@playwright/test';

export const acceptRemoteRuntimeConsent = async (page: Page, timeoutMs = 15_000): Promise<void> => {
  const prompt = page.getByTestId('remote-runtime-login-screen');
  await prompt.waitFor({ state: 'visible', timeout: timeoutMs });
  await prompt.getByRole('button', { name: 'Connect remote runtime' }).click();
  await prompt.waitFor({ state: 'hidden', timeout: timeoutMs });
};

export const resolveRuntimeImportAppUrl = async (
  page: Page,
  options: { appBaseUrl: string; apiBaseUrl: string; access?: 'admin' },
): Promise<string> => {
  const endpoint = new URL('/api/runtime-import', options.appBaseUrl);
  endpoint.searchParams.set('access', options.access ?? 'admin');
  const response = await page.request.get(endpoint.toString(), {
    headers: { 'Cache-Control': 'no-store' },
    timeout: 10_000,
  });
  if (!response.ok()) throw new Error(`RUNTIME_IMPORT_APP_URL_UNAVAILABLE:${response.status()}`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object' || !('importUrl' in payload) || typeof payload.importUrl !== 'string')
    throw new Error('RUNTIME_IMPORT_APP_URL_MISSING');
  const url = new URL(payload.importUrl);
  if (url.pathname !== '/app' || url.search || !url.hash.startsWith('#runtime-import-src='))
    throw new Error('RUNTIME_IMPORT_APP_URL_INVALID');
  return url.toString();
};
