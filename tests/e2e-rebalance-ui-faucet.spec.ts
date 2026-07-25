import { test, expect, type Page } from './global-setup.mts';
import { deriveDelta } from '../runtime/account/utils';
import { getHealth } from './utils/e2e-baseline';
import { connectRuntimeToHubWithCredit } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { requireIsolatedBaseUrl } from './utils/e2e-isolated-env';

/**
 * The rebalance suite drives faucets through the HTTP API and reads state back
 * through injected runtime globals. A user drives the Faucet button instead.
 * This covers that path end to end: six clicks push outPeerCredit past the
 * 500-token soft limit, so the hub must post collateral without any further
 * user action.
 */

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const API_BASE_URL = requireIsolatedBaseUrl('E2E_API_BASE_URL');
const INIT_TIMEOUT = 30_000;
const FAUCET_CLICKS = 6;

type AccountProbe = {
  collateral: string;
  outPeerCredit: string;
  outCapacity: string;
  currentHeight: number;
  policyTokenIds: number[];
  feePolicyTokenIds: number[];
  queuedRequestCollateral: number;
};

async function getApiTokenId(page: Page, symbol: string): Promise<number> {
  const response = await page.request.get(`${API_BASE_URL}/api/tokens`);
  expect(response.ok(), 'tokens endpoint must be available').toBe(true);
  const body = await response.json().catch(() => ({} as { tokens?: Array<{ symbol?: string; tokenId?: number }> }));
  const tokens = Array.isArray(body.tokens) ? body.tokens : [];
  const match = tokens.find((token) => String(token.symbol || '').toUpperCase() === symbol.toUpperCase());
  expect(typeof match?.tokenId === 'number', `Missing ${symbol} tokenId`).toBe(true);
  return Number(match!.tokenId);
}

async function getPrimaryHubId(page: Page): Promise<string> {
  const health = await getHealth(page, API_BASE_URL);
  const hubId = health?.hubMesh?.hubIds?.[0];
  expect(typeof hubId === 'string' && hubId.length === 66, 'baseline must expose a primary hub id').toBe(true);
  return String(hubId);
}

/**
 * Reads the raw delta plus the two policy maps the auto-rebalance hook gates on.
 * Both must be populated or checkAutoRebalance returns before it ever compares
 * outPeerCredit against the soft limit.
 */
async function readAccountProbe(
  page: Page,
  entityId: string,
  hubId: string,
  tokenId: number,
): Promise<AccountProbe | null> {
  const raw = await page.evaluate(
    ({ entityId, hubId, tokenId }) => {
      const env = (window as any).isolatedEnv;
      if (!env?.eReplicas) return null;
      for (const [, replica] of env.eReplicas.entries()) {
        if (String(replica?.entityId || '').toLowerCase() !== entityId.toLowerCase()) continue;
        const account = replica.state?.accounts?.get?.(hubId);
        if (!account) continue;
        const delta = account.deltas?.get?.(tokenId);
        if (!delta) continue;
        const big = (value: unknown): string => (typeof value === 'bigint' ? value.toString() : '0');
        return {
          currentHeight: Number(account.currentHeight || 0),
          policyTokenIds: Array.from(account.shadow?.rebalance?.policy?.keys?.() || []),
          feePolicyTokenIds: Array.from(account.rebalanceFeePolicies?.keys?.() || []),
          queuedRequestCollateral: (account.mempool || [])
            .filter((tx: { type?: string }) => tx?.type === 'request_collateral').length,
          delta: {
            ondelta: big(delta.ondelta),
            offdelta: big(delta.offdelta),
            collateral: big(delta.collateral),
            leftCreditLimit: big(delta.leftCreditLimit),
            rightCreditLimit: big(delta.rightCreditLimit),
            leftAllowance: big(delta.leftAllowance),
            rightAllowance: big(delta.rightAllowance),
            leftHold: big(delta.leftHold),
            rightHold: big(delta.rightHold),
          },
        };
      }
      return null;
    },
    { entityId, hubId, tokenId },
  );
  if (!raw) return null;

  const isLeft = entityId.toLowerCase() < hubId.toLowerCase();
  const derived = deriveDelta({
    tokenId,
    ondelta: BigInt(raw.delta.ondelta),
    offdelta: BigInt(raw.delta.offdelta),
    collateral: BigInt(raw.delta.collateral),
    leftCreditLimit: BigInt(raw.delta.leftCreditLimit),
    rightCreditLimit: BigInt(raw.delta.rightCreditLimit),
    leftAllowance: BigInt(raw.delta.leftAllowance),
    rightAllowance: BigInt(raw.delta.rightAllowance),
    leftHold: BigInt(raw.delta.leftHold),
    rightHold: BigInt(raw.delta.rightHold),
  }, isLeft);

  return {
    collateral: raw.delta.collateral,
    outPeerCredit: derived.outPeerCredit.toString(),
    outCapacity: derived.outCapacity.toString(),
    currentHeight: raw.currentHeight,
    policyTokenIds: raw.policyTokenIds as number[],
    feePolicyTokenIds: raw.feePolicyTokenIds as number[],
    queuedRequestCollateral: raw.queuedRequestCollateral,
  };
}

test.describe('E2E Rebalance via UI faucet', () => {
  test('six UI faucet clicks put collateral behind the account', { tag: '@functional' }, async ({ page }) => {
    test.setTimeout(240_000);
    const appHost = new URL(APP_BASE_URL).hostname;
    const requireOnline = appHost === 'localhost' || appHost === '127.0.0.1' || appHost === '::1';

    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });

    const alice = await createRuntimeIdentity(page, 'alice', selectDemoMnemonic('alice'), { requireOnline });
    const hubId = await getPrimaryHubId(page);
    const usdcTokenId = await getApiTokenId(page, 'USDC');
    await connectRuntimeToHubWithCredit(page, alice, hubId, '10000', [usdcTokenId], { requireOnline });

    await page.getByTestId('tab-accounts').first().click();
    const preview = page.locator(`.account-preview[data-counterparty-id="${hubId}"]`).first();
    await expect(preview).toBeVisible({ timeout: 20_000 });
    const usdcRow = preview.locator('.delta-row-stack, .delta-summary', { hasText: 'USDC' }).first();
    await expect(usdcRow).toBeVisible({ timeout: 20_000 });
    const faucetButton = usdcRow.getByRole('button', { name: /^Faucet$/ });
    await expect(faucetButton).toBeEnabled({ timeout: 20_000 });

    const opened = await readAccountProbe(page, alice.entityId, hubId, usdcTokenId);
    expect(opened, 'account must exist after hub connect').not.toBeNull();
    // Both gates the hook checks. An empty map here means auto-rebalance can
    // never run, whatever the balance does.
    expect(opened!.policyTokenIds, 'local rebalance policy must be seeded on open')
      .toContain(usdcTokenId);
    expect(opened!.feePolicyTokenIds, 'hub fee policy must be announced on open')
      .toContain(usdcTokenId);

    for (let click = 0; click < FAUCET_CLICKS; click += 1) {
      await expect(faucetButton).toBeEnabled({ timeout: 20_000 });
      await faucetButton.click();
      await expect
        .poll(
          async () => (await readAccountProbe(page, alice.entityId, hubId, usdcTokenId))?.currentHeight ?? 0,
          { timeout: 20_000, intervals: [50, 100, 250], message: `faucet ${click + 1} must commit a frame` },
        )
        .toBeGreaterThan(opened!.currentHeight + click);
    }

    const funded = await readAccountProbe(page, alice.entityId, hubId, usdcTokenId);
    expect(funded, 'account must still exist after faucets').not.toBeNull();
    // 6 x 100 USDC clears the 500-token soft limit, so the trigger condition is met.
    expect(BigInt(funded!.outPeerCredit), 'six faucets must exceed the 500 USDC soft limit')
      .toBeGreaterThan(500_000_000n);

    await expect
      .poll(
        async () => {
          const probe = await readAccountProbe(page, alice.entityId, hubId, usdcTokenId);
          return BigInt(probe?.collateral ?? '0') > 0n;
        },
        {
          timeout: 60_000,
          intervals: [100, 250, 500],
          message: 'hub must post collateral once the soft limit is crossed, with no further user action',
        },
      )
      .toBe(true);

    const settled = await readAccountProbe(page, alice.entityId, hubId, usdcTokenId);
    expect(BigInt(settled!.outPeerCredit), 'uncollateralized peer credit must fall once collateral lands')
      .toBeLessThan(BigInt(funded!.outPeerCredit));
  });
});
