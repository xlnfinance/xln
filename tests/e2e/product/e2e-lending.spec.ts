import { Wallet } from 'ethers';
import { expect, test } from '../../global-setup.mts';
import { verifyDeferredLending } from '../../../ui/tests/lending-availability';
import { createWalletIdentity } from '../../../ui/tests/wallet-ui';
import { APP_BASE_URL, gotoApp } from '../../utils/e2e-demo-users';

test(
  'deferred lending disables new commands and leaves the wallet able to pay',
  { tag: '@functional' },
  async ({ page }, info) => {
    test.setTimeout(50_000);
    await verifyDeferredLending(page, info, expect, async () => {
      await gotoApp(page, { appBaseUrl: APP_BASE_URL, settleMs: 0 });
      const phrase = Wallet.createRandom().mnemonic?.phrase;
      if (!phrase) throw new Error('TEST_WALLET_MNEMONIC_MISSING');
      const wallet = await createWalletIdentity(page, 'deferred-lending', phrase);
      await expect(page.getByTestId('account-row').first()).toBeVisible();
      return wallet;
    });
  },
);
