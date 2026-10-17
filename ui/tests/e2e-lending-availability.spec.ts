import { expect, test } from '@playwright/test';
import { verifyDeferredLending } from './lending-availability';
import { enterStack } from './stack';

test(
  'deferred lending disables new commands and leaves the wallet able to pay',
  { tag: '@functional' },
  async ({ page }, info) => {
    test.setTimeout(50_000);
    await verifyDeferredLending(page, info, expect, () => enterStack(page));
  },
);
