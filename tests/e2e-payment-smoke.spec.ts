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
const HISTORY_SCREENSHOT_PATH = String(process.env.E2E_HISTORY_SCREENSHOT_PATH || '').trim();

type HubDirectoryEntry = {
  entityId?: string;
  isHub?: boolean;
  online?: boolean;
  name?: string;
};

type ActivityApiEvent = {
  type?: string;
  rawType?: string;
  title?: string;
  amount?: string;
  entityId?: string;
  counterpartyId?: string;
};

function isExpectedUiPaymentActivity(event: ActivityApiEvent): boolean {
  const type = String(event.type || '');
  const rawType = String(event.rawType || '').toLowerCase();
  const title = String(event.title || '').toLowerCase();
  const amountText = String(event.amount || '');
  let amount = 0n;
  try {
    amount = BigInt(amountText);
  } catch {
    return false;
  }
  return (
    (type === 'payment' || rawType.includes('payment') || title.includes('payment')) &&
    amount >= PAYMENT_AMOUNT &&
    amount < 8n * 10n ** 18n
  );
}

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

async function countRuntimeActivityEvents(
  page: Page,
  entityId: string,
  params: Record<string, string>,
  predicate: (event: ActivityApiEvent) => boolean,
): Promise<number> {
  const localEvents = await page.evaluate(async ({ targetEntityId, sourceParams }) => {
    const view = window as typeof window & {
      XLN?: {
        readPersistedRuntimeActivityPage?: (env: unknown, opts: Record<string, unknown>) => Promise<{ events?: ActivityApiEvent[] }>;
      };
      isolatedEnv?: unknown;
    };
    if (!view.isolatedEnv) return [];
    const XLN = view.XLN?.readPersistedRuntimeActivityPage
      ? view.XLN
      : await import(/* @vite-ignore */ new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href)
        .catch(() => null);
    if (!XLN?.readPersistedRuntimeActivityPage) return [];
    const kind = sourceParams.kind && sourceParams.kind !== 'all' ? sourceParams.kind : undefined;
    const types = sourceParams.types ? String(sourceParams.types).split(',').filter(Boolean) : undefined;
    const body = await XLN.readPersistedRuntimeActivityPage(view.isolatedEnv, {
      entityId: targetEntityId,
      ...(kind ? { kind } : {}),
      ...(types ? { types } : {}),
      limit: 80,
      scanLimit: 100,
    });
    return Array.isArray(body.events) ? body.events : [];
  }, { targetEntityId: entityId, sourceParams: params }).catch(() => [] as ActivityApiEvent[]);

  const url = new URL('/api/debug/activity', API_BASE_URL);
  url.searchParams.set('entityId', entityId);
  url.searchParams.set('limit', '80');
  url.searchParams.set('scanLimit', '100');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await page.request.get(url.toString());
  const serverEvents = response.ok()
    ? ((await response.json() as { events?: ActivityApiEvent[] }).events ?? [])
    : [];
  return [...localEvents, ...serverEvents].filter(predicate).length;
}

async function openEntityHistoryPage(page: Page, entityId: string): Promise<Page> {
  const target = `${APP_BASE_URL}/address/${encodeURIComponent(entityId)}`;
  const historyPage = await page.context().newPage();
  await historyPage.goto(target, { waitUntil: 'domcontentloaded' });
  await historyPage.waitForURL(target, { timeout: CONSENSUS_TIMEOUT_MS });
  return historyPage;
}

async function verifyEntityActivityHistory(page: Page, entityId: string, options: { requirePaymentFilter?: boolean } = {}): Promise<void> {
  await expect
    .poll(
      () => countRuntimeActivityEvents(
        page,
        entityId,
        { kind: 'all' },
        isExpectedUiPaymentActivity,
      ),
      {
        timeout: CONSENSUS_TIMEOUT_MS,
        intervals: [500, 1000, 1500],
        message: `activity API must expose payment history for ${entityId.slice(0, 12)}`,
      },
    )
    .toBeGreaterThan(0);

  const historyPage = await openEntityHistoryPage(page, entityId);
  try {
    await expect(historyPage.getByTestId('entity-history-panel')).toBeVisible({ timeout: CONSENSUS_TIMEOUT_MS });
    await expect
      .poll(() => historyPage.getByTestId('entity-history-event').count(), {
        timeout: CONSENSUS_TIMEOUT_MS,
        intervals: [500, 1000, 1500],
        message: 'entity history should render at least one event',
      })
      .toBeGreaterThan(0);

    await historyPage.getByTestId('history-kind-offchain').click();
    await expect
      .poll(() => historyPage.getByTestId('entity-history-event').count(), {
        timeout: CONSENSUS_TIMEOUT_MS,
        intervals: [500, 1000, 1500],
        message: 'off-chain history tab should keep payment events visible',
      })
      .toBeGreaterThan(0);

    if (options.requirePaymentFilter) {
      await historyPage.getByTestId('history-type-payment').click();
      await expect
        .poll(() => historyPage.getByTestId('entity-history-event').count(), {
          timeout: CONSENSUS_TIMEOUT_MS,
          intervals: [500, 1000, 1500],
          message: 'payment filter should keep payment events visible',
        })
        .toBeGreaterThan(0);
      await expect(
        historyPage.getByTestId('history-event-amount').filter({ hasText: /^7(\.|$)/ }).first(),
      ).toBeVisible({ timeout: CONSENSUS_TIMEOUT_MS });
      await expect
        .poll(() => historyPage.getByTestId('entity-history-event').filter({ hasText: 'Payment finalized' }).count(), {
          timeout: CONSENSUS_TIMEOUT_MS,
          intervals: [500, 1000, 1500],
          message: 'sender history should render one finalized row for the UI payment',
        })
        .toBe(1);
      if (HISTORY_SCREENSHOT_PATH) {
        await historyPage.screenshot({ path: HISTORY_SCREENSHOT_PATH, fullPage: true });
      }
      await historyPage.getByTestId('history-clear-filters').click();
    }

    await historyPage.getByTestId('history-search').fill('payment');
    await expect
      .poll(() => historyPage.getByTestId('entity-history-event').count(), {
        timeout: CONSENSUS_TIMEOUT_MS,
        intervals: [500, 1000, 1500],
        message: 'search should find payment history',
      })
      .toBeGreaterThan(0);
    await historyPage.getByTestId('history-clear-filters').click();

    await historyPage.getByTestId('history-mode-infinite').click();
    await expect(historyPage.getByTestId('history-load-older')).toBeVisible();
    await historyPage.getByTestId('history-mode-timeframe').click();
    await expect(historyPage.getByTestId('history-from')).toBeVisible();
    await expect(historyPage.getByTestId('history-to')).toBeVisible();
    await historyPage.getByTestId('history-kind-onchain').click();
    await expect(historyPage.getByTestId('entity-history-panel')).toBeVisible();
  } finally {
    await historyPage.close().catch(() => {});
  }
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
        verifyEntityActivityHistory(senderPage, sender.entityId, { requirePaymentFilter: true }),
        verifyEntityActivityHistory(recipientPage, recipient.entityId),
      ]);

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
