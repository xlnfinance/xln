import { expect, test } from '@playwright/test';
import { enterStack, reopenStack } from './stack';
import { verifyRestingSwapCancellation } from './swap-cancellation';

test(
  'mobile resting swap survives reload and cancellation restores exact spendable funds',
  { tag: '@resilience' },
  async ({ page }, info) => {
    test.setTimeout(60_000);
    await verifyRestingSwapCancellation(page, info, expect, async () => {
      const wallet = await enterStack(page);
      return () => reopenStack(page, wallet);
    });
  },
);
