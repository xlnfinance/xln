import { expect, test } from '@playwright/test';

test('React Strict Mode consumes the canonical external store without leaks', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const harness = await import('/packages/react-adapters/testing/external-store-harness.tsx');
    const container = document.createElement('div');
    document.body.append(container);
    return harness.runExternalStoreHarness(container);
  });

  expect(result.activeAfterMount).toBe(1);
  expect(result.maxActiveSubscriptions).toBe(1);
  expect(result.renderedAfterUpdate).toBe('1');
  expect(result.rendersAfterNoOp).toBe(result.rendersBeforeNoOp);
  expect(result.activeAfterUnmount).toBe(0);
  expect(result.cleanupCount).toBe(result.subscribeCount);
});
