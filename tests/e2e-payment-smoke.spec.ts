import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { Wallet } from 'ethers';
import {
  getRenderedOutboundForAccount,
  waitForRenderedOutboundForAccountDelta,
} from './utils/e2e-account-ui';
import { requireApiBaseUrl } from './utils/e2e-base-url';
import { ensureE2EBaseline } from './utils/e2e-baseline';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { APP_BASE_URL, createRuntimeIdentity, gotoApp } from './utils/e2e-demo-users';
import { submitUiPayment } from './utils/e2e-pay-ui';
import {
  getPersistedReceiptCursor,
  waitForPersistedFrameEventMatch,
} from './utils/e2e-runtime-receipts';

const API_BASE_URL = requireApiBaseUrl();
const TEST_TIMEOUT_MS = process.env.E2E_LONG === '1' ? 300_000 : 240_000;
const CONSENSUS_TIMEOUT_MS = 60_000;
const PAYMENT_AMOUNT = 7n * 10n ** 18n;
const USE_BASELINE = Boolean(process.env.E2E_RESET_BASE_URL);

type HubDirectoryEntry = {
  entityId?: string;
  isHub?: boolean;
  online?: boolean;
  name?: string;
};

function randomMnemonic(): string {
  const mnemonic = Wallet.createRandom().mnemonic?.phrase;
  if (!mnemonic) throw new Error('failed to generate mnemonic');
  return mnemonic;
}

function randomLabel(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function logPage(page: Page, tag: string): void {
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' || text.includes('HTLC') || text.includes('Payment') || text.includes('[E2E]')) {
      process.stdout.write(`[${tag}] ${text.slice(0, 300)}\n`);
    }
  });
}

async function discoverPrimaryHub(page: Page): Promise<string> {
  const response = await page.request.get(`${API_BASE_URL}/api/debug/entities?limit=5000`);
  expect(response.ok(), 'debug entities endpoint must be reachable').toBe(true);
  const body = await response.json() as { entities?: HubDirectoryEntry[] };
  const hubs = (Array.isArray(body.entities) ? body.entities : [])
    .filter((entry) => entry.isHub === true && entry.online !== false)
    .sort((a, b) => {
      const rank = (name: string | undefined): number => {
        const normalized = String(name || '').trim().toUpperCase();
        if (normalized === 'H3') return 0;
        if (normalized === 'H2') return 1;
        if (normalized === 'H1') return 2;
        return 3;
      };
      return rank(a.name) - rank(b.name);
    });

  const hubId = String(hubs[0]?.entityId || '').trim();
  expect(hubId, 'at least one online hub must be discoverable').toMatch(/^0x[0-9a-f]{64}$/i);
  return hubId;
}

async function waitForEntityAdvertised(page: Page, entityId: string, timeoutMs = CONSENSUS_TIMEOUT_MS): Promise<void> {
  const ok = await expect
    .poll(
      async () => {
        const inGossip = await page.evaluate((targetEntityId) => {
          const view = window as typeof window & {
            XLN?: { refreshGossip?: (env: unknown) => void };
            isolatedEnv?: {
              gossip?: {
                getProfiles?: () => Array<{ entityId?: string; runtimeId?: string; metadata?: { runtimeId?: string } }>;
              };
            };
          };
          try {
            view.XLN?.refreshGossip?.(view.isolatedEnv);
          } catch {
            // best effort
          }
          const profiles = view.isolatedEnv?.gossip?.getProfiles?.() || [];
          return profiles.some((profile) => {
            const id = String(profile?.entityId || '').toLowerCase();
            return id === String(targetEntityId || '').toLowerCase()
              && Boolean(profile?.runtimeId || profile?.metadata?.runtimeId);
          });
        }, entityId).catch(() => false);
        if (inGossip) return true;

        const response = await page.request.get(
          `${API_BASE_URL}/api/debug/entities?limit=5000&q=${encodeURIComponent(entityId)}`,
        );
        if (!response.ok()) return false;
        const body = await response.json() as { entities?: Array<{ entityId?: string; runtimeId?: string }> };
        return (Array.isArray(body.entities) ? body.entities : []).some((entry) =>
          String(entry.entityId || '').toLowerCase() === entityId.toLowerCase() && Boolean(entry.runtimeId),
        );
      },
      { timeout: timeoutMs, intervals: [500, 1000, 1500] },
    )
    .toBe(true);

  void ok;
}

async function hasExportedRuntimeEnv(page: Page): Promise<boolean> {
  return await page.evaluate(() => typeof (window as typeof window & { isolatedEnv?: unknown }).isolatedEnv !== 'undefined');
}

async function getActiveRuntimeId(page: Page): Promise<string> {
  const runtimeId = await page.evaluate(() => {
    const fromUi = document.querySelector<HTMLElement>('[data-testid="context-current"]')?.dataset?.runtimeId;
    if (fromUi) return String(fromUi).trim();
    const view = window as typeof window & { isolatedEnv?: { runtimeId?: string } };
    return String(view.isolatedEnv?.runtimeId || '').trim();
  });
  expect(runtimeId, 'runtimeId must be visible in UI or runtime env').toBeTruthy();
  return runtimeId;
}

async function faucetOffchain(page: Page, entityId: string, hubEntityId: string): Promise<void> {
  let lastError = 'not-run';
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const runtimeId = await getActiveRuntimeId(page);

    const response = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
      data: {
        userEntityId: entityId,
        userRuntimeId: runtimeId,
        hubEntityId,
        tokenId: 1,
        amount: '100',
      },
    }).catch((error) => ({
      ok: () => false,
      status: () => 0,
      json: async () => ({ error: error instanceof Error ? error.message : String(error) }),
    }));

    const body = await response.json().catch(() => ({} as Record<string, unknown>));
    const ok = response.ok();
    process.stdout.write(`[PAY-SMOKE][FAUCET] attempt=${attempt} status=${response.status()} body=${JSON.stringify(body)}\n`);
    if (ok) return;

    lastError = JSON.stringify(body);
    const message = String((body as Record<string, unknown>).error || '');
    const code = String((body as Record<string, unknown>).code || '');
    const transient =
      response.status() === 202 ||
      response.status() === 409 ||
      message.includes('pending') ||
      message.includes('AWAITING') ||
      message.includes('FAUCET_ACCOUNT_MISSING') ||
      message.includes('SIGNER_RESOLUTION_FAILED') ||
      code === 'FAUCET_TOKEN_SURFACE_NOT_READY';
    if (!transient) break;
    await page.waitForTimeout(1_500);
  }

  throw new Error(`faucet failed for ${entityId.slice(0, 10)} via ${hubEntityId.slice(0, 10)}: ${lastError}`);
}

async function waitForSenderSpend(
  page: Page,
  counterpartyId: string,
  baseline: number,
  minSpend: number,
  timeoutMs = CONSENSUS_TIMEOUT_MS,
): Promise<number> {
  return await expect
    .poll(
      async () => {
        const latest = await getRenderedOutboundForAccount(page, counterpartyId);
        return baseline - latest;
      },
      { timeout: timeoutMs, intervals: [250, 500, 1000] },
    )
    .toBeGreaterThanOrEqual(minSpend)
    .then(async () => getRenderedOutboundForAccount(page, counterpartyId));
}

async function waitForRestoredRuntime(page: Page, runtimeId: string): Promise<void> {
  if (await hasExportedRuntimeEnv(page)) {
    await page.waitForFunction(({ targetRuntimeId }) => {
      const view = window as typeof window & {
        isolatedEnv?: {
          runtimeId?: string;
          eReplicas?: Map<string, unknown>;
        };
      };
      return String(view.isolatedEnv?.runtimeId || '').toLowerCase() === String(targetRuntimeId || '').toLowerCase()
        && Number(view.isolatedEnv?.eReplicas?.size || 0) > 0;
    }, { targetRuntimeId: runtimeId }, { timeout: CONSENSUS_TIMEOUT_MS });
    return;
  }

  await expect
    .poll(async () => {
      const trigger = page.getByTestId('context-current').first();
      if (!await trigger.isVisible().catch(() => false)) return false;
      const activeRuntimeId = String(await trigger.getAttribute('data-runtime-id') || '').trim().toLowerCase();
      return activeRuntimeId === runtimeId.toLowerCase();
    }, {
      timeout: CONSENSUS_TIMEOUT_MS,
      intervals: [500, 1000, 1500],
      message: `runtime ${runtimeId.slice(0, 10)} must be re-selected after reload`,
    })
    .toBe(true);
}

test.describe('Payment Smoke', () => {
  test.setTimeout(TEST_TIMEOUT_MS);

  test('fresh runtimes can open accounts, faucet, pay, and reload persisted state', async ({ browser, page }) => {
    let senderContext: BrowserContext | null = null;
    let recipientContext: BrowserContext | null = null;

    try {
      if (USE_BASELINE) {
        await ensureE2EBaseline(page, {
          requireHubMesh: true,
          requireMarketMaker: false,
          minHubCount: 3,
          timeoutMs: CONSENSUS_TIMEOUT_MS * 3,
        });
      }

      senderContext = await browser.newContext({ ignoreHTTPSErrors: true });
      recipientContext = await browser.newContext({ ignoreHTTPSErrors: true });

      const senderPage = await senderContext.newPage();
      const recipientPage = await recipientContext.newPage();
      logPage(senderPage, 'SENDER');
      logPage(recipientPage, 'RECIPIENT');

      await Promise.all([
        gotoApp(senderPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: CONSENSUS_TIMEOUT_MS, settleMs: 1_000 }),
        gotoApp(recipientPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: CONSENSUS_TIMEOUT_MS, settleMs: 1_000 }),
      ]);

      const sender = await createRuntimeIdentity(senderPage, randomLabel('prodpay-a'), randomMnemonic(), {
        requireOnline: false,
      });
      const recipient = await createRuntimeIdentity(recipientPage, randomLabel('prodpay-b'), randomMnemonic(), {
        requireOnline: false,
      });
      expect(sender.entityId).not.toBe(recipient.entityId);

      const hubId = await discoverPrimaryHub(senderPage);
      process.stdout.write(
        `[PAY-SMOKE] baseline=${USE_BASELINE ? 'yes' : 'no'} sender=${sender.entityId} recipient=${recipient.entityId} hub=${hubId}\n`,
      );

      await Promise.all([
        connectRuntimeToHub(senderPage, sender, hubId, { requireOnline: false }),
        connectRuntimeToHub(recipientPage, recipient, hubId, { requireOnline: false }),
      ]);

      await Promise.all([
        waitForEntityAdvertised(senderPage, sender.entityId),
        waitForEntityAdvertised(senderPage, recipient.entityId),
        waitForEntityAdvertised(recipientPage, sender.entityId),
        waitForEntityAdvertised(recipientPage, recipient.entityId),
      ]);

      const senderBeforeFaucet = await getRenderedOutboundForAccount(senderPage, hubId);
      await faucetOffchain(senderPage, sender.entityId, hubId);
      const senderAfterFaucet = await waitForRenderedOutboundForAccountDelta(senderPage, hubId, senderBeforeFaucet, 100, {
        timeoutMs: CONSENSUS_TIMEOUT_MS,
      });
      expect(senderAfterFaucet).toBeGreaterThan(senderBeforeFaucet);

      const recipientBeforePayment = await getRenderedOutboundForAccount(recipientPage, hubId);
      const supportsPersistedReceipts =
        await hasExportedRuntimeEnv(senderPage)
        && await hasExportedRuntimeEnv(recipientPage);
      const senderCursor = supportsPersistedReceipts ? await getPersistedReceiptCursor(senderPage) : null;
      const recipientCursor = supportsPersistedReceipts ? await getPersistedReceiptCursor(recipientPage) : null;

      await submitUiPayment(senderPage, {
        recipientEntityId: recipient.entityId,
        amount: PAYMENT_AMOUNT,
        routeEntityIds: [hubId, recipient.entityId],
      });

      if (supportsPersistedReceipts && senderCursor && recipientCursor) {
        const [senderFinalize, recipientReceive] = await Promise.all([
          waitForPersistedFrameEventMatch(senderPage, {
            cursor: senderCursor,
            eventName: 'HtlcFinalized',
            entityId: sender.entityId,
            timeoutMs: CONSENSUS_TIMEOUT_MS,
            predicate: (event) => String(event.data?.amount || '') === PAYMENT_AMOUNT.toString(),
          }),
          waitForPersistedFrameEventMatch(recipientPage, {
            cursor: recipientCursor,
            eventName: 'HtlcReceived',
            entityId: recipient.entityId,
            timeoutMs: CONSENSUS_TIMEOUT_MS,
            predicate: (event) => String(event.data?.amount || '') === PAYMENT_AMOUNT.toString(),
          }),
        ]);

        expect(String(senderFinalize.data?.toEntity || '').toLowerCase(), 'sender finalized through chosen hub').toBe(hubId.toLowerCase());
        expect(String(recipientReceive.data?.fromEntity || '').toLowerCase(), 'recipient should receive from hub hop').toBe(hubId.toLowerCase());
      }

      const recipientAfterPayment = await waitForRenderedOutboundForAccountDelta(
        recipientPage,
        hubId,
        recipientBeforePayment,
        Number(PAYMENT_AMOUNT / 10n ** 18n),
        { timeoutMs: CONSENSUS_TIMEOUT_MS },
      );
      const senderAfterPayment = await waitForSenderSpend(
        senderPage,
        hubId,
        senderAfterFaucet,
        Number(PAYMENT_AMOUNT / 10n ** 18n),
      );

      await Promise.all([
        senderPage.reload({ waitUntil: 'domcontentloaded' }),
        recipientPage.reload({ waitUntil: 'domcontentloaded' }),
      ]);
      await Promise.all([
        gotoApp(senderPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: CONSENSUS_TIMEOUT_MS, settleMs: 1_000 }),
        gotoApp(recipientPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: CONSENSUS_TIMEOUT_MS, settleMs: 1_000 }),
      ]);
      await Promise.all([
        waitForRestoredRuntime(senderPage, sender.runtimeId),
        waitForRestoredRuntime(recipientPage, recipient.runtimeId),
      ]);

      await expect
        .poll(() => getRenderedOutboundForAccount(senderPage, hubId), {
          timeout: CONSENSUS_TIMEOUT_MS,
          intervals: [500, 1000, 1500],
        })
        .toBe(senderAfterPayment);
      await expect
        .poll(() => getRenderedOutboundForAccount(recipientPage, hubId), {
          timeout: CONSENSUS_TIMEOUT_MS,
          intervals: [500, 1000, 1500],
        })
        .toBe(recipientAfterPayment);

      process.stdout.write(
        `[PAY-SMOKE] PASS senderAfter=${senderAfterPayment} recipientAfter=${recipientAfterPayment} amount=${PAYMENT_AMOUNT.toString()}\n`,
      );
    } finally {
      await senderContext?.close().catch(() => {});
      await recipientContext?.close().catch(() => {});
    }
  });
});
