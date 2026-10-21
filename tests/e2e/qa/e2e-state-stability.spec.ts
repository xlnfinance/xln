import { expect, test } from '../../global-setup.mts';
import { HDNodeWallet } from 'ethers';
import { gotoApp } from '../../utils/e2e-demo-users';
import { createWalletIdentity } from '../../../ui/tests/wallet-ui';
import type { RuntimeReplica } from '../../../core/runtime/types';
import { waitForNamedHubs } from '../../utils/e2e-baseline';
import { connectRuntimeToHub } from '../../utils/e2e-connect';
import { requireIsolatedBaseUrl } from '../../utils/runtime/e2e-isolated-env';
import { enqueueEntityTxs } from '../../utils/runtime/e2e-runtime-input';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const API_BASE_URL = requireIsolatedBaseUrl('E2E_API_BASE_URL');

test(
  'Svelte account status survives committed runtime refreshes',
  { tag: '@functional' },
  async ({ page }, testInfo) => {
    test.setTimeout(55_000);
    // Retain the original catalog identity; React is the sole current wallet.
    const phrase = HDNodeWallet.createRandom().mnemonic!.phrase;
    await gotoApp(page, { appBaseUrl: APP_BASE_URL });
    const identity = await createWalletIdentity(page, 'State audit', phrase);
    const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
    await connectRuntimeToHub(page, identity, hubs.h1!);
    const rowSelector = `[data-testid="account-row"][data-counterparty-id="${hubs.h1}"]`;
    await expect(page.locator(rowSelector)).toContainText('Payment connection');
    for (const phase of ['home', 'account'] as const) {
      if (phase === 'account') await page.locator(rowSelector).click();
      const selector = phase === 'home' ? rowSelector : '[data-testid="account-status"]';
      await expect(page.locator(selector)).toHaveCount(1);
      await expect(page.locator(selector)).toContainText(phase === 'home' ? 'Payment connection' : 'Open');
      const observation = page.evaluate(
        async ({ selector, phase }) => {
          const live = window as typeof window & {
            __e2eStateObserverReady?: string;
            __xln: { env(): RuntimeReplica; store: { getState(): { height: number } } };
          };
          const env = live.__xln.env();
          const firstHeight = env.state.height;
          const firstUiHeight = live.__xln.store.getState().height;
          const sample = () =>
            Array.from(document.querySelectorAll(selector), element => ({
              text: element.textContent?.trim(),
              status: element.className,
            }));
          const states = [JSON.stringify(sample())];
          const observer = new MutationObserver(() => states.push(JSON.stringify(sample())));
          observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
          live.__e2eStateObserverReady = phase;
          await new Promise(resolve => setTimeout(resolve, 3_000));
          observer.disconnect();
          return {
            samples: states.length,
            firstHeight,
            lastHeight: env.state.height,
            firstUiHeight,
            lastUiHeight: live.__xln.store.getState().height,
            states: [...new Set(states)],
          };
        },
        { selector, phase },
      );
      await page.waitForFunction(
        phase => (window as typeof window & { __e2eStateObserverReady?: string }).__e2eStateObserverReady === phase,
        phase,
      );
      await enqueueEntityTxs(page, identity.entityId, identity.signerId, [
        { type: 'chat', data: { from: identity.signerId, message: `Committed state stability check: ${phase}` } },
      ]);
      const observed = await observation;
      console.log(`REACT_STATE_OBSERVATION ${phase} ${JSON.stringify(observed)}`);
      expect(observed.lastHeight).toBeGreaterThan(observed.firstHeight);
      expect(observed.lastUiHeight).toBeGreaterThan(observed.firstUiHeight);
      expect(observed.states).toHaveLength(1);
    }
    await page.screenshot({
      path: testInfo.outputPath('react-account-status-after-commits.png'),
      animations: 'disabled',
    });
  },
);
