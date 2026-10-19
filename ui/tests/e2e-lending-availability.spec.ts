import { expect, test } from '@playwright/test';
import { verifyLendingEntryAndPayment } from './lending-availability';
import { enterStack } from './stack';

test(
  'lending entry rejects zero amounts and leaves the wallet able to pay',
  { tag: '@functional' },
  async ({ page }, info) => {
    test.setTimeout(50_000);
    await verifyLendingEntryAndPayment(page, info, expect, () => enterStack(page));
  },
);
