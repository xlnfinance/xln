import { test, expect, type Page } from '@playwright/test';
import { deriveDelta } from '../runtime/account-utils';
import { getHealth } from './utils/e2e-baseline';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { requireIsolatedBaseUrl } from './utils/e2e-isolated-env';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const API_BASE_URL = requireIsolatedBaseUrl('E2E_API_BASE_URL');
const INIT_TIMEOUT = 30_000;
const LONG_E2E = process.env.E2E_LONG === '1';

type DeltaSnapshot = {
  ondelta: string;
  offdelta: string;
  collateral: string;
  leftCreditLimit: string;
  rightCreditLimit: string;
  leftAllowance: string;
  rightAllowance: string;
  leftHold: string;
  rightHold: string;
};

type FaucetAccountSnapshot = {
  currentHeight: number;
  pendingHeight: number | null;
  outCapacity: string;
};

type FaucetRenderProbe = {
  stateChangedMs: number;
  domVisibleMs: number;
  stateToDomMs: number;
};

async function getPrimaryHubId(page: Page): Promise<string> {
  const health = await getHealth(page, API_BASE_URL);
  const hubId = health?.hubMesh?.hubIds?.[0];
  expect(typeof hubId === 'string' && hubId.length === 66, 'baseline must expose a primary hub id').toBe(true);
  return hubId!;
}

async function readFaucetAccountSnapshot(
  page: Page,
  entityId: string,
  signerId: string | null,
  hubId: string,
  tokenId: number,
): Promise<FaucetAccountSnapshot> {
  const raw = await page.evaluate(
    ({ entityId, signerId, hubId, tokenId }) => {
      const env = (window as typeof window & {
        isolatedEnv?: {
          eReplicas?: Map<string, {
            state?: {
              accounts?: Map<string, {
                currentHeight?: number;
                pendingFrame?: { height?: number } | null;
                deltas?: Map<number | string, unknown>;
              }>;
            };
          }>;
        };
      }).isolatedEnv;
      if (!env?.eReplicas) return null;

      for (const [replicaKey, replica] of env.eReplicas.entries()) {
        const [replicaEntityId, replicaSignerId] = String(replicaKey).split(':');
        if (String(replicaEntityId || '').toLowerCase() !== String(entityId || '').toLowerCase()) continue;
        if (signerId && String(replicaSignerId || '').toLowerCase() !== String(signerId || '').toLowerCase()) continue;
        const account = replica.state?.accounts?.get(hubId);
        if (!account) return null;
        const delta = account.deltas?.get?.(tokenId) ?? account.deltas?.get?.(String(tokenId));
        if (!delta || typeof delta !== 'object') return null;
        const data = delta as Record<string, unknown>;
        const readBig = (value: unknown): string => {
          if (typeof value === 'bigint') return value.toString();
          if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return String(value);
          if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return value.trim();
          return '0';
        };
        return {
          currentHeight: Number(account.currentHeight || 0),
          pendingHeight: account.pendingFrame ? Number(account.pendingFrame.height || 0) : null,
          delta: {
            ondelta: readBig(data.ondelta),
            offdelta: readBig(data.offdelta),
            collateral: readBig(data.collateral),
            leftCreditLimit: readBig(data.leftCreditLimit),
            rightCreditLimit: readBig(data.rightCreditLimit),
            leftAllowance: readBig(data.leftAllowance),
            rightAllowance: readBig(data.rightAllowance),
            leftHold: readBig(data.leftHold),
            rightHold: readBig(data.rightHold),
          },
        };
      }

      return null;
    },
    { entityId, signerId, hubId, tokenId },
  ) as { currentHeight: number; pendingHeight: number | null; delta: DeltaSnapshot } | null;

  expect(raw, `account snapshot must exist for ${hubId.slice(0, 10)}`).not.toBeNull();
  const isLeft = entityId.toLowerCase() < hubId.toLowerCase();
  const derived = deriveDelta({
    tokenId,
    ondelta: BigInt(raw!.delta.ondelta),
    offdelta: BigInt(raw!.delta.offdelta),
    collateral: BigInt(raw!.delta.collateral),
    leftCreditLimit: BigInt(raw!.delta.leftCreditLimit),
    rightCreditLimit: BigInt(raw!.delta.rightCreditLimit),
    leftAllowance: BigInt(raw!.delta.leftAllowance),
    rightAllowance: BigInt(raw!.delta.rightAllowance),
    leftHold: BigInt(raw!.delta.leftHold),
    rightHold: BigInt(raw!.delta.rightHold),
  }, isLeft);

  return {
    currentHeight: raw!.currentHeight,
    pendingHeight: raw!.pendingHeight,
    outCapacity: derived.outCapacity.toString(),
  };
}

async function findEntitySigner(page: Page, entityId: string): Promise<string | null> {
  return page.evaluate((targetEntityId) => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env?.eReplicas) return null;
    for (const replicaKey of env.eReplicas.keys()) {
      const [replicaEntityId, replicaSignerId] = String(replicaKey).split(':');
      if (String(replicaEntityId || '').toLowerCase() !== String(targetEntityId || '').toLowerCase()) continue;
      if (replicaSignerId) return replicaSignerId;
    }
    return null;
  }, entityId);
}

async function readRenderedAccountTokenOut(page: Page, hubId: string, symbol: string): Promise<number> {
  return page.evaluate(({ hubId, symbol }) => {
    const preview = document.querySelector(`.account-preview[data-counterparty-id="${hubId}"]`);
    if (!preview) return NaN;
    const rows = Array.from(preview.querySelectorAll('.delta-row, .delta-row-stack, .delta-summary'));
    for (const row of rows) {
      const symbolEl = row.querySelector('.token-symbol');
      if (String(symbolEl?.textContent || '').trim().toUpperCase() !== String(symbol || '').trim().toUpperCase()) {
        continue;
      }
      const valueEl = row.querySelector('.compact-out-value');
      if (!valueEl) return NaN;
      const amountEl = Array.from(valueEl.children).find((child) =>
        !(child instanceof HTMLElement) || !child.classList.contains('usd-hint'),
      );
      const text = String((amountEl?.textContent || valueEl.textContent || '')).replace(/,/g, '').trim();
      const numeric = Number(text.replace(/[^0-9.-]/g, ''));
      return Number.isFinite(numeric) ? numeric : NaN;
    }
    return NaN;
  }, { hubId, symbol });
}

async function measureAccountStateToDomLatency(
  page: Page,
  entityId: string,
  signerId: string | null,
  hubId: string,
  tokenId: number,
  symbol: string,
  baselineHeight: number,
  baselineOut: number,
): Promise<FaucetRenderProbe> {
  return await page.evaluate(
    ({ entityId, signerId, hubId, tokenId, symbol, baselineHeight, baselineOut }) => {
      const startedAt = performance.now();
      const readSnapshot = () => {
        const env = (window as typeof window & {
          isolatedEnv?: {
            eReplicas?: Map<string, {
              state?: {
                accounts?: Map<string, {
                  currentHeight?: number;
                  deltas?: Map<number | string, unknown>;
                }>;
              };
            }>;
          };
        }).isolatedEnv;
        if (!env?.eReplicas) return null;
        for (const [replicaKey, replica] of env.eReplicas.entries()) {
          const [replicaEntityId, replicaSignerId] = String(replicaKey).split(':');
          if (String(replicaEntityId || '').toLowerCase() !== String(entityId || '').toLowerCase()) continue;
          if (signerId && String(replicaSignerId || '').toLowerCase() !== String(signerId || '').toLowerCase()) continue;
          const account = replica.state?.accounts?.get?.(hubId);
          if (!account) return null;
          const delta = account.deltas?.get?.(tokenId) ?? account.deltas?.get?.(String(tokenId));
          return {
            currentHeight: Number(account.currentHeight || 0),
            deltaJson: JSON.stringify(delta, (_, value) => typeof value === 'bigint' ? value.toString() : value),
          };
        }
        return null;
      };

      const readRenderedOut = (): number => {
        const preview = document.querySelector(`.account-preview[data-counterparty-id="${hubId}"]`);
        if (!preview) return Number.NaN;
        const rows = Array.from(preview.querySelectorAll('.delta-row, .delta-row-stack, .delta-summary'));
        for (const row of rows) {
          const symbolEl = row.querySelector('.token-symbol');
          if (String(symbolEl?.textContent || '').trim().toUpperCase() !== String(symbol || '').trim().toUpperCase()) {
            continue;
          }
          const valueEl = row.querySelector('.compact-out-value');
          if (!valueEl) return Number.NaN;
          const amountEl = Array.from(valueEl.children).find((child) =>
            !(child instanceof HTMLElement) || !child.classList.contains('usd-hint'),
          );
          const text = String((amountEl?.textContent || valueEl.textContent || '')).replace(/,/g, '').trim();
          const numeric = Number(text.replace(/[^0-9.-]/g, ''));
          return Number.isFinite(numeric) ? numeric : Number.NaN;
        }
        return Number.NaN;
      };

      const baseline = readSnapshot();
      const baselineDeltaJson = baseline?.deltaJson || '';

      return new Promise<FaucetRenderProbe>((resolve, reject) => {
        const deadline = performance.now() + 15_000;
        let stateChangedAt: number | null = null;
        const loop = () => {
          const now = performance.now();
          if (now > deadline) {
            reject(new Error('Timed out waiting for account state/render transition'));
            return;
          }

          const snapshot = readSnapshot();
          if (!stateChangedAt && snapshot) {
            const heightAdvanced = snapshot.currentHeight > baselineHeight;
            const deltaChanged = snapshot.deltaJson !== baselineDeltaJson;
            if (heightAdvanced || deltaChanged) {
              stateChangedAt = now;
            }
          }

          const renderedOut = readRenderedOut();
          if (stateChangedAt !== null && Number.isFinite(renderedOut) && renderedOut > baselineOut) {
            resolve({
              stateChangedMs: Math.round(stateChangedAt - startedAt),
              domVisibleMs: Math.round(now - startedAt),
              stateToDomMs: Math.round(now - stateChangedAt),
            });
            return;
          }

          requestAnimationFrame(loop);
        };

        requestAnimationFrame(loop);
      });
    },
    { entityId, signerId, hubId, tokenId, symbol, baselineHeight, baselineOut },
  );
}

test.describe('E2E Faucet Latency', () => {
  test('demo account single-hub UI USDT faucet finalizes as fast as possible', async ({ page }) => {
    test.setTimeout(LONG_E2E ? 180_000 : 90_000);

    await gotoApp(page, {
      appBaseUrl: APP_BASE_URL,
      initTimeoutMs: INIT_TIMEOUT,
      settleMs: 0,
    });

    const alice = await createRuntimeIdentity(page, 'alice', selectDemoMnemonic('alice'));
    const hubId = await getPrimaryHubId(page);
    await connectRuntimeToHub(page, alice, hubId);
    await page.getByTestId('tab-accounts').first().click();
    const preview = page.locator(`.account-preview[data-counterparty-id="${hubId}"]`).first();
    await expect(preview).toBeVisible({ timeout: 20_000 });
    const usdtRow = preview.locator('.delta-row-stack', { hasText: 'USDT' }).first();
    await expect(usdtRow).toBeVisible({ timeout: 20_000 });
    const faucetButton = usdtRow.getByRole('button', { name: /^Faucet$/ });
    await expect(faucetButton).toBeEnabled({ timeout: 20_000 });

    const baselineOut = await readRenderedAccountTokenOut(page, hubId, 'USDT');
    expect(Number.isFinite(baselineOut), 'rendered USDT out capacity must be readable').toBe(true);
    const baselineAccount = await readFaucetAccountSnapshot(page, alice.entityId, alice.signerId, hubId, 3);
    const renderProbePromise = measureAccountStateToDomLatency(
      page,
      alice.entityId,
      alice.signerId,
      hubId,
      3,
      'USDT',
      baselineAccount.currentHeight,
      baselineOut,
    );
    const startedAt = Date.now();
    await faucetButton.click();

    await expect
      .poll(
        async () => await readRenderedAccountTokenOut(page, hubId, 'USDT'),
        {
          timeout: 15_000,
          intervals: [10, 20, 25, 50, 100],
          message: 'UI USDT faucet must become visible to the user on Accounts page',
        },
      )
      .toBeGreaterThan(baselineOut);

    const elapsedMs = Date.now() - startedAt;
    const renderProbe = await renderProbePromise;
    console.log(`[E2E-TIMING] faucet.ui_usdt_single_hub.finalized ${elapsedMs}ms`);
    console.log(
      `[E2E-TIMING] faucet.ui_usdt_single_hub.state_to_dom state=${renderProbe.stateChangedMs}ms dom=${renderProbe.domVisibleMs}ms delta=${renderProbe.stateToDomMs}ms`,
    );
    expect(elapsedMs, 'single-hub offchain faucet should stay comfortably below timeout').toBeLessThan(5_000);
  });
});
