import type { RuntimeReplica, XLNModule } from '../../../core/api/public/runtime-module';
/**
 * E2E recovery coverage for standalone watchtower backups.
 *
 * Flow and goals:
 * 1. Start an external watchtower daemon with a local LevelDB.
 * 2. Create a wallet runtime, connect it to a hub, and wait until the recovery
 *    backup is durably stored off-device.
 * 3. Wipe all local browser/runtime state.
 * 4. Re-enter the same BrainVault credentials and prove the wallet restores the prior runtime
 *    state from the watchtower instead of booting as a fresh empty wallet.
 */

import { expect, test, type BrowserContext, type Page } from '../../global-setup.mts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { API_BASE_URL, APP_BASE_URL, ensureE2EBaseline } from '../../utils/e2e-baseline';
import {
  getRenderedOutboundForAccount,
  waitForRenderedOutboundForAccountDelta,
} from '../../utils/runtime/e2e-account-ui';
import { deriveBrainvaultOracle } from '../../utils/runtime/e2e-brainvault';
import { connectRuntimeToHub, waitForReceiveReadyGossipProfiles } from '../../utils/e2e-connect';
import { deriveSignerAddressFromMnemonic, gotoApp } from '../../utils/e2e-demo-users';
import { prepareUiPayment } from '../../utils/runtime/e2e-pay-ui';
import { getPersistedReceiptCursor, waitForPersistedFrameEventMatch } from '../../utils/e2e-runtime-receipts';
import { closeRuntimeContext, closeRuntimePage } from '../../utils/runtime/e2e-runtime-shutdown.mts';

type CurrentWalletWindow = Window & {
  __xln?: {
    env(): RuntimeReplica | null;
    xln(): Promise<XLNModule>;
    store: { getState(): { activeEntityId: string | null; activeVaultId: string | null } };
  };
};

const LONG_E2E = process.env.E2E_LONG === '1';
const TEST_TIMEOUT_MS = LONG_E2E ? 240_000 : 180_000;
const RECOVERY_LOOKUP_DOMAIN = 'xln:recovery:lookup:v1';
const USDC_DECIMALS = 6n;
const POST_RESTORE_PAYMENT_AMOUNT = 3n * 10n ** USDC_DECIMALS;
const CHANNEL_OP_TIMEOUT_MS = 75_000;

type WatchtowerChild = {
  process: ChildProcess;
  baseUrl: string;
  dbRoot: string;
};

function randomBrainvaultPassphrase(): string {
  const mnemonic = Wallet.createRandom().mnemonic;
  if (!mnemonic) throw new Error('RECOVERY_TEST_MNEMONIC_MISSING');
  return mnemonic.phrase;
}

function randomLabel(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function deriveRuntimeRecoveryLookupKey(runtimeId: string, runtimeSeed: string): string {
  return keccak256(toUtf8Bytes(`${RECOVERY_LOOKUP_DOMAIN}|${String(runtimeId).toLowerCase()}|${runtimeSeed}`));
}

async function expectPersistedRuntimeSeedProtected(page: Page, runtimeId: string): Promise<void> {
  const saved = await page.evaluate(
    id => ({
      activeId: (window as CurrentWalletWindow).__xln?.store.getState().activeVaultId,
      metadata: localStorage.getItem('xln-ui-vaults'),
      encrypted: localStorage.getItem(`xln-password-vault:${id}`),
    }),
    runtimeId,
  );
  expect(saved.activeId).toBe(runtimeId);
  expect(saved.metadata).not.toBeNull();
  expect(saved.metadata).not.toMatch(/"(?:seed|mnemonic12|mnemonic)"\s*:/);
  expect(saved.encrypted).not.toBeNull();
  expect(JSON.parse(saved.encrypted ?? 'null')).toMatchObject({
    version: 1,
    ciphertext: expect.any(String),
    salt: expect.any(String),
    iv: expect.any(String),
  });
}

async function waitForTowerHealth(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        const payload = (await response.json()) as { ok?: boolean; service?: string };
        if (payload.ok && payload.service === 'xln-watchtower') return;
      }
    } catch {
      // keep polling until timeout
    }
    await delay(250);
  }
  throw new Error(`Watchtower did not become healthy at ${baseUrl}`);
}

async function startWatchtower(): Promise<WatchtowerChild> {
  const port = Number(process.env.E2E_WATCHTOWER_PORT);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error('RECOVERY_LEASED_TOWER_PORT_REQUIRED');
  const dbRoot = await mkdtemp(join(tmpdir(), 'xln-watchtower-e2e-'));
  const proc = spawn(
    'bun',
    [
      'core/watchtower/standalone-server.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--db',
      join(dbRoot, 'watchtower.level'),
      '--quota-bytes',
      String(4 * 1024 * 1024),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  proc.stdout?.on('data', chunk => process.stdout.write(`[watchtower] ${chunk.toString()}`));
  proc.stderr?.on('data', chunk => process.stderr.write(`[watchtower] ${chunk.toString()}`));
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForTowerHealth(baseUrl);
  } catch (error) {
    proc.kill('SIGKILL');
    throw error;
  }
  return { process: proc, baseUrl, dbRoot };
}

async function stopWatchtower(child: WatchtowerChild | null): Promise<void> {
  if (!child) return;
  if (child.process.exitCode === null && child.process.signalCode === null) {
    child.process.kill('SIGTERM');
    const deadline = Date.now() + 5_000;
    while (child.process.exitCode === null && child.process.signalCode === null && Date.now() < deadline) {
      await delay(100);
    }
    if (child.process.exitCode === null && child.process.signalCode === null) {
      child.process.kill('SIGKILL');
      const killDeadline = Date.now() + 1_000;
      while (child.process.exitCode === null && child.process.signalCode === null && Date.now() < killDeadline)
        await delay(25);
    }
  }
  const exited = child.process.exitCode !== null || child.process.signalCode !== null;
  if (!exited) throw new Error('RECOVERY_TOWER_PROCESS_STILL_RUNNING');
  await rm(child.dbRoot, { recursive: true, force: true });
}

async function readLocalHubAccountState(page: Page, hubId: string) {
  return page.evaluate(targetHubId => {
    const debug = (window as CurrentWalletWindow).__xln;
    const env = debug?.env();
    const entityId = debug?.store.getState().activeEntityId;
    if (!env || !entityId) throw new Error('RECOVERY_ACCOUNT_OWNER_UNAVAILABLE');
    const replicas = [...env.state.eReplicas.values()].filter(replica => replica.entityId === entityId);
    const [replica] = replicas;
    if (replicas.length !== 1 || !replica) throw new Error('RECOVERY_ACCOUNT_OWNER_NOT_UNIQUE');
    const account = replica.state.accounts.get(targetHubId);
    return {
      runtimeHeight: env.state.height,
      hubId: targetHubId,
      accountExists: Boolean(account),
      currentHeight: account?.currentHeight ?? 0,
      hasPendingFrame: Boolean(account?.pendingFrame),
      usdcOffdelta: account?.state.deltas.get(1)?.offdelta.toString() ?? null,
      tokenIds: account ? [...account.state.deltas.keys()].sort((a, b) => a - b) : [],
    };
  }, hubId);
}

async function waitForLocalRuntimeIdentity(
  page: Page,
): Promise<{ entityId: string; signerId: string; runtimeId: string }> {
  await page.waitForFunction(
    () => {
      const debug = (window as CurrentWalletWindow).__xln;
      return Boolean(debug?.env()?.runtimeId && debug.store.getState().activeEntityId);
    },
    undefined,
    { timeout: 15_000 },
  );
  return page.evaluate(() => {
    const debug = (window as CurrentWalletWindow).__xln;
    const env = debug?.env();
    const entityId = debug?.store.getState().activeEntityId;
    if (!env?.runtimeId || !entityId) throw new Error('RECOVERY_CURRENT_IDENTITY_UNAVAILABLE');
    const replicas = [...env.state.eReplicas.values()].filter(replica => replica.entityId === entityId);
    const [replica] = replicas;
    if (replicas.length !== 1 || !replica) throw new Error('RECOVERY_SIGNER_NOT_UNIQUE');
    return { entityId, signerId: replica.signerId, runtimeId: env.runtimeId };
  });
}

async function getActiveRuntimeId(page: Page): Promise<string> {
  return (await waitForLocalRuntimeIdentity(page)).runtimeId;
}

async function waitForRuntimeOnline(page: Page, label: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const p2p = (window as CurrentWalletWindow).__xln?.env()?.infrastructure?.p2p;
          if (!p2p) throw new Error('RECOVERY_RUNTIME_P2P_UNAVAILABLE');
          return p2p.isConnected();
        }),
      { timeout: 15_000, message: `${label} Runtime must be online` },
    )
    .toBe(true);
}

async function faucetOffchain(page: Page, entityId: string, hubEntityId: string): Promise<void> {
  const response = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
    data: {
      userEntityId: entityId,
      userRuntimeId: await getActiveRuntimeId(page),
      hubEntityId,
      tokenId: 1,
      amount: '100',
    },
  });
  expect(response.ok(), `RECOVERY_FAUCET_FAILED:${await response.text()}`).toBe(true);
}

async function waitForSenderSpend(
  page: Page,
  counterpartyId: string,
  baseline: number,
  minSpend: number,
): Promise<number> {
  return await expect
    .poll(async () => baseline - (await getRenderedOutboundForAccount(page, counterpartyId)), {
      timeout: CHANNEL_OP_TIMEOUT_MS,
      intervals: [250, 500, 1_000],
      message: 'restored sender must spend from recovered channel state',
    })
    .toBeGreaterThanOrEqual(minSpend)
    .then(async () => getRenderedOutboundForAccount(page, counterpartyId));
}

async function createRuntimeViaUi(
  page: Page,
  label: string,
  passphrase: string,
  options: { towerUrl?: string; restore?: boolean; requireOnline?: boolean } = {},
): Promise<{ entityId: string; signerId: string; runtimeId: string }> {
  await expect(page.locator('[data-testid="gate-stack"][data-state="online"]')).toBeVisible();
  await page.getByRole('button', { name: /Create a wallet/ }).click();
  await page.getByLabel('Vault name', { exact: true }).fill(label);
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Test 1 shard', exact: true }).click();
  if (options.towerUrl) {
    await page.getByText(/Backup and dispute protection ·/).click();
    await page.getByLabel('Automatically back up this wallet').check();
    await page.getByLabel('Backup tower', { exact: true }).fill(options.towerUrl);
  }
  if (options.restore) {
    if (!options.towerUrl) throw new Error('RECOVERY_TOWER_REQUIRED');
    await page.getByTestId('restore-from-tower').check();
    await page.getByTestId('restore-tower-url').fill(options.towerUrl);
  }
  await page
    .getByRole('button', { name: options.restore ? 'Derive and restore' : 'Derive vault', exact: true })
    .click();
  await page.locator('[data-testid="nav-home"]:visible, [role="alert"]').first().waitFor({ timeout: 20_000 });
  const errors = await page.getByRole('alert').allTextContents();
  if (errors.length) throw new Error(`RECOVERY_WALLET_BOOT_FAILED:${errors.join(';')}`);
  const identity = await waitForLocalRuntimeIdentity(page);
  if (options.requireOnline !== false) await waitForRuntimeOnline(page, 'created');
  return identity;
}

async function waitForCommittedPrimaryLocalAccountState(page: Page, hubId: string) {
  await expect
    .poll(
      async () => {
        const state = await readLocalHubAccountState(page, hubId);
        return state.accountExists && state.currentHeight > 0 && !state.hasPendingFrame;
      },
      { timeout: 15_000, message: 'the selected hub Account must be committed before backup' },
    )
    .toBe(true);
  return readLocalHubAccountState(page, hubId);
}

async function waitForCommittedLocalHubAccountAdvance(
  page: Page,
  hubId: string,
  baselineHeight: number,
  label: string,
): Promise<Awaited<ReturnType<typeof readLocalHubAccountState>>> {
  await expect
    .poll(
      async () => {
        const state = await readLocalHubAccountState(page, hubId);
        return state.accountExists && !state.hasPendingFrame && state.currentHeight > baselineHeight;
      },
      {
        timeout: CHANNEL_OP_TIMEOUT_MS,
        intervals: [250, 500, 1_000],
        message: `${label} must leave the hub account committed before the next payment`,
      },
    )
    .toBe(true);

  const state = await readLocalHubAccountState(page, hubId);
  expect(state.hasPendingFrame, `${label} must not leave a pending account frame`).toBe(false);
  return state;
}

async function waitForWatchtowerReceipt(
  baseUrl: string,
  lookupKey: string,
  minHeight = 1,
): Promise<{ height: number; storedBytes: number }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/tower/receipt/${lookupKey}`);
      if (response.ok) {
        const payload = (await response.json()) as {
          ok?: boolean;
          receipt?: { height?: number; storedBytes?: number };
        };
        if (payload.ok && payload.receipt && Number(payload.receipt.height || 0) >= minHeight) {
          return {
            height: Number(payload.receipt.height || 0),
            storedBytes: Number(payload.receipt.storedBytes || 0),
          };
        }
      }
    } catch {
      // keep polling until timeout
    }
    await delay(500);
  }
  throw new Error(`watchtower receipt >= ${minHeight} did not appear for ${lookupKey.slice(0, 12)}`);
}

const recoveryPageErrors = new Map<Page, string[]>();
const captureRecoveryPageErrors = (page: Page): void => {
  const errors: string[] = [];
  recoveryPageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.once('close', () => recoveryPageErrors.delete(page));
};

async function readRecoveryUiDiagnostics(page: Page): Promise<Record<string, unknown>> {
  const browser = await page.evaluate(() => {
    const debug = (window as CurrentWalletWindow).__xln;
    const env = debug?.env();
    return {
      href: window.location.pathname,
      selectedEntityId: debug?.store.getState().activeEntityId,
      envRuntimeId: env?.runtimeId,
      envHeight: env?.state.height,
      envReplicas: [...(env?.state.eReplicas.values() ?? [])].map(replica => ({
        entityId: replica.entityId,
        signerId: replica.signerId,
      })),
      alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
      visibleButtons: Array.from(document.querySelectorAll('button'))
        .map(button => String((button as HTMLButtonElement).innerText || '').trim())
        .filter(Boolean)
        .slice(0, 12),
    };
  });
  return { ...browser, pageErrors: recoveryPageErrors.get(page) ?? [] };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<Record<string, unknown>>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(async () => {
          const diagnostics = await onTimeout().catch(error => ({
            diagnosticsError: error instanceof Error ? error.message : String(error),
          }));
          reject(new Error(`timed out after ${timeoutMs}ms :: ${JSON.stringify(diagnostics)}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test.describe('watchtower runtime recovery', () => {
  test.setTimeout(TEST_TIMEOUT_MS);

  test(
    'restores a wiped runtime from standalone tower backup and continues channel payments',
    { tag: '@resilience' },
    async ({ page, context, browser }, testInfo) => {
      captureRecoveryPageErrors(page);
      const started = Date.now();
      const mark = (stage: string) => console.log(`TOWER_STAGE ${stage} elapsedMs=${Date.now() - started}`);
      let recipientContext: BrowserContext | null = null;
      const baselineHealth = await ensureE2EBaseline(page, {
        timeoutMs: LONG_E2E ? 240_000 : 180_000,
        autoResetGraceMs: LONG_E2E ? 12_000 : 8_000,
      });
      const baselineHubId =
        baselineHealth.hubMesh?.hubIds?.[0] ?? baselineHealth.hubs?.find(hub => hub.online === true)?.entityId ?? '';
      expect(baselineHubId, 'watchtower recovery needs a live baseline hub').toMatch(/^0x[a-fA-F0-9]{64}$/);

      const tower = await startWatchtower();
      try {
        const proxy = new URL('/api/watchtower-proxy', API_BASE_URL);
        proxy.searchParams.set('target', tower.baseUrl);
        proxy.searchParams.set('path', '/healthz');
        const proxyResponse = await page.request.get(proxy.toString());
        expect(proxyResponse.ok(), `TOWER_PROXY_HEALTH:${await proxyResponse.text()}`).toBe(true);
        await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });

        const passphrase = randomBrainvaultPassphrase();
        const label = `tower-restore-${Date.now()}`;
        const brainvault = await deriveBrainvaultOracle(label, passphrase, 1);
        const runtime = await withTimeout(
          createRuntimeViaUi(page, label, passphrase, { towerUrl: tower.baseUrl }),
          75_000,
          async () => await readRecoveryUiDiagnostics(page),
        );
        expect(runtime.runtimeId.toLowerCase(), 'BrainVault UI must match the independent native oracle').toBe(
          deriveSignerAddressFromMnemonic(brainvault.mnemonic24),
        );
        mark('created');
        await expectPersistedRuntimeSeedProtected(page, runtime.runtimeId);
        await connectRuntimeToHub(page, runtime, baselineHubId, { requireOnline: false });
        const runtimeSeed = brainvault.mnemonic24;

        const lookupKey = deriveRuntimeRecoveryLookupKey(runtime.runtimeId, runtimeSeed);
        const initial = await waitForCommittedPrimaryLocalAccountState(page, baselineHubId);
        const initialBalance = await getRenderedOutboundForAccount(page, baselineHubId);
        await faucetOffchain(page, runtime.entityId, baselineHubId);
        const preWipe = await waitForCommittedLocalHubAccountAdvance(
          page,
          baselineHubId,
          initial.currentHeight,
          'pre-backup funding',
        );
        const backedUpBalance = await waitForRenderedOutboundForAccountDelta(page, baselineHubId, initialBalance, 100);
        expect(backedUpBalance).toBe(100);
        expect(preWipe.usdcOffdelta).not.toBeNull();
        expect(BigInt(preWipe.usdcOffdelta ?? '0')).not.toBe(0n);
        mark('account-committed');
        expect(preWipe.accountExists, 'pre-wipe local account must exist').toBe(true);
        expect(preWipe.hubId, 'pre-wipe local account must resolve a hub id').toBeTruthy();
        const receipt = await waitForWatchtowerReceipt(tower.baseUrl, lookupKey, preWipe.runtimeHeight);
        expect(
          receipt.height,
          'watchtower backup must cover the exact committed runtime state observed before wipe',
        ).toBeGreaterThanOrEqual(preWipe.runtimeHeight);
        mark('backup-receipt');
        expect(receipt.storedBytes, 'watchtower backup must store encrypted runtime bytes').toBeGreaterThan(0);

        await closeRuntimeContext(context);
        mark('old-profile-closed');
        context = await browser.newContext({ ignoreHTTPSErrors: true });
        expect((await context.storageState()).origins).toEqual([]);
        page = await context.newPage();
        captureRecoveryPageErrors(page);
        await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });

        const restored = await withTimeout(
          createRuntimeViaUi(page, label, passphrase, { requireOnline: false, towerUrl: tower.baseUrl, restore: true }),
          75_000,
          async () => await readRecoveryUiDiagnostics(page),
        );
        mark('restored');
        expect(restored.runtimeId.toLowerCase(), 'runtime id must stay stable across watchtower restore').toBe(
          runtime.runtimeId.toLowerCase(),
        );

        await expect
          .poll(
            async () => {
              const state = await readLocalHubAccountState(page, preWipe.hubId);
              return (
                state.accountExists &&
                !state.hasPendingFrame &&
                state.currentHeight >= preWipe.currentHeight &&
                state.tokenIds.join(',') === preWipe.tokenIds.join(',')
              );
            },
            {
              timeout: 90_000,
              intervals: [500, 1_000, 1_500],
              message: 'watchtower restore must recover the committed hub account state',
            },
          )
          .toBe(true);

        const after = await readLocalHubAccountState(page, preWipe.hubId);
        expect(after.usdcOffdelta, 'tower restore must preserve the exact funded Account delta').toBe(
          preWipe.usdcOffdelta,
        );
        expect(await getRenderedOutboundForAccount(page, preWipe.hubId)).toBe(backedUpBalance);
        expect(after.runtimeHeight, 'restored runtime height must be non-zero after tower recovery').toBeGreaterThan(0);

        const hubId = preWipe.hubId;
        await waitForRuntimeOnline(page, 'restored sender');
        await connectRuntimeToHub(page, restored, hubId, { requireOnline: false });

        recipientContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const recipientPage = await recipientContext.newPage();
        await gotoApp(recipientPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
        const recipient = await withTimeout(
          createRuntimeViaUi(recipientPage, randomLabel('tower-recipient'), randomBrainvaultPassphrase(), {
            requireOnline: false,
          }),
          75_000,
          async () => await readRecoveryUiDiagnostics(recipientPage),
        );
        await waitForRuntimeOnline(recipientPage, 'post-restore recipient');
        await connectRuntimeToHub(recipientPage, recipient, hubId, { requireOnline: false });

        await Promise.all([
          waitForReceiveReadyGossipProfiles(page, [restored.entityId, recipient.entityId, hubId], hubId),
          waitForReceiveReadyGossipProfiles(recipientPage, [restored.entityId, recipient.entityId, hubId], hubId),
        ]);

        const senderBeforeFaucet = await getRenderedOutboundForAccount(page, hubId);
        const senderCommittedBeforeFaucet = await readLocalHubAccountState(page, hubId);
        await faucetOffchain(page, restored.entityId, hubId);
        await waitForCommittedLocalHubAccountAdvance(
          page,
          hubId,
          senderCommittedBeforeFaucet.currentHeight,
          'post-restore faucet',
        );
        const senderAfterFaucet = await waitForRenderedOutboundForAccountDelta(page, hubId, senderBeforeFaucet, 100, {
          timeoutMs: CHANNEL_OP_TIMEOUT_MS,
        });

        const recipientBeforePayment = await getRenderedOutboundForAccount(recipientPage, hubId);
        const senderCursor = await getPersistedReceiptCursor(page);
        const recipientCursor = await getPersistedReceiptCursor(recipientPage);

        await prepareUiPayment(page, {
          recipientEntityId: recipient.entityId,
          amount: POST_RESTORE_PAYMENT_AMOUNT,
          tokenId: 1,
          routeEntityIds: [hubId, recipient.entityId],
        });

        const quotedSenderAmount = await page.getByTestId('pay-quote').getAttribute('data-sender-amount');
        if (!quotedSenderAmount) throw new Error('RECOVERY_PAYMENT_QUOTE_MISSING');
        const beforePayment = await readLocalHubAccountState(page, hubId);
        await expect(page.getByTestId('pay-submit')).toBeEnabled();
        await page.getByTestId('pay-submit').click();

        await Promise.all([
          waitForPersistedFrameEventMatch(page, {
            cursor: senderCursor,
            eventName: 'HtlcFinalized',
            entityId: restored.entityId,
            timeoutMs: CHANNEL_OP_TIMEOUT_MS,
            predicate: event => String(event.data?.amount || '') === POST_RESTORE_PAYMENT_AMOUNT.toString(),
          }),
          waitForPersistedFrameEventMatch(recipientPage, {
            cursor: recipientCursor,
            eventName: 'HtlcReceived',
            entityId: recipient.entityId,
            timeoutMs: CHANNEL_OP_TIMEOUT_MS,
            predicate: event => String(event.data?.amount || '') === POST_RESTORE_PAYMENT_AMOUNT.toString(),
          }),
        ]);

        const senderAfterPayment = await waitForSenderSpend(
          page,
          hubId,
          senderAfterFaucet,
          Number(POST_RESTORE_PAYMENT_AMOUNT / 10n ** USDC_DECIMALS),
        );
        const recipientAfterPayment = await waitForRenderedOutboundForAccountDelta(
          recipientPage,
          hubId,
          recipientBeforePayment,
          Number(POST_RESTORE_PAYMENT_AMOUNT / 10n ** USDC_DECIMALS),
          { timeoutMs: CHANNEL_OP_TIMEOUT_MS },
        );

        const committedPayment = await waitForCommittedLocalHubAccountAdvance(
          page,
          hubId,
          beforePayment.currentHeight,
          'post-restore payment',
        );
        if (!beforePayment.usdcOffdelta || !committedPayment.usdcOffdelta)
          throw new Error('RECOVERY_PAYMENT_DELTA_MISSING');
        const debit = BigInt(committedPayment.usdcOffdelta) - BigInt(beforePayment.usdcOffdelta);
        expect(debit < 0n ? -debit : debit, 'sender pays exactly the signed UI quote, including fees').toBe(
          BigInt(quotedSenderAmount),
        );
        expect(recipientAfterPayment - recipientBeforePayment).toBe(3);
        mark('post-restore-payment-committed');
        await closeRuntimePage(page);
        const reopenedSenderPage = await context.newPage();
        await reopenedSenderPage.goto(`${APP_BASE_URL}/app`, { waitUntil: 'domcontentloaded' });
        await reopenedSenderPage.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(reopenedSenderPage.getByRole('heading', { name: 'Unlock wallet', exact: true })).toBeVisible();
        await reopenedSenderPage.getByLabel('Password', { exact: true }).fill(passphrase);
        await reopenedSenderPage.getByRole('button', { name: 'Unlock', exact: true }).click();
        await expect(reopenedSenderPage.locator('[data-testid="nav-home"]:visible').first()).toBeVisible({
          timeout: 15_000,
        });
        await waitForRuntimeOnline(reopenedSenderPage, 'reopened restored sender');
        mark('reopened-online');
        expect(await waitForLocalRuntimeIdentity(reopenedSenderPage)).toEqual(restored);
        await expectPersistedRuntimeSeedProtected(reopenedSenderPage, restored.runtimeId);
        expect((await readLocalHubAccountState(reopenedSenderPage, hubId)).usdcOffdelta).toBe(
          committedPayment.usdcOffdelta,
        );
        await connectRuntimeToHub(reopenedSenderPage, restored, hubId, { requireOnline: false });
        await expect
          .poll(() => getRenderedOutboundForAccount(reopenedSenderPage, hubId), {
            timeout: CHANNEL_OP_TIMEOUT_MS,
            intervals: [500, 1_000, 1_500],
            message: 'post-restore payment state must survive a closed-tab restart',
          })
          .toBe(senderAfterPayment);
        await expect
          .poll(() => getRenderedOutboundForAccount(recipientPage, hubId), {
            timeout: CHANNEL_OP_TIMEOUT_MS,
            intervals: [500, 1_000, 1_500],
            message: 'recipient post-restore payment state must stay committed after sender tab restart',
          })
          .toBe(recipientAfterPayment);
        console.log(
          JSON.stringify({
            proof: 'tower-funded-recovery',
            backedUpBalance,
            quotedSenderAmount,
            senderAfterPayment,
            recipientAfterPayment,
            restoredHeight: after.runtimeHeight,
          }),
        );
        await reopenedSenderPage.screenshot({ path: testInfo.outputPath('tower-funded-recovery.png'), fullPage: true });
      } finally {
        // Close every Runtime page before stopping the tower. Parallel teardown
        // races the page's final appointment/health polls against tower shutdown
        // and turns a successful recovery into a false connection-refused error.
        const contextCleanup = await Promise.allSettled([
          closeRuntimeContext(context),
          ...(recipientContext ? [closeRuntimeContext(recipientContext)] : []),
        ]);
        const towerCleanup = await Promise.allSettled([stopWatchtower(tower)]);
        const failures = [...contextCleanup, ...towerCleanup]
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map(result => result.reason);
        if (failures.length > 0) {
          throw new AggregateError(failures, 'WATCHTOWER_E2E_CLEANUP_FAILED');
        }
      }
    },
  );
});
