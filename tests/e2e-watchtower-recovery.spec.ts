/**
 * E2E recovery coverage for standalone watchtower backups.
 *
 * Flow and goals:
 * 1. Start an external watchtower daemon with a local LevelDB.
 * 2. Create a wallet runtime, connect it to a hub, and wait until the recovery
 *    backup is durably stored off-device.
 * 3. Wipe all local browser/runtime state.
 * 4. Re-enter the same mnemonic and prove the wallet restores the prior runtime
 *    state from the watchtower instead of booting as a fresh empty wallet.
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { API_BASE_URL, APP_BASE_URL, ensureE2EBaseline } from './utils/e2e-baseline';
import {
  getRenderedOutboundForAccount,
  waitForRenderedOutboundForAccountDelta,
} from './utils/e2e-account-ui';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { gotoApp } from './utils/e2e-demo-users';
import { submitUiPayment } from './utils/e2e-pay-ui';
import {
  getPersistedReceiptCursor,
  waitForPersistedFrameEventMatch,
} from './utils/e2e-runtime-receipts';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const LONG_E2E = process.env.E2E_LONG === '1';
const ISOLATED_BASELINE_READY = process.env.E2E_ISOLATED_BASELINE_READY === '1';
const TEST_TIMEOUT_MS = LONG_E2E ? 240_000 : 180_000;
const RECOVERY_LOOKUP_DOMAIN = 'xln:recovery:lookup:v1';
const POST_RESTORE_PAYMENT_AMOUNT = 3n * 10n ** 18n;
const CHANNEL_OP_TIMEOUT_MS = 75_000;

type WatchtowerChild = {
  process: ChildProcess;
  baseUrl: string;
  dbRoot: string;
};

function randomMnemonic(): string {
  return Wallet.createRandom().mnemonic!.phrase;
}

function randomLabel(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function deriveRuntimeRecoveryLookupKey(runtimeId: string, runtimeSeed: string): string {
  return keccak256(toUtf8Bytes(`${RECOVERY_LOOKUP_DOMAIN}|${String(runtimeId).toLowerCase()}|${runtimeSeed}`));
}

async function readPersistedRuntimeSeed(page: Page, runtimeId: string): Promise<string> {
  const seed = await page.evaluate((targetRuntimeId) => {
    try {
      const raw = localStorage.getItem('xln-vaults');
      if (!raw) return '';
      const parsed = JSON.parse(raw) as {
        runtimes?: Record<string, { id?: string; seed?: string }>;
      };
      for (const runtime of Object.values(parsed.runtimes || {})) {
        if (String(runtime?.id || '').toLowerCase() === String(targetRuntimeId || '').toLowerCase()) {
          return String(runtime?.seed || '');
        }
      }
      return '';
    } catch {
      return '';
    }
  }, runtimeId);
  if (!seed) {
    throw new Error(`persisted runtime seed missing for ${runtimeId.slice(0, 12)}`);
  }
  return seed;
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to reserve port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForTowerHealth(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        const payload = await response.json() as { ok?: boolean; service?: string };
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
  const port = await getFreePort();
  const dbRoot = await mkdtemp(join(tmpdir(), 'xln-watchtower-e2e-'));
  const proc = spawn(
    'bun',
    [
      'runtime/watchtower/standalone-server.ts',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--db', join(dbRoot, 'watchtower.level'),
      '--quota-bytes', String(4 * 1024 * 1024),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  proc.stdout?.on('data', (chunk) => process.stdout.write(`[watchtower] ${chunk.toString()}`));
  proc.stderr?.on('data', (chunk) => process.stderr.write(`[watchtower] ${chunk.toString()}`));
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
  if (child.process.exitCode === null) {
    child.process.kill('SIGTERM');
    const deadline = Date.now() + 5_000;
    while (child.process.exitCode === null && Date.now() < deadline) {
      await delay(100);
    }
    if (child.process.exitCode === null) child.process.kill('SIGKILL');
  }
  await rm(child.dbRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function readLocalHubAccountState(page: Page, hubId: string): Promise<{
  runtimeHeight: number;
  accountExists: boolean;
  currentHeight: number;
  hasPendingFrame: boolean;
  tokenIds: number[];
}> {
  return await page.evaluate((targetHubId) => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        height?: number;
        eReplicas?: Map<string, {
          state?: {
            accounts?: Map<string, {
              currentHeight?: number;
              pendingFrame?: unknown;
              deltas?: Map<number, unknown>;
            }>;
          };
        }>;
      };
    }).isolatedEnv;
    const runtimeId = String(env?.runtimeId || '').toLowerCase();
    if (!env?.eReplicas) {
      return {
        runtimeHeight: 0,
        accountExists: false,
        currentHeight: 0,
        hasPendingFrame: false,
        tokenIds: [],
      };
    }
    for (const [key, replica] of env.eReplicas.entries()) {
      const [, signerId] = String(key).split(':');
      if (String(signerId || '').toLowerCase() !== runtimeId) continue;
      const account = replica?.state?.accounts?.get?.(targetHubId);
      if (!account) continue;
      const tokenIds = account.deltas instanceof Map
        ? Array.from(account.deltas.keys()).map((tokenId) => Number(tokenId)).sort((a, b) => a - b)
        : [];
      return {
        runtimeHeight: Number(env.height || 0),
        accountExists: true,
        currentHeight: Number(account.currentHeight || 0),
        hasPendingFrame: !!account.pendingFrame,
        tokenIds,
      };
    }
    return {
      runtimeHeight: Number(env.height || 0),
      accountExists: false,
      currentHeight: 0,
      hasPendingFrame: false,
      tokenIds: [],
    };
  }, hubId);
}

async function readPrimaryLocalAccountState(page: Page): Promise<{
  runtimeHeight: number;
  hubId: string | null;
  accountExists: boolean;
  currentHeight: number;
  hasPendingFrame: boolean;
  tokenIds: number[];
}> {
  return await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        height?: number;
        eReplicas?: Map<string, {
          state?: {
            accounts?: Map<string, {
              currentHeight?: number;
              pendingFrame?: unknown;
              deltas?: Map<number, unknown>;
            }>;
          };
        }>;
      };
    }).isolatedEnv;
    const runtimeId = String(env?.runtimeId || '').toLowerCase();
    const fallback = {
      runtimeHeight: Number(env?.height || 0),
      hubId: null,
      accountExists: false,
      currentHeight: 0,
      hasPendingFrame: false,
      tokenIds: [] as number[],
    };
    if (!(env?.eReplicas instanceof Map)) return fallback;

    for (const [key, replica] of env.eReplicas.entries()) {
      const [, signerId] = String(key).split(':');
      if (String(signerId || '').toLowerCase() !== runtimeId) continue;
      if (!(replica?.state?.accounts instanceof Map) || replica.state.accounts.size === 0) continue;
      let best: {
        hubId: string;
        currentHeight: number;
        hasPendingFrame: boolean;
        tokenIds: number[];
      } | null = null;
      for (const [hubId, account] of replica.state.accounts.entries()) {
        const candidate = {
          hubId,
          currentHeight: Number(account?.currentHeight || 0),
          hasPendingFrame: Boolean(account?.pendingFrame),
          tokenIds: account?.deltas instanceof Map
            ? Array.from(account.deltas.keys()).map((tokenId) => Number(tokenId)).sort((a, b) => a - b)
            : [],
        };
        if (!best || candidate.currentHeight > best.currentHeight) {
          best = candidate;
        }
      }
      if (!best) return fallback;
      return {
        runtimeHeight: Number(env?.height || 0),
        hubId: best.hubId,
        accountExists: true,
        currentHeight: best.currentHeight,
        hasPendingFrame: best.hasPendingFrame,
        tokenIds: best.tokenIds,
      };
    }
    return fallback;
  });
}

async function waitForLocalRuntimeIdentity(page: Page): Promise<{ entityId: string; signerId: string; runtimeId: string }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => {
      const env = (window as typeof window & {
        isolatedEnv?: {
          runtimeId?: string;
          eReplicas?: Map<string, unknown>;
        };
      }).isolatedEnv;
      const runtimeId = String(env?.runtimeId || '').toLowerCase();
      if (!runtimeId || !(env?.eReplicas instanceof Map) || env.eReplicas.size === 0) {
        return null;
      }
      for (const key of env.eReplicas.keys()) {
        const [entityId, signerId] = String(key).split(':');
        if (
          /^0x[a-fA-F0-9]{64}$/.test(entityId || '')
          && /^0x[a-fA-F0-9]{40}$/.test(signerId || '')
          && String(signerId || '').toLowerCase() === runtimeId
        ) {
          return {
            entityId,
            signerId,
            runtimeId,
          };
        }
      }
      return null;
    });
    if (result) return result;
    await page.waitForTimeout(500);
  }
  throw new Error('local runtime identity must appear in isolatedEnv');
}

async function getActiveRuntimeId(page: Page): Promise<string> {
  const runtimeId = await page.evaluate(() => {
    const fromUi = document.querySelector<HTMLElement>('[data-testid="context-current"]')?.dataset?.runtimeId;
    if (fromUi) return String(fromUi).trim();
    return String((window as typeof window & { isolatedEnv?: { runtimeId?: string } }).isolatedEnv?.runtimeId || '').trim();
  });
  expect(runtimeId, 'active runtime id must be visible after tower restore').toBeTruthy();
  return runtimeId;
}

async function waitForRuntimeOnline(page: Page, label: string): Promise<void> {
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const env = (window as typeof window & {
          isolatedEnv?: {
            runtimeState?: {
              p2p?: {
                isConnected?: () => boolean;
                connect?: () => void;
                reconnect?: () => void;
              };
            };
          };
        }).isolatedEnv;
        const p2p = env?.runtimeState?.p2p;
        if (!p2p) return false;
        if (typeof p2p.isConnected === 'function' && p2p.isConnected()) return true;
        if (typeof p2p.connect === 'function') {
          try { p2p.connect(); } catch {}
        } else if (typeof p2p.reconnect === 'function') {
          try { p2p.reconnect(); } catch {}
        }
        return false;
      }).catch(() => false);
    }, {
      timeout: 30_000,
      intervals: [250, 500, 1_000],
      message: `${label} runtime must reconnect after restore`,
    })
    .toBe(true);
}

async function waitForEntityAdvertised(page: Page, entityId: string, timeoutMs = CHANNEL_OP_TIMEOUT_MS): Promise<void> {
  await expect
    .poll(async () => {
      const local = await page.evaluate((targetEntityId) => {
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
        return profiles.some((profile) =>
          String(profile?.entityId || '').toLowerCase() === String(targetEntityId || '').toLowerCase()
          && Boolean(profile?.runtimeId || profile?.metadata?.runtimeId),
        );
      }, entityId).catch(() => false);
      if (local) return true;

      const response = await page.request.get(
        `${API_BASE_URL}/api/debug/entities?limit=5000&q=${encodeURIComponent(entityId)}`,
      ).catch(() => null);
      if (!response?.ok()) return false;
      const body = await response.json().catch(() => ({})) as { entities?: Array<{ entityId?: string; runtimeId?: string }> };
      return (Array.isArray(body.entities) ? body.entities : []).some((entry) =>
        String(entry.entityId || '').toLowerCase() === entityId.toLowerCase() && Boolean(entry.runtimeId),
      );
    }, {
      timeout: timeoutMs,
      intervals: [500, 1_000, 1_500],
      message: `entity ${entityId.slice(0, 10)} must be advertised for post-restore payment`,
    })
    .toBe(true);
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
    if (response.ok()) return;
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

  throw new Error(`post-restore faucet failed for ${entityId.slice(0, 10)} via ${hubEntityId.slice(0, 10)}: ${lastError}`);
}

async function waitForSenderSpend(
  page: Page,
  counterpartyId: string,
  baseline: number,
  minSpend: number,
): Promise<number> {
  return await expect
    .poll(async () => baseline - await getRenderedOutboundForAccount(page, counterpartyId), {
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
  secret: string,
  options: { requireOnline?: boolean } = {},
): Promise<{ entityId: string; signerId: string; runtimeId: string }> {
  const displayNameInput = page.locator('#name').first();
  await expect(displayNameInput).toBeVisible({ timeout: 20_000 });
  await displayNameInput.fill(label);

  const passphraseInput = page.locator('#passphrase').first();
  const mnemonicInput = page.locator('#mnemonic').first();
  if (await passphraseInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await passphraseInput.fill(secret);
  } else {
    await expect(mnemonicInput).toBeVisible({ timeout: 15_000 });
    await mnemonicInput.fill(secret);
  }

  const factorOneButton = page.getByRole('button', { name: /^1\s+/i }).first();
  if (await factorOneButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await factorOneButton.click({ force: true });
  }

  const createButton = page.getByRole('button', { name: /Create XLN wallet|Open XLN wallet|Open \/ restore wallet/i }).first();
  await expect(createButton).toBeEnabled({ timeout: 15_000 });
  await createButton.click({ force: true });
  await page.waitForTimeout(400);

  const restoreButton = page.getByRole('button', { name: /Restore selected backup/i }).first();
  const freshButton = page.getByRole('button', { name: /Create new wallet/i }).first();
  const decision = await Promise.race([
    restoreButton.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'restore').catch(() => 'none'),
    freshButton.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'fresh').catch(() => 'none'),
    page.getByRole('checkbox', {
      name: /I understand this is testnet software and I accept the associated risks/i,
    }).first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'ready').catch(() => 'none'),
  ]);
  if (decision === 'restore') {
    await restoreButton.click({ force: true });
  } else if (decision === 'fresh') {
    await freshButton.click({ force: true });
  }

  const termsCheckbox = page.getByRole('checkbox', {
    name: /I understand this is testnet software and I accept the associated risks/i,
  }).first();
  await expect(termsCheckbox).toBeVisible({ timeout: 75_000 });
  const checked = await termsCheckbox.isChecked().catch(() => false);
  if (!checked) {
    await termsCheckbox.check({ force: true });
  }

  const startButton = page.getByRole('button', { name: /^Start$/i }).first();
  await expect(startButton).toBeEnabled({ timeout: 15_000 });
  await startButton.click({ force: true });

  const identity = await waitForLocalRuntimeIdentity(page);
  if (options.requireOnline !== false) {
    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const env = (window as typeof window & {
            isolatedEnv?: {
              runtimeState?: {
                p2p?: {
                  isConnected?: () => boolean;
                  connect?: () => void;
                  reconnect?: () => void;
                };
              };
            };
          }).isolatedEnv;
          const p2p = env?.runtimeState?.p2p;
          if (!env || !p2p) return false;
          if (typeof p2p.isConnected === 'function' && p2p.isConnected()) return true;
          const start = typeof p2p.connect === 'function' ? p2p.connect : p2p.reconnect;
          if (typeof start === 'function') {
            setTimeout(() => {
              try { start.call(p2p); } catch {}
            }, 0);
          }
          return false;
        }).catch(() => false);
      }, {
        timeout: 20_000,
        intervals: [250, 500, 1_000],
        message: 'runtime must come online after creation',
      })
      .toBe(true);
  }
  return identity;
}

async function waitForCommittedPrimaryLocalAccountState(page: Page) {
  const deadline = Date.now() + 90_000;
  let last: Awaited<ReturnType<typeof readPrimaryLocalAccountState>> | null = null;
  while (Date.now() < deadline) {
    last = await readPrimaryLocalAccountState(page);
    if (last.accountExists && last.hubId && last.currentHeight > 0 && !last.hasPendingFrame) return last;
    await delay(500);
  }
  throw new Error(`local hub account did not reach committed pre-wipe state: ${JSON.stringify(last)}`);
}

async function waitForCommittedLocalHubAccountAdvance(
  page: Page,
  hubId: string,
  baselineHeight: number,
  label: string,
): Promise<Awaited<ReturnType<typeof readLocalHubAccountState>>> {
  await expect
    .poll(async () => {
      const state = await readLocalHubAccountState(page, hubId);
      return state.accountExists
        && !state.hasPendingFrame
        && state.currentHeight > baselineHeight;
    }, {
      timeout: CHANNEL_OP_TIMEOUT_MS,
      intervals: [250, 500, 1_000],
      message: `${label} must leave the hub account committed before the next payment`,
    })
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
        const payload = await response.json() as {
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

async function wipeBrowserRuntimeState(page: Page, context: BrowserContext, towerUrls: string[]): Promise<Page> {
  await page.evaluate(async (urls) => {
    const formatError = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    const view = window as typeof window & {
      XLN?: {
        stopP2P?: (env: unknown) => void;
        closeRuntimeDb?: (env: unknown) => Promise<void>;
        closeInfraDb?: (env: unknown) => Promise<void>;
      };
      __xln_instance?: {
        stopP2P?: (env: unknown) => void;
        closeRuntimeDb?: (env: unknown) => Promise<void>;
        closeInfraDb?: (env: unknown) => Promise<void>;
      };
      __XLN_WATCHTOWERS__?: string[];
      isolatedEnv?: {
        jReplicas?: Map<string, {
          jadapter?: {
            stopWatching?: () => void;
          };
        }>;
        runtimeState?: {
          stopLoop?: () => void;
          loopActive?: boolean;
        };
      };
    };
    const errors: string[] = [];
    const env = view.isolatedEnv;
    const xln = view.XLN || view.__xln_instance;
    if (!env) throw new Error('Cannot wipe runtime state: isolatedEnv missing');
    if (typeof xln?.closeRuntimeDb !== 'function' || typeof xln.closeInfraDb !== 'function') {
      throw new Error('Cannot wipe runtime state: DB close API missing');
    }

    // This is a real device wipe for the recovery test. Stop the live runtime
    // before closing the tab. The browser releases any hidden bootstrap DB
    // handles when the tab closes; /resetdb then performs the real storage wipe
    // from a fresh page with no live runtime holding IndexedDB locks.
    try {
      for (const replica of env?.jReplicas?.values?.() || []) {
        replica.jadapter?.stopWatching?.();
      }
    } catch (error) {
      errors.push(`stop watchers: ${formatError(error)}`);
    }
    try {
      xln?.stopP2P?.(env);
    } catch (error) {
      errors.push(`stop p2p: ${formatError(error)}`);
    }
    try {
      await xln.closeRuntimeDb(env);
      await xln.closeInfraDb(env);
    } catch (error) {
      errors.push(`close runtime db: ${formatError(error)}`);
    }
    try {
      env?.runtimeState?.stopLoop?.();
      if (env?.runtimeState) env.runtimeState.loopActive = false;
    } catch (error) {
      errors.push(`stop runtime loop: ${formatError(error)}`);
    }
    if (errors.length > 0) {
      throw new Error(`Failed to stop runtime before wipe: ${errors.join(' | ')}`);
    }
    view.__XLN_WATCHTOWERS__ = urls;
  }, towerUrls);
  await page.close();
  const nextPage = await context.newPage();
  await nextPage.addInitScript((urls: string[]) => {
    window.localStorage.setItem('xln-watchtower-urls', JSON.stringify(urls));
    (window as typeof window & { __XLN_WATCHTOWERS__?: string[] }).__XLN_WATCHTOWERS__ = urls;
  }, towerUrls);
  const resetNonce = '0123456789abcdef0123456789abcdef';
  await context.addCookies([{
    name: 'xln_reset_confirm',
    value: resetNonce,
    url: `${APP_BASE_URL}/resetdb`,
    sameSite: 'Strict',
  }]);
  await nextPage.goto(`${APP_BASE_URL}/resetdb?returnTo=/app&confirm=${resetNonce}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return nextPage;
}

async function readRecoveryUiDiagnostics(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const selectedTrigger = document.querySelector<HTMLElement>('[data-testid="context-current"]');
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        height?: number;
        eReplicas?: Map<string, unknown>;
        jReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    return {
      href: window.location.href,
      bodyText: String(document.body?.innerText || '').slice(0, 800),
      selectedRuntimeId: String(selectedTrigger?.dataset?.runtimeId || ''),
      selectedEntityId: String(selectedTrigger?.dataset?.entityId || ''),
      selectedSignerId: String(selectedTrigger?.dataset?.signerId || ''),
      envRuntimeId: String(env?.runtimeId || ''),
      envHeight: Number(env?.height || 0),
      envReplicaCount: Number(env?.eReplicas?.size || 0),
      envJurisdictionCount: Number(env?.jReplicas?.size || 0),
      visibleButtons: Array.from(document.querySelectorAll('button'))
        .map((button) => String((button as HTMLButtonElement).innerText || '').trim())
        .filter(Boolean)
        .slice(0, 12),
    };
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Promise<Record<string, unknown>>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(async () => {
          const diagnostics = await onTimeout().catch((error) => ({
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

  test('restores a wiped runtime from standalone tower backup and continues channel payments', async ({ page, context, browser }) => {
    let recipientContext: BrowserContext | null = null;
    if (!ISOLATED_BASELINE_READY && process.env.E2E_RESET_BASE_URL) {
      await ensureE2EBaseline(page, {
        timeoutMs: LONG_E2E ? 240_000 : 180_000,
        autoResetGraceMs: LONG_E2E ? 12_000 : 8_000,
      });
    }

    const tower = await startWatchtower();
    try {
      await context.addInitScript((towerUrl: string) => {
        window.localStorage.setItem('xln-watchtower-urls', JSON.stringify([towerUrl]));
        (window as typeof window & { __XLN_WATCHTOWERS__?: string[] }).__XLN_WATCHTOWERS__ = [towerUrl];
      }, tower.baseUrl);
      await page.addInitScript((towerUrl: string) => {
        window.localStorage.setItem('xln-watchtower-urls', JSON.stringify([towerUrl]));
        (window as typeof window & { __XLN_WATCHTOWERS__?: string[] }).__XLN_WATCHTOWERS__ = [towerUrl];
      }, tower.baseUrl);

      await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });

      const mnemonic = randomMnemonic();
      const label = `tower-restore-${Date.now()}`;
      const runtime = await withTimeout(
        createRuntimeViaUi(page, label, mnemonic),
        75_000,
        async () => await readRecoveryUiDiagnostics(page),
      );
      const runtimeSeed = await readPersistedRuntimeSeed(page, runtime.runtimeId);

      const lookupKey = deriveRuntimeRecoveryLookupKey(runtime.runtimeId, runtimeSeed);
      const preWipe = await waitForCommittedPrimaryLocalAccountState(page);
      expect(preWipe.accountExists, 'pre-wipe local account must exist').toBe(true);
      expect(preWipe.hubId, 'pre-wipe local account must resolve a hub id').toBeTruthy();
      const receipt = await waitForWatchtowerReceipt(tower.baseUrl, lookupKey, preWipe.runtimeHeight);
      expect(receipt.height, 'watchtower backup must include the committed pre-wipe runtime height').toBeGreaterThanOrEqual(preWipe.runtimeHeight);
      expect(receipt.storedBytes, 'watchtower backup must store encrypted runtime bytes').toBeGreaterThan(0);

      page = await wipeBrowserRuntimeState(page, context, [tower.baseUrl]);
      await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
      await expect
        .poll(async () => await page.evaluate(() => {
          const w = window as typeof window & { __XLN_WATCHTOWERS__?: string[] };
          return Array.isArray(w.__XLN_WATCHTOWERS__) ? w.__XLN_WATCHTOWERS__[0] || '' : '';
        }), {
          timeout: 10_000,
          intervals: [100, 250, 500],
          message: 'standalone tower override must survive resetdb navigation',
        })
        .toBe(tower.baseUrl);

      const restored = await withTimeout(
        createRuntimeViaUi(page, label, mnemonic, { requireOnline: false }),
        75_000,
        async () => await readRecoveryUiDiagnostics(page),
      );
      expect(restored.runtimeId.toLowerCase(), 'runtime id must stay stable across watchtower restore').toBe(runtime.runtimeId.toLowerCase());

      await expect
        .poll(() => readLocalHubAccountState(page, preWipe.hubId!), {
          timeout: 90_000,
          intervals: [500, 1_000, 1_500],
          message: 'watchtower restore must recover the committed hub account state',
        })
        .toMatchObject({
          accountExists: true,
          hasPendingFrame: preWipe.hasPendingFrame,
          currentHeight: preWipe.currentHeight,
          tokenIds: preWipe.tokenIds,
      });

      const after = await readLocalHubAccountState(page, preWipe.hubId!);
      expect(after.runtimeHeight, 'restored runtime height must be non-zero after tower recovery').toBeGreaterThan(0);

      const hubId = preWipe.hubId!;
      await waitForRuntimeOnline(page, 'restored sender');
      await connectRuntimeToHub(page, restored, hubId, { requireOnline: false });

      recipientContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const recipientPage = await recipientContext.newPage();
      await gotoApp(recipientPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
      const recipient = await withTimeout(
        createRuntimeViaUi(recipientPage, randomLabel('tower-recipient'), randomMnemonic(), { requireOnline: false }),
        75_000,
        async () => await readRecoveryUiDiagnostics(recipientPage),
      );
      await waitForRuntimeOnline(recipientPage, 'post-restore recipient');
      await connectRuntimeToHub(recipientPage, recipient, hubId, { requireOnline: false });

      await Promise.all([
        waitForEntityAdvertised(page, restored.entityId),
        waitForEntityAdvertised(page, recipient.entityId),
        waitForEntityAdvertised(recipientPage, restored.entityId),
        waitForEntityAdvertised(recipientPage, recipient.entityId),
      ]);

      const senderBeforeFaucet = await getRenderedOutboundForAccount(page, hubId);
      const senderCommittedBeforeFaucet = await readLocalHubAccountState(page, hubId);
      await faucetOffchain(page, restored.entityId, hubId);
      const senderAfterFaucet = await waitForRenderedOutboundForAccountDelta(page, hubId, senderBeforeFaucet, 100, {
        timeoutMs: CHANNEL_OP_TIMEOUT_MS,
      });
      await waitForCommittedLocalHubAccountAdvance(
        page,
        hubId,
        senderCommittedBeforeFaucet.currentHeight,
        'post-restore faucet',
      );

      const recipientBeforePayment = await getRenderedOutboundForAccount(recipientPage, hubId);
      const senderCursor = await getPersistedReceiptCursor(page);
      const recipientCursor = await getPersistedReceiptCursor(recipientPage);

      await submitUiPayment(page, {
        recipientEntityId: recipient.entityId,
        amount: POST_RESTORE_PAYMENT_AMOUNT,
        routeEntityIds: [hubId, recipient.entityId],
      });

      await Promise.all([
        waitForPersistedFrameEventMatch(page, {
          cursor: senderCursor,
          eventName: 'HtlcFinalized',
          entityId: restored.entityId,
          timeoutMs: CHANNEL_OP_TIMEOUT_MS,
          predicate: (event) => String(event.data?.amount || '') === POST_RESTORE_PAYMENT_AMOUNT.toString(),
        }),
        waitForPersistedFrameEventMatch(recipientPage, {
          cursor: recipientCursor,
          eventName: 'HtlcReceived',
          entityId: recipient.entityId,
          timeoutMs: CHANNEL_OP_TIMEOUT_MS,
          predicate: (event) => String(event.data?.amount || '') === POST_RESTORE_PAYMENT_AMOUNT.toString(),
        }),
      ]);

      const senderAfterPayment = await waitForSenderSpend(
        page,
        hubId,
        senderAfterFaucet,
        Number(POST_RESTORE_PAYMENT_AMOUNT / 10n ** 18n),
      );
      const recipientAfterPayment = await waitForRenderedOutboundForAccountDelta(
        recipientPage,
        hubId,
        recipientBeforePayment,
        Number(POST_RESTORE_PAYMENT_AMOUNT / 10n ** 18n),
        { timeoutMs: CHANNEL_OP_TIMEOUT_MS },
      );

      await page.close();
      const reopenedSenderPage = await context.newPage();
      await gotoApp(reopenedSenderPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
      await waitForRuntimeOnline(reopenedSenderPage, 'reopened restored sender');
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
    } finally {
      await recipientContext?.close().catch(() => undefined);
      await stopWatchtower(tower);
    }
  });
});
