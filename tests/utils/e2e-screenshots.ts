import type { Locator, Page, TestInfo } from '@playwright/test';

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '-');
}

export async function capturePageScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { fullPage?: boolean } = {},
): Promise<void> {
  await page.screenshot({
    path: testInfo.outputPath(normalizeName(name)),
    fullPage: options.fullPage ?? true,
  });
}

export async function captureLocatorScreenshot(
  locator: Locator,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await locator.screenshot({
    path: testInfo.outputPath(normalizeName(name)),
  });
}
