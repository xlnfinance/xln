import { expect, test } from '../../global-setup.mts';
import { HDNodeWallet } from 'ethers';
import { gotoApp, createRuntimeIdentity } from '../../utils/e2e-demo-users';
import { waitForNamedHubs } from '../../utils/e2e-baseline';
import { connectRuntimeToHub } from '../../utils/e2e-connect';
import { requireIsolatedBaseUrl } from '../../utils/runtime/e2e-isolated-env';
import { enqueueEntityTxs } from '../../utils/runtime/e2e-runtime-input';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const API_BASE_URL = requireIsolatedBaseUrl('E2E_API_BASE_URL');

test('Svelte account status survives committed runtime refreshes', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(55_000);
    const phrase = HDNodeWallet.createRandom().mnemonic!.phrase;
    await gotoApp(page, { appBaseUrl: APP_BASE_URL });
    const identity = await createRuntimeIdentity(page, 'State audit', phrase);
    const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
    await connectRuntimeToHub(page, identity, hubs.h1!);
    await expect(page.getByTestId('account-status-indicator').first()).toBeVisible();
    await expect(page.locator(`[data-testid="hub-discovery-card"][data-hub-entity-id="${hubs.h1}"]`)).toHaveAttribute(
      'data-connection-state',
      'open',
    );
    // Observe committed refreshes after the independent transport connection has settled.
    await expect(page.getByTestId('account-status-indicator').first()).toHaveAttribute('data-ui-status', 'ready');
    await expect(page.getByTestId('account-status-indicator').first()).toHaveAttribute('data-connection-state', 'connected');
    const observation = page.evaluate(async () => {
      const sample = () => ({
        accounts: Array.from(document.querySelectorAll('[data-testid="account-status-indicator"]'), element => ({
          text: element.textContent?.trim(),
          status: element.className,
        })),
        hubs: Array.from(document.querySelectorAll('[data-testid="hub-discovery-card"]'), element => ({
          id: element.getAttribute('data-hub-entity-id'),
          state: element.getAttribute('data-connection-state'),
        })),
      });
      const live = window as typeof window & { isolatedEnv: { state: { height: number } } };
      const firstHeight = live.isolatedEnv.state.height;
      const first = sample();
      const states: string[] = [JSON.stringify(first)];
      const observer = new MutationObserver(() => states.push(JSON.stringify(sample())));
      observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
      (window as typeof window & { __e2eStateObserverReady?: boolean }).__e2eStateObserverReady = true;
      await new Promise(resolve => setTimeout(resolve, 3_000));
      observer.disconnect();
      return {
        samples: states.length,
        firstHeight,
        lastHeight: live.isolatedEnv.state.height,
        states: [...new Set(states)],
      };
    });
    await page.waitForFunction(() => (window as typeof window & { __e2eStateObserverReady?: boolean }).__e2eStateObserverReady === true);
    await enqueueEntityTxs(page, identity.entityId, identity.signerId, [{
      type: 'chat',
      data: { from: identity.signerId, message: 'Committed state stability check' },
    }]);
    const observed = await observation;
    console.log(`SVELTE_STATE_OBSERVATION ${JSON.stringify(observed)}`);
    expect(observed.lastHeight).toBeGreaterThan(observed.firstHeight);
    expect(observed.states).toHaveLength(1);
});
