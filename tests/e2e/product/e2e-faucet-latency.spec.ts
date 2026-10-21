import { test, expect, type Page } from '../../global-setup.mts';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../../core/api/public/runtime-module';
import type { RuntimeAdapterInspection } from '../../../ui/src/runtime/adapter';
import { createWalletIdentity } from '../../../ui/tests/wallet-ui';
import { getHealth } from '../../utils/e2e-baseline';
import { connectRuntimeToHubWithCredit } from '../../utils/e2e-connect';
import { gotoApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import { outCap } from '../../utils/runtime/e2e-derived-capacity';
import { getRenderedOutboundForAccount } from '../../utils/runtime/e2e-account-ui';
import { requireIsolatedBaseUrl } from '../../utils/runtime/e2e-isolated-env';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const API_BASE_URL = requireIsolatedBaseUrl('E2E_API_BASE_URL');
const LONG_E2E = process.env.E2E_LONG === '1';
const AMOUNT = 100_000_000n;

type FaucetRenderProbe = { stateChangedMs: number; domVisibleMs: number; stateToDomMs: number };

const renderedBalance = async (page: Page): Promise<number> => {
  const text = (await page.getByTestId('faucet-account-balance').innerText()).replace(/,/g, '').trim();
  const match = text.match(/^(-?\d+(?:\.\d+)?) USDC$/);
  if (!match) throw new Error(`FAUCET_RENDERED_BALANCE_INVALID:${text}`);
  return Number(match[1]);
};

/** Observe the committed view and real DOM; never mutate the Runtime or fabricate a missing delta. */
const measureAccountStateToDomLatency = (
  page: Page,
  entityId: string,
  hubId: string,
  baselineOut: bigint,
  baselineBalance: number,
): Promise<FaucetRenderProbe> =>
  page.evaluate(
    async input => {
      const debug = (
        window as Window & {
          __xln?: { adapter(): RuntimeAdapterInspection | null; xln(): Promise<XLNModule> };
        }
      ).__xln;
      const adapter = debug?.adapter();
      if (!debug || !adapter) throw new Error('FAUCET_CURRENT_RUNTIME_MISSING');
      const xln = await debug.xln();
      const startedAt = performance.now();
      const deadline = startedAt + 15_000;
      let stateChangedAt: number | null = null;
      while (performance.now() < deadline) {
        const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: input.entityId });
        const account = frame.activeEntity?.accounts.items.find(
          row => row.state.leftEntity === input.hubId || row.state.rightEntity === input.hubId,
        );
        const delta = account?.state.deltas.get(1);
        if (!account || !delta) throw new Error('FAUCET_COMMITTED_ACCOUNT_MISSING');
        const capacity = xln.deriveDelta(delta, account.state.leftEntity === input.entityId).outCapacity;
        if (capacity === BigInt(input.baselineOut) + 100_000_000n && stateChangedAt === null) {
          stateChangedAt = performance.now();
        }
        const text = document
          .querySelector('[data-testid="faucet-account-balance"]')
          ?.textContent?.replace(/,/g, '')
          .trim();
        const match = text?.match(/^(-?\d+(?:\.\d+)?) USDC$/);
        if (!match) throw new Error('FAUCET_RENDERED_BALANCE_MISSING');
        if (stateChangedAt !== null && Number(match[1]) === input.baselineBalance + 100) {
          const now = performance.now();
          return {
            stateChangedMs: Math.round(stateChangedAt - startedAt),
            domVisibleMs: Math.round(now - startedAt),
            stateToDomMs: Math.round(now - stateChangedAt),
          };
        }
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      throw new Error('Timed out waiting for committed account state/render transition');
    },
    { entityId, hubId, baselineOut: baselineOut.toString(), baselineBalance },
  );

test.describe('E2E Faucet Latency', () => {
  test(
    'demo account single-hub UI USDC faucet finalizes as fast as possible',
    { tag: '@functional' },
    async ({ page }) => {
      test.setTimeout(LONG_E2E ? 240_000 : 180_000);
      await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 30_000, settleMs: 0 });
      const alice = await createWalletIdentity(page, 'alice', selectDemoMnemonic('alice'));
      const health = await getHealth(page, API_BASE_URL);
      const hubId = health?.hubMesh?.hubIds?.[0];
      if (!hubId || !/^0x[0-9a-f]{64}$/i.test(hubId)) throw new Error('FAUCET_PRIMARY_HUB_MISSING');
      await connectRuntimeToHubWithCredit(page, alice, hubId, '10000', [1]);
      const baselineOut = await outCap(page, alice.entityId, hubId);
      const baselineRenderedOut = await getRenderedOutboundForAccount(page, hubId);

      await page.getByTestId('nav-manage').locator('visible=true').first().click();
      await page.getByTestId('manage-assets').click();
      const faucet = page.getByTestId('faucets');
      await faucet.getByRole('button', { name: 'USDC', exact: true }).click();
      await page.getByTestId('faucet-amount').fill('100');
      const button = page.getByTestId('faucet-offchain');
      await expect(button).toBeEnabled({ timeout: 20_000 });
      const baselineBalance = await renderedBalance(page);
      const startedAt = Date.now();
      const [renderProbe] = await Promise.all([
        measureAccountStateToDomLatency(page, alice.entityId, hubId, baselineOut, baselineBalance),
        (async () => {
          await button.click();
          await expect
            .poll(
              async () => {
                const pending = await button.textContent();
                const status = page.getByTestId('faucet-status');
                return (
                  pending === 'Asking…' ||
                  ((await status.isVisible()) && (await status.getAttribute('role')) === 'status') ||
                  (await renderedBalance(page)) > baselineBalance
                );
              },
              {
                timeout: 1_000,
                intervals: [25, 50, 100],
                message: 'faucet click must produce immediate visible feedback',
              },
            )
            .toBe(true);
          await expect
            .poll(() => renderedBalance(page), {
              timeout: 15_000,
              intervals: [10, 20, 25, 50, 100],
              message: 'UI USDC faucet must become visible on the funding screen',
            })
            .toBe(baselineBalance + 100);
        })(),
      ]);
      const elapsedMs = Date.now() - startedAt;
      console.log(`[E2E-TIMING] faucet.ui_usdc_single_hub.finalized ${elapsedMs}ms`);
      console.log(
        `[E2E-TIMING] faucet.ui_usdc_single_hub.state_to_dom state=${renderProbe.stateChangedMs}ms dom=${renderProbe.domVisibleMs}ms delta=${renderProbe.stateToDomMs}ms`,
      );
      expect(elapsedMs, 'single-hub offchain faucet should stay comfortably below timeout').toBeLessThan(5_000);
      expect(await outCap(page, alice.entityId, hubId)).toBe(baselineOut + AMOUNT);
      expect(await getRenderedOutboundForAccount(page, hubId)).toBe(baselineRenderedOut + 100);
    },
  );
});
