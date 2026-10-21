import type { RuntimeReplica, XLNModule } from '../../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../../core/api/runtime-adapter/types';
import { createWalletIdentity, LOCAL_PASSWORD } from '../../../ui/tests/wallet-ui';
import { test, expect, type BrowserContext, type Page } from '../../global-setup.mts';
import { Wallet } from 'ethers';
import {
  getRenderedOutboundForAccount,
  waitForRenderedOutboundForAccountDelta,
} from '../../utils/runtime/e2e-account-ui';
import { requireApiBaseUrl } from '../../utils/e2e-base-url';
import { ensureE2EBaseline } from '../../utils/e2e-baseline';
import { connectRuntimeToHub, waitForReceiveReadyGossipProfiles } from '../../utils/e2e-connect';
import { APP_BASE_URL, gotoApp } from '../../utils/e2e-demo-users';
import { submitUiPayment } from '../../utils/runtime/e2e-pay-ui';
import { getPersistedReceiptCursor, waitForPersistedFrameEventMatch } from '../../utils/e2e-runtime-receipts';
import { timedStep } from '../../utils/e2e-timing.mts';

const API_BASE_URL = requireApiBaseUrl();
const TEST_TIMEOUT_MS = process.env.E2E_LONG === '1' ? 300_000 : 240_000;
const CONSENSUS_TIMEOUT_MS = 60_000;
const USDC_DECIMALS = 6n;
const PAYMENT_AMOUNT = 7n * 10n ** USDC_DECIMALS;
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

type CurrentWalletWindow = Window & {
  __xln?: { env(): RuntimeReplica | null; xln(): Promise<XLNModule>; adapter(): RuntimeAdapter | null };
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
  return (type === 'payment' || rawType.includes('payment') || title.includes('payment')) && amount === PAYMENT_AMOUNT;
}

function isTransientActivityReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /Database is not open|Iterator is not open|cannot call next\(\) after close/i.test(message);
}

function randomMnemonic(): string {
  const mnemonic = Wallet.createRandom().mnemonic?.phrase;
  if (!mnemonic) throw new Error('failed to generate mnemonic');
  return mnemonic;
}

function randomLabel(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function logPage(page: Page, tag: string): string[] {
  const errors: string[] = [];
  const watcherDebug = process.env.E2E_WATCHER_DEBUG === '1';
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error') errors.push(text);
    if (
      msg.type() === 'error' ||
      text.includes('HTLC') ||
      text.includes('Payment') ||
      text.includes('[E2E]') ||
      text.includes('[hosted] chain scan') ||
      (watcherDebug && /jadapter|J_WATCH|j_watch/i.test(text))
    ) {
      process.stdout.write(`[${tag}] ${text.slice(0, 300)}\n`);
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

async function readJWatcherDiagnostics(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const env = (window as CurrentWalletWindow).__xln?.env();
    if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
    return {
      jurisdictions: [...env.state.jReplicas.entries()].map(([key, replica]) => ({
        key,
        name: replica.name,
        chainId: replica.chainId,
        blockNumber: String(replica.blockNumber),
        depositoryAddress: replica.contracts.depository,
        rpcs: replica.rpcs,
      })),
      entities: [...env.state.eReplicas.entries()].map(([key, replica]) => ({
        key,
        entityId: replica.entityId,
        signerId: replica.signerId,
        finalizedHeight: replica.state.lastFinalizedJHeight,
        finality: replica.state.jHistoryFinality,
      })),
    };
  });
}

async function discoverPrimaryHub(page: Page): Promise<string> {
  const response = await page.request.get(`${API_BASE_URL}/api/debug/entities?limit=5000`);
  expect(response.ok(), 'debug entities endpoint must be reachable').toBe(true);
  const body = (await response.json()) as { entities?: HubDirectoryEntry[] };
  const hubs = (Array.isArray(body.entities) ? body.entities : [])
    .filter(entry => entry.isHub === true && entry.online !== false)
    .sort((a, b) => {
      const rank = (name: string | undefined): number => {
        const normalized = String(name || '')
          .trim()
          .toUpperCase();
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
  await expect
    .poll(
      () =>
        page.evaluate(async target => {
          const debug = (window as CurrentWalletWindow).__xln;
          const env = debug?.env();
          if (!debug || !env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
          await (await debug.xln()).ensureGossipProfiles(env, [target]);
          return env.gossip
            .getProfiles()
            .some(
              profile =>
                profile.entityId.toLowerCase() === target.toLowerCase() &&
                Boolean(profile.runtimeId || profile.metadata?.runtimeId),
            );
        }, entityId),
      { timeout: timeoutMs, intervals: [200, 400, 800] },
    )
    .toBe(true);
}

async function getActiveRuntimeId(page: Page): Promise<string> {
  const runtimeId = await page.evaluate(() => {
    const env = (
      window as Window & {
        __xln?: { env(): import('../../../core/runtime/types').RuntimeReplica | null };
      }
    ).__xln?.env();
    if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
    return env.runtimeId;
  });
  expect(runtimeId, 'runtimeId must be visible in UI or runtime env').toBeTruthy();
  return runtimeId;
}

async function faucetOffchain(page: Page, entityId: string, hubEntityId: string): Promise<void> {
  let lastError = 'not-run';
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const runtimeId = await getActiveRuntimeId(page);

    const response = await page.request
      .post(`${API_BASE_URL}/api/faucet/offchain`, {
        data: {
          userEntityId: entityId,
          userRuntimeId: runtimeId,
          hubEntityId,
          tokenId: 1,
          amount: '100',
        },
      })
      .catch(error => ({
        ok: () => false,
        status: () => 0,
        json: async () => ({ error: error instanceof Error ? error.message : String(error) }),
      }));

    const body = await response.json().catch(() => ({}) as Record<string, unknown>);
    const ok = response.ok();
    process.stdout.write(
      `[PAY-SMOKE][FAUCET] attempt=${attempt} status=${response.status()} body=${JSON.stringify(body)}\n`,
    );
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
  await page.waitForFunction(
    targetRuntimeId => {
      const env = (window as CurrentWalletWindow).__xln?.env();
      if (!env || env.runtimeId.toLowerCase() !== targetRuntimeId.toLowerCase() || env.state.eReplicas.size === 0)
        return false;
      const accounts = [...env.state.eReplicas.values()].flatMap(entity => [...entity.state.accounts.values()]);
      // Recovery must restore usable online money and drain acknowledged delivery.
      return (
        env.infrastructure?.p2p?.isConnected() === true &&
        (env.pendingNetworkOutputs?.length ?? 0) === 0 &&
        (env.pendingOutputs?.length ?? 0) === 0 &&
        (env.networkInbox?.length ?? 0) === 0 &&
        env.runtimeMempool.entityInputs.length === 0 &&
        accounts.every(account => !account.pendingFrame && !account.pendingAccountInput && account.mempool.length === 0)
      );
    },
    runtimeId,
    { timeout: CONSENSUS_TIMEOUT_MS },
  );
}

async function countRuntimeActivityEvents(
  page: Page,
  entityId: string,
  params: Record<string, string>,
  predicate: (event: ActivityApiEvent) => boolean,
): Promise<number> {
  let events: ActivityApiEvent[];
  try {
    events = await page.evaluate(
      async ({ targetEntityId, sourceParams }) => {
        const adapter = (window as CurrentWalletWindow).__xln?.adapter();
        if (!adapter) throw new Error('E2E_ACTIVITY_QUERY_UNAVAILABLE');
        const kind = sourceParams.kind && sourceParams.kind !== 'all' ? sourceParams.kind : undefined;
        const types = sourceParams.types ? String(sourceParams.types).split(',').filter(Boolean) : undefined;
        const body = await adapter.read<{ events: ActivityApiEvent[] }>('activity', {
          entityId: targetEntityId,
          ...(kind ? { kind } : {}),
          ...(types ? { types } : {}),
          limit: 80,
          scanLimit: types?.length ? 1000 : 100,
        });
        return Array.isArray(body.events) ? body.events : [];
      },
      { targetEntityId: entityId, sourceParams: params },
    );
  } catch (error) {
    if (isTransientActivityReadError(error)) return 0;
    throw error;
  }

  return events.filter(predicate).length;
}

async function verifyEntityActivityHistory(
  page: Page,
  entityId: string,
  options: { requirePaymentFilter?: boolean } = {},
): Promise<void> {
  for (const kind of ['all', 'offchain']) {
    await expect
      .poll(() => countRuntimeActivityEvents(page, entityId, { kind }, isExpectedUiPaymentActivity), {
        timeout: CONSENSUS_TIMEOUT_MS,
        intervals: [200, 400, 800],
        message: `durable ${kind} activity must include the exact 7 USDC payment`,
      })
      .toBeGreaterThan(0);
  }
  await page.getByTestId('nav-activity').locator('visible=true').first().click();
  const rows = page.getByTestId('activity-row');
  await expect(rows.first()).toBeVisible();
  await page.getByRole('button', { name: 'Payments', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Payments', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(
    rows
      .locator('.aa')
      .filter({ hasText: /^[+−-]?7(?:\.0+)? USDC$/ })
      .first(),
  ).toBeVisible();
  if (options.requirePaymentFilter && HISTORY_SCREENSHOT_PATH) {
    await page.screenshot({ path: HISTORY_SCREENSHOT_PATH, fullPage: true });
  }
  await page.getByTestId('activity-search').fill('payment');
  await expect(rows.first()).toBeVisible();
  await page.getByTestId('activity-search').fill('');
  // Current Activity has date filters directly; retired infinite/timeframe toggles are not wallet behavior.
  await expect(page.getByLabel('From', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Until', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'On-chain', exact: true }).click();
  await expect(page.getByRole('button', { name: 'On-chain', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(rows.first()).toBeVisible();
}

test.describe('Payment Smoke', () => {
  test.setTimeout(TEST_TIMEOUT_MS);

  test(
    'fresh runtimes can open accounts, faucet, pay, and reload persisted state',
    { tag: '@functional' },
    async ({ browser, page, viewport, isMobile, hasTouch, deviceScaleFactor, userAgent }) => {
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

        const contextOptions = { ignoreHTTPSErrors: true, viewport, isMobile, hasTouch, deviceScaleFactor, userAgent };
        senderContext = await browser.newContext(contextOptions);
        recipientContext = await browser.newContext(contextOptions);

        const senderPage = await senderContext.newPage();
        const recipientPage = await recipientContext.newPage();
        const senderErrors = logPage(senderPage, 'SENDER');
        const recipientErrors = logPage(recipientPage, 'RECIPIENT');

        await Promise.all([
          gotoApp(senderPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: CONSENSUS_TIMEOUT_MS, settleMs: 1_000 }),
          gotoApp(recipientPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: CONSENSUS_TIMEOUT_MS, settleMs: 1_000 }),
        ]);

        for (const walletPage of [senderPage, recipientPage]) {
          expect(walletPage.viewportSize()).toEqual(viewport);
          const device = await walletPage.evaluate(() => ({
            width: window.innerWidth,
            touch: matchMedia('(pointer: coarse)').matches,
          }));
          expect(device.touch).toBe(hasTouch);
          console.log('[PAY-SMOKE-DEVICE]', { viewport, isMobile, hasTouch, ...device });
        }

        const sender = await createWalletIdentity(senderPage, randomLabel('prodpay-a'), randomMnemonic());
        const recipient = await createWalletIdentity(recipientPage, randomLabel('prodpay-b'), randomMnemonic());
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
        const senderAfterFaucet = await waitForRenderedOutboundForAccountDelta(
          senderPage,
          hubId,
          senderBeforeFaucet,
          100,
          {
            timeoutMs: CONSENSUS_TIMEOUT_MS,
          },
        );
        expect(senderAfterFaucet).toBeGreaterThan(senderBeforeFaucet);

        const recipientBeforePayment = await getRenderedOutboundForAccount(recipientPage, hubId);
        const senderCursor = await getPersistedReceiptCursor(senderPage);
        const recipientCursor = await getPersistedReceiptCursor(recipientPage);

        await waitForReceiveReadyGossipProfiles(senderPage, [sender.entityId, hubId, recipient.entityId], hubId);
        await submitUiPayment(senderPage, {
          recipientEntityId: recipient.entityId,
          amount: PAYMENT_AMOUNT,
          tokenId: 1,
          routeEntityIds: [hubId, recipient.entityId],
        });

        {
          const [senderFinalize, recipientReceive] = await Promise.all([
            waitForPersistedFrameEventMatch(senderPage, {
              cursor: senderCursor,
              eventName: 'HtlcFinalized',
              entityId: sender.entityId,
              timeoutMs: CONSENSUS_TIMEOUT_MS,
              predicate: event => String(event.data?.amount || '') === PAYMENT_AMOUNT.toString(),
            }),
            waitForPersistedFrameEventMatch(recipientPage, {
              cursor: recipientCursor,
              eventName: 'HtlcReceived',
              entityId: recipient.entityId,
              timeoutMs: CONSENSUS_TIMEOUT_MS,
              predicate: event => String(event.data?.amount || '') === PAYMENT_AMOUNT.toString(),
            }),
          ]);

          expect(String(senderFinalize.data?.toEntity || '').toLowerCase(), 'sender finalized through chosen hub').toBe(
            hubId.toLowerCase(),
          );
          expect(
            String(recipientReceive.data?.fromEntity || '').toLowerCase(),
            'recipient should receive from hub hop',
          ).toBe(hubId.toLowerCase());
        }

        const recipientAfterPayment = await waitForRenderedOutboundForAccountDelta(
          recipientPage,
          hubId,
          recipientBeforePayment,
          Number(PAYMENT_AMOUNT / 10n ** USDC_DECIMALS),
          { timeoutMs: CONSENSUS_TIMEOUT_MS },
        );
        const senderAfterPayment = await waitForSenderSpend(
          senderPage,
          hubId,
          senderAfterFaucet,
          Number(PAYMENT_AMOUNT / 10n ** USDC_DECIMALS),
        );

        await Promise.all([
          verifyEntityActivityHistory(senderPage, sender.entityId, { requirePaymentFilter: true }),
          verifyEntityActivityHistory(recipientPage, recipient.entityId),
        ]);

        await Promise.all([
          senderPage.reload({ waitUntil: 'domcontentloaded' }),
          recipientPage.reload({ waitUntil: 'domcontentloaded' }),
        ]);
        const unlockAfterReload = async (reloadedPage: Page, identity: typeof sender, label: string): Promise<void> => {
          try {
            await timedStep(`payment_smoke.restore_${label}`, async () => {
              await reloadedPage.getByRole('button', { name: 'Continue', exact: true }).click();
              await reloadedPage.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
              await reloadedPage.getByRole('button', { name: 'Unlock', exact: true }).click();
              await expect(reloadedPage.getByTestId('nav-home').locator('visible=true').first()).toBeVisible();
            });
          } catch (error) {
            // Observe only after the original assertion fails; diagnostics never extend its deadline.
            const scan = await reloadedPage
              .evaluate(async owner => {
                const debug = (window as CurrentWalletWindow).__xln;
                const env = debug?.env();
                if (!debug || !env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
                const xln = await debug.xln();
                const adapter = xln.getEntityJAdapter(env, owner.entityId, owner.signerId);
                if (!adapter?.getCurrentBlockNumber || !adapter.getFinalityDepth)
                  throw new Error('J_WATCHER_DRAIN_API_MISSING');
                const head = Number(await adapter.getCurrentBlockNumber());
                return xln.getJWatcherDrainStatus(env, {
                  adapter,
                  targetBlock: Math.max(0, head - Number(adapter.getFinalityDepth())),
                });
              }, identity)
              .catch(diagnosticError => ({ diagnosticError: String(diagnosticError) }));
            console.log('[PAY-SMOKE][RESTORE-FAILED]', { label, scan });
            throw error;
          }
        };
        await Promise.all([
          unlockAfterReload(senderPage, sender, 'sender'),
          unlockAfterReload(recipientPage, recipient, 'recipient'),
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

        const runtimeErrors = [...senderErrors, ...recipientErrors];
        if (runtimeErrors.length > 0 || process.env.E2E_DEBUG_J === '1') {
          const diagnostics = {
            sender: await readJWatcherDiagnostics(senderPage),
            recipient: await readJWatcherDiagnostics(recipientPage),
          };
          process.stdout.write(`[PAY-SMOKE][RUNTIME-DIAGNOSTICS] ${JSON.stringify(diagnostics)}\n`);
        }
        expect(runtimeErrors, 'payment runtime pages must not emit console/page errors').toEqual([]);

        process.stdout.write(
          `[PAY-SMOKE] PASS senderAfter=${senderAfterPayment} recipientAfter=${recipientAfterPayment} amount=${PAYMENT_AMOUNT.toString()}\n`,
        );
      } finally {
        await senderContext?.close().catch(() => {});
        await recipientContext?.close().catch(() => {});
      }
    },
  );
});
