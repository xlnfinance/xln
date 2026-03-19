/**
 * E2E: a separate custody daemon and custody web app run outside the wallet stack.
 *
 * Flow and goals:
 * 1. Load the custody page and prove withdraw is rejected before any credited balance exists.
 * 2. Deposit cycle A opens the wallet directly from the custody invoice.
 * 3. Deposit cycle B copies the invoice and pastes it into the wallet pay screen.
 * 5. Both deposit modes must credit custody balance from persisted receipts.
 * 6. Later withdrawals still spend only from already credited custody balance.
 *
 * The same scenario then proves the custody backend refuses withdrawals before credit exists
 * and spends only from already credited offchain funds after the deposit lands.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DaemonRpcClient, type DaemonFrameLog } from '../custody/daemon-client';
import { deriveDelta } from '../runtime/account-utils';
import { startCustodySupport, stopManagedChild, type ManagedChild } from '../runtime/orchestrator/custody-bootstrap';
import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline, resetProdServer } from './utils/e2e-baseline';
import {
  getRenderedOutboundForAccount,
  waitForRenderedOutboundForAccountDelta,
} from './utils/e2e-account-ui';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic, switchToRuntimeId } from './utils/e2e-demo-users';
import { timedStep } from './utils/e2e-timing';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const LONG_E2E = process.env.E2E_LONG === '1';
const TEST_TIMEOUT_MS = LONG_E2E ? 240_000 : 150_000;
const TOKEN_SCALE = 10n ** 18n;

type CustodyDashboardPayload = {
  headlineBalance?: {
    amountDisplay?: string;
    amountMinor?: string;
  };
  tokens?: Array<{
    tokenId?: number;
    symbol?: string;
    amountDisplay?: string;
    amountMinor?: string;
  }>;
  custody?: {
    lastSyncError?: string | null;
    lastSyncOkAt?: number | null;
  };
  activity?: Array<{
    id?: string;
    kind?: string;
    tokenId?: number;
    amountMinor?: string;
    amountDisplay?: string;
    requestedAmountMinor?: string;
    requestedAmountDisplay?: string;
    feeMinor?: string;
    feeDisplay?: string;
    status?: string;
    description?: string;
  }>;
};

type FaucetAttemptResult = {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
};

type WalletRuntimeView = typeof window & {
  isolatedEnv?: {
    runtimeId?: string;
  };
};

type SerializedDeltaSnapshot = {
  tokenId: string;
  collateral: string;
  ondelta: string;
  offdelta: string;
  leftCreditLimit: string;
  rightCreditLimit: string;
  leftAllowance: string;
  rightAllowance: string;
  leftHold: string;
  rightHold: string;
};

type OffchainCapacitySnapshot = {
  runtimeId: string;
  reason: string;
  delta: SerializedDeltaSnapshot | null;
  iAmLeft: boolean;
  replicas: Array<{
    replicaKey: string;
    entityId: string;
    signerId: string;
    accountCount: number;
    accountMatches: Array<{
      accountKey: string;
      matchesCounterparty: boolean;
      leftEntity: string;
      rightEntity: string;
      deltaKeys: string[];
    }>;
  }>;
};

const getFreePort = async (): Promise<number> => {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate dynamic port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
};

const apiUrl = (pathname: string): string => new URL(pathname, API_BASE_URL).toString();

const toWsUrl = (baseUrl: string, pathname: string): string => {
  const url = new URL(pathname, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

async function ensureRuntimeProfileDownloaded(page: Page, entityId: string): Promise<void> {
  const ok = await page.evaluate(async (targetEntityId: string) => {
    const maybeWindow = window as typeof window & {
      isolatedEnv?: {
        gossip?: {
          getProfiles?: () => Array<{ entityId?: string }>;
        };
        runtimeState?: {
          p2p?: {
            ensureProfiles?: (entityIds: string[]) => Promise<boolean>;
            refreshGossip?: () => Promise<void> | void;
          };
        };
      };
    };
    const env = maybeWindow.isolatedEnv;
    const p2p = env?.runtimeState?.p2p;
    const target = String(targetEntityId || '').toLowerCase();
    const hasProfile = (): boolean =>
      (env?.gossip?.getProfiles?.() ?? []).some(profile => String(profile.entityId || '').toLowerCase() === target);

    if (hasProfile()) return true;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15_000) {
      if (typeof p2p?.ensureProfiles === 'function') {
        try {
          const found = await p2p.ensureProfiles([target]);
          if (found && hasProfile()) return true;
        } catch {
          // best effort
        }
      }
      if (typeof p2p?.refreshGossip === 'function') {
        try {
          await p2p.refreshGossip();
        } catch {
          // best effort
        }
      }
      if (hasProfile()) return true;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return hasProfile();
  }, entityId);

  expect(ok, `runtime must download gossip profile for ${entityId.slice(0, 12)}`).toBe(true);
}

async function waitForPopupRoutesAndSubmit(popup: Page, targetEntityId: string): Promise<void> {
  const findRoutesButton = popup.getByRole('button', { name: /^Find Routes$/i });
  const firstRoute = popup.locator('.route-option').first();
  const routeError = popup.locator('.profile-preflight-error');
  await expect(findRoutesButton).toBeVisible({ timeout: 60_000 });
  await popup.waitForTimeout(1_000);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await firstRoute.isVisible().catch(() => false)) break;
    console.log(`[custody:popup] finding routes url=${popup.url()}`);
    await findRoutesButton.click();
    try {
      await expect(firstRoute).toBeVisible({ timeout: 4_000 });
      break;
    } catch {
      const errorText = (await routeError.textContent().catch(() => '') || '').trim();
      if (errorText) {
        console.log(`[custody:popup] route retry after error: ${errorText}`);
      }
      await ensureRuntimeProfileDownloaded(popup, targetEntityId).catch(() => undefined);
      await popup.waitForTimeout(1_000);
    }
  }
  if (!await firstRoute.isVisible().catch(() => false)) {
    const currentUrl = popup.url();
    const currentError = (await routeError.textContent().catch(() => '') || '').trim();
    const invoiceValue = await popup.getByLabel('Invoice').inputValue().catch(() => '');
    throw new Error(
      `Route not visible in wallet popup url=${currentUrl} error=${currentError || 'none'} invoice=${invoiceValue.slice(0, 96)}`,
    );
  }
  await popup.locator('.route-option').first().click();
  const sendOnSelectedRoute = popup.getByRole('button', { name: /^Send On Selected Route$/i });
  if (await sendOnSelectedRoute.isVisible().catch(() => false)) {
    await sendOnSelectedRoute.click();
    return;
  }
  await popup.getByRole('button', { name: /^Pay Now$/i }).click();
}

async function openWalletPayWorkspace(page: Page): Promise<void> {
  const payTab = page.getByRole('button', { name: /^Pay$/i }).first();
  await expect(payTab).toBeVisible({ timeout: 20_000 });
  await payTab.click();
  console.log(`[custody:wallet] opened pay workspace url=${page.url()}`);
  await expect(page.getByLabel('Invoice')).toBeVisible({ timeout: 20_000 });
}

async function faucetOffchain(
  page: Page,
  entityId: string,
  hubEntityId: string,
  amount = '100',
  tokenId = 1,
): Promise<void> {
  let result: FaucetAttemptResult = { ok: false, status: 0, data: { error: 'not-run' } };

  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const runtimeId = await page.evaluate(() => {
      const view = window as WalletRuntimeView;
      return view.isolatedEnv?.runtimeId ?? null;
    });
    if (!runtimeId) {
      result = { ok: false, status: 0, data: { error: 'missing runtimeId in isolatedEnv' } };
      break;
    }

    try {
      result = await page.evaluate(async (payload) => {
        const response = await fetch('/api/faucet/offchain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await response.json().catch(() => ({} as Record<string, unknown>));
        return { ok: response.status === 200, status: response.status, data: body };
      }, {
        userEntityId: entityId,
        userRuntimeId: runtimeId,
        hubEntityId,
        tokenId,
        amount,
      });
    } catch (error) {
      result = {
        ok: false,
        status: 0,
        data: { error: error instanceof Error ? error.message : String(error) },
      };
    }

    if (result.ok) break;

    const code = String(result.data.code || '');
    const status = String(result.data.status || '');
    const transient =
      result.status === 202 ||
      result.status === 409 ||
      code === 'FAUCET_TOKEN_SURFACE_NOT_READY' ||
      code === 'FAUCET_CHANNEL_NOT_READY' ||
      status === 'channel_opening' ||
      status === 'channel_not_ready';
    if (!transient || attempt === 15) break;
    await page.waitForTimeout(1000);
  }

  expect(result.ok, `offchain faucet failed: ${JSON.stringify(result.data)}`).toBe(true);
}

async function ensureRuntimeOnline(page: Page, tag: string): Promise<void> {
  const ok = await page.evaluate(async () => {
    const maybeWindow = window as typeof window & {
      isolatedEnv?: {
        runtimeState?: {
          p2p?: {
            isConnected?: () => boolean;
            connect?: () => void;
            reconnect?: () => void;
          };
        };
      };
    };
    const env = maybeWindow.isolatedEnv;
    const p2p = env?.runtimeState?.p2p;
    if (!env || !p2p) return false;

    const startedAt = Date.now();
    while (Date.now() - startedAt < 20_000) {
      if (typeof p2p.isConnected === 'function' && p2p.isConnected()) return true;
      if (typeof p2p.connect === 'function') {
        try {
          p2p.connect();
        } catch {
          // best effort
        }
      } else if (typeof p2p.reconnect === 'function') {
        try {
          p2p.reconnect();
        } catch {
          // best effort
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return typeof p2p.isConnected === 'function' && p2p.isConnected();
  });

  expect(ok, `[${tag}] runtime must be online`).toBe(true);
}

async function waitForDaemonReceiptEvent(
  daemonClient: DaemonRpcClient,
  options: {
    entityId: string;
    eventName: string;
    fromHeight?: number;
    timeoutMs?: number;
  },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  const targetEntityId = options.entityId.toLowerCase();
  const recent: string[] = [];
  let fromHeight = Math.max(1, options.fromHeight ?? 1);

  while (Date.now() - startedAt < timeoutMs) {
    const response = await daemonClient.getFrameReceipts({
      fromHeight,
      limit: 250,
      entityId: targetEntityId,
      eventNames: ['HtlcReceived', 'PaymentFinalized', 'PaymentFailed'],
    });

    for (const receipt of response.receipts) {
      for (const log of receipt.logs) {
        recent.push(`${receipt.height}:${log.message}`);
        if (recent.length > 16) recent.shift();
        if (log.message === options.eventName) return;
      }
      fromHeight = Math.max(fromHeight, receipt.height + 1);
    }

    await delay(500);
  }

  throw new Error(
    `Timed out waiting for daemon receipt ${options.eventName} on ${targetEntityId.slice(0, 12)} ` +
    `(recent=${recent.join(',') || 'none'})`,
  );
}

async function getOffchainOutboundCapacity(
  page: Page,
  ownerEntityId: string,
  counterpartyEntityId: string,
  tokenId: number,
): Promise<bigint> {
  const snapshot = await page.evaluate(
    ({ ownerEntityId, counterpartyEntityId, tokenId }) => {
      const view = window as typeof window & { isolatedEnv?: any };
      const env = view.isolatedEnv;
      const normalize = (raw: unknown): string => String(raw || '').trim().toLowerCase();
      const accountMatchesCounterparty = (account: unknown, ownerNorm: string, counterpartyNorm: string): boolean => {
        const accountRecord = account as {
          counterpartyEntityId?: unknown;
          leftEntity?: unknown;
          rightEntity?: unknown;
        };
        const directCounterparty = normalize(accountRecord?.counterpartyEntityId);
        if (directCounterparty === counterpartyNorm) return true;
        const left = normalize(accountRecord?.leftEntity);
        const right = normalize(accountRecord?.rightEntity);
        if (!left || !right) return false;
        return (left === ownerNorm && right === counterpartyNorm) || (right === ownerNorm && left === counterpartyNorm);
      };
      const serializeAmount = (value: unknown): string => String(typeof value === 'bigint' ? value : 0n);
      const serializeDelta = (delta: unknown): SerializedDeltaSnapshot | null => {
        if (!delta || typeof delta !== 'object') return null;
        const record = delta as Record<string, unknown>;
        return {
          tokenId: serializeAmount(record.tokenId),
          collateral: serializeAmount(record.collateral),
          ondelta: serializeAmount(record.ondelta),
          offdelta: serializeAmount(record.offdelta),
          leftCreditLimit: serializeAmount(record.leftCreditLimit),
          rightCreditLimit: serializeAmount(record.rightCreditLimit),
          leftAllowance: serializeAmount(record.leftAllowance),
          rightAllowance: serializeAmount(record.rightAllowance),
          leftHold: serializeAmount(record.leftHold),
          rightHold: serializeAmount(record.rightHold),
        };
      };
      if (!env?.eReplicas) {
        return {
          runtimeId: String(env?.runtimeId || ''),
          reason: 'isolatedEnv missing',
          delta: null,
          iAmLeft: false,
          replicas: [],
        } satisfies OffchainCapacitySnapshot;
      }
      const ownerNorm = String(ownerEntityId || '').trim().toLowerCase();
      const counterpartyNorm = String(counterpartyEntityId || '').trim().toLowerCase();
      const runtimeSignerNorm = String(env.runtimeId || '').trim().toLowerCase();
      const debugReplicas: OffchainCapacitySnapshot['replicas'] = [];
      for (const [replicaKey, replica] of env.eReplicas.entries()) {
        const replicaParts = String(replicaKey || '').split(':');
        const replicaEntityId = String(replicaParts[0] || '').trim().toLowerCase();
        const replicaSignerId = String(replicaParts[1] || '').trim().toLowerCase();
        const replicaDebug: OffchainCapacitySnapshot['replicas'][number] = {
          replicaKey: String(replicaKey || ''),
          entityId: replicaEntityId,
          signerId: replicaSignerId,
          accountCount: Number(replica?.state?.accounts?.size || 0),
          accountMatches: [],
        };
        debugReplicas.push(replicaDebug);
        if (replicaEntityId !== ownerNorm) continue;
        if (runtimeSignerNorm && replicaSignerId !== runtimeSignerNorm) continue;
        for (const [accountEntityId, account] of replica.state.accounts.entries()) {
          const accountKeyNorm = String(accountEntityId || '').trim().toLowerCase();
          const matchesCounterparty =
            accountKeyNorm === counterpartyNorm || accountMatchesCounterparty(account, ownerNorm, counterpartyNorm);
          const accountDebug: OffchainCapacitySnapshot['replicas'][number]['accountMatches'][number] = {
            accountKey: String(accountEntityId || ''),
            matchesCounterparty,
            leftEntity: String(account?.leftEntity || ''),
            rightEntity: String(account?.rightEntity || ''),
            deltaKeys: account?.deltas instanceof Map ? Array.from(account.deltas.keys()).map((value: unknown) => String(value)) : [],
          };
          replicaDebug.accountMatches.push(accountDebug);
          if (!matchesCounterparty) {
            continue;
          }
          const delta = account?.deltas?.get?.(tokenId);
          if (!delta) {
            return {
              runtimeId: String(env.runtimeId || ''),
              reason: 'matching account missing token delta',
              delta: null,
              iAmLeft: false,
              replicas: debugReplicas,
            } satisfies OffchainCapacitySnapshot;
          }
          return {
            runtimeId: String(env.runtimeId || ''),
            reason: 'ok',
            delta: serializeDelta(delta),
            iAmLeft: String(account.leftEntity || '').trim().toLowerCase() === ownerNorm,
            replicas: debugReplicas,
          } satisfies OffchainCapacitySnapshot;
        }
      }
      return {
        runtimeId: String(env.runtimeId || ''),
        reason: 'matching replica/account not found',
        delta: null,
        iAmLeft: false,
        replicas: debugReplicas,
      } satisfies OffchainCapacitySnapshot;
    },
    { ownerEntityId, counterpartyEntityId, tokenId },
  );
  if (!snapshot?.delta) return 0n;
  const derived = deriveDelta({
    tokenId: Number(snapshot.delta.tokenId),
    collateral: BigInt(snapshot.delta.collateral),
    ondelta: BigInt(snapshot.delta.ondelta),
    offdelta: BigInt(snapshot.delta.offdelta),
    leftCreditLimit: BigInt(snapshot.delta.leftCreditLimit),
    rightCreditLimit: BigInt(snapshot.delta.rightCreditLimit),
    leftAllowance: BigInt(snapshot.delta.leftAllowance),
    rightAllowance: BigInt(snapshot.delta.rightAllowance),
    leftHold: BigInt(snapshot.delta.leftHold),
    rightHold: BigInt(snapshot.delta.rightHold),
  }, snapshot.iAmLeft);
  return derived.outCapacity;
}

async function waitForOffchainOutboundCapacity(
  page: Page,
  ownerEntityId: string,
  counterpartyEntityId: string,
  tokenId: number,
  minimum: bigint,
  timeoutMs = 30_000,
): Promise<void> {
  let lastDebug = '';
  await expect
    .poll(
      async () => {
        const value = await getOffchainOutboundCapacity(page, ownerEntityId, counterpartyEntityId, tokenId);
        const debug = await page.evaluate(
          ({ ownerEntityId, counterpartyEntityId, tokenId }) => {
            const view = window as typeof window & { isolatedEnv?: any };
            const env = view.isolatedEnv;
            const normalize = (raw: unknown): string => String(raw || '').trim().toLowerCase();
            const accountMatchesCounterparty = (account: unknown, ownerNorm: string, counterpartyNorm: string): boolean => {
              const accountRecord = account as {
                counterpartyEntityId?: unknown;
                leftEntity?: unknown;
                rightEntity?: unknown;
              };
              const directCounterparty = normalize(accountRecord?.counterpartyEntityId);
              if (directCounterparty === counterpartyNorm) return true;
              const left = normalize(accountRecord?.leftEntity);
              const right = normalize(accountRecord?.rightEntity);
              if (!left || !right) return false;
              return (left === ownerNorm && right === counterpartyNorm) || (right === ownerNorm && left === counterpartyNorm);
            };
            if (!env?.eReplicas) {
              return { runtimeId: String(env?.runtimeId || ''), reason: 'isolatedEnv missing', replicas: [] };
            }
            const ownerNorm = String(ownerEntityId || '').trim().toLowerCase();
            const counterpartyNorm = String(counterpartyEntityId || '').trim().toLowerCase();
            const runtimeSignerNorm = String(env.runtimeId || '').trim().toLowerCase();
            const replicas: OffchainCapacitySnapshot['replicas'] = [];
            for (const [replicaKey, replica] of env.eReplicas.entries()) {
              const replicaParts = String(replicaKey || '').split(':');
              const replicaEntityId = String(replicaParts[0] || '').trim().toLowerCase();
              const replicaSignerId = String(replicaParts[1] || '').trim().toLowerCase();
              const replicaDebug: OffchainCapacitySnapshot['replicas'][number] = {
                replicaKey: String(replicaKey || ''),
                entityId: replicaEntityId,
                signerId: replicaSignerId,
                accountCount: Number(replica?.state?.accounts?.size || 0),
                accountMatches: [],
              };
              replicas.push(replicaDebug);
              if (replicaEntityId !== ownerNorm) continue;
              if (runtimeSignerNorm && replicaSignerId !== runtimeSignerNorm) continue;
              for (const [accountEntityId, account] of replica.state.accounts.entries()) {
                replicaDebug.accountMatches.push({
                  accountKey: String(accountEntityId || ''),
                  matchesCounterparty:
                    String(accountEntityId || '').trim().toLowerCase() === counterpartyNorm
                    || accountMatchesCounterparty(account, ownerNorm, counterpartyNorm),
                  leftEntity: String(account?.leftEntity || ''),
                  rightEntity: String(account?.rightEntity || ''),
                  deltaKeys: account?.deltas instanceof Map ? Array.from(account.deltas.keys()).map((item: unknown) => String(item)) : [],
                });
              }
            }
            return { runtimeId: String(env.runtimeId || ''), reason: 'debug', tokenId, replicas };
          },
          { ownerEntityId, counterpartyEntityId, tokenId },
        );
        lastDebug = JSON.stringify(debug);
        return value.toString();
      },
      {
        timeout: timeoutMs,
        intervals: [500, 750, 1000],
        message: `outbound capacity token=${tokenId} must reach ${minimum.toString()}`,
      },
    )
    .toBe(minimum.toString())
    .catch((error) => {
      const details = lastDebug.length > 0 ? ` debug=${lastDebug}` : '';
      throw new Error(`${String(error)}${details}`);
    });
}

async function getDaemonReceiptCursor(
  daemonClient: DaemonRpcClient,
  entityId: string,
): Promise<number> {
  const targetEntityId = entityId.toLowerCase();
  const response = await daemonClient.getFrameReceipts({
    fromHeight: 1,
    limit: 250,
    entityId: targetEntityId,
    eventNames: ['HtlcReceived', 'PaymentFinalized', 'PaymentFailed'],
  });
  let nextHeight = 1;
  for (const receipt of response.receipts) {
    nextHeight = Math.max(nextHeight, receipt.height + 1);
  }
  return nextHeight;
}

async function readCustodyDashboard(
  page: Page,
  custodyBaseUrl: string,
): Promise<CustodyDashboardPayload> {
  const currentUrl = page.url();
  if (!currentUrl.startsWith(custodyBaseUrl)) {
    throw new Error(`custody page navigated away from dashboard origin: ${currentUrl}`);
  }

  return await page.evaluate(async (baseUrl) => {
    const response = await fetch(new URL('/api/me', baseUrl).toString(), {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-store',
      },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`dashboard fetch failed (${response.status})`);
    }
    return await response.json();
  }, custodyBaseUrl) as CustodyDashboardPayload;
}

async function waitForCustodyBalance(
  page: Page,
  custodyBaseUrl: string,
  expectedMinor: bigint,
): Promise<CustodyDashboardPayload> {
  await expect.poll(
    async () => {
      const dashboard = await readCustodyDashboard(page, custodyBaseUrl);
      return String(dashboard.headlineBalance?.amountMinor || '0');
    },
    {
      timeout: 30_000,
      intervals: [500, 750, 1000],
      message: `custody balance must converge to ${expectedMinor.toString()}`,
    },
  ).toBe(expectedMinor.toString());

  return await readCustodyDashboard(page, custodyBaseUrl);
}

const readCustodyTokenMinor = (dashboard: CustodyDashboardPayload, tokenId: number): bigint => {
  const row = (dashboard.tokens ?? []).find((token) => Number(token.tokenId || 0) === tokenId);
  return BigInt(String(row?.amountMinor || '0'));
};

async function waitForCustodyTokenBalance(
  page: Page,
  custodyBaseUrl: string,
  tokenId: number,
  expectedMinor: bigint,
): Promise<CustodyDashboardPayload> {
  await expect.poll(
    async () => {
      const dashboard = await readCustodyDashboard(page, custodyBaseUrl);
      return readCustodyTokenMinor(dashboard, tokenId).toString();
    },
    {
      timeout: 30_000,
      intervals: [500, 750, 1000],
      message: `custody token ${tokenId} balance must converge to ${expectedMinor.toString()}`,
    },
  ).toBe(expectedMinor.toString());

  return await readCustodyDashboard(page, custodyBaseUrl);
}

async function waitForNewActivity(
  page: Page,
  custodyBaseUrl: string,
  knownIds: Set<string>,
  kind: 'deposit' | 'withdrawal',
  status?: string,
): Promise<Required<NonNullable<CustodyDashboardPayload['activity']>[number]>> {
  let found: Required<NonNullable<CustodyDashboardPayload['activity']>[number]> | null = null;
  await expect.poll(
    async () => {
      const dashboard = await readCustodyDashboard(page, custodyBaseUrl);
      const activity = Array.isArray(dashboard.activity) ? dashboard.activity : [];
      const item = activity.find((entry) => {
        const id = String(entry.id || '');
        if (entry.kind !== kind || id.length === 0 || knownIds.has(id)) return false;
        if (status && String(entry.status || '') !== status) return false;
        return true;
      });
      found = item
        ? {
            id: String(item.id || ''),
            kind: String(item.kind || ''),
            tokenId: Number(item.tokenId || 0),
            amountMinor: String(item.amountMinor || '0'),
            amountDisplay: String(item.amountDisplay || ''),
            requestedAmountMinor: String(item.requestedAmountMinor || '0'),
            requestedAmountDisplay: String(item.requestedAmountDisplay || ''),
            feeMinor: String(item.feeMinor || '0'),
            feeDisplay: String(item.feeDisplay || ''),
            status: String(item.status || ''),
            description: String(item.description || ''),
          }
        : null;
      return found !== null;
    },
    {
      timeout: 30_000,
      intervals: [500, 750, 1000],
      message: `custody must record a new ${kind} activity`,
    },
  ).toBe(true);
  return found!;
}

test.describe('E2E Custody Flow', () => {
  // Scenario: a new custody daemon joins the existing 3-hub mesh as a separate runtime, receives
  // a journal-backed deposit from a browser wallet, refuses to withdraw before funds exist, and
  // then sends a real HTLC withdrawal using only the custody service's locally credited balance.
  test('separate custody daemon credits deposits and withdraws only from credited offchain balance', async ({ browser }) => {
    test.setTimeout(TEST_TIMEOUT_MS);

    const tempRoot = await mkdtemp(join(tmpdir(), 'xln-custody-e2e-'));
    const daemonPort = await getFreePort();
    const custodyPort = await getFreePort();
    const custodyBaseUrl = `https://localhost:${custodyPort}`;
    const relayUrl = toWsUrl(API_BASE_URL, '/relay');
    const rpcProxyUrl = process.env.E2E_ANVIL_RPC ?? 'http://localhost:8545';

    let daemonChild: ManagedChild | null = null;
    let custodyChild: ManagedChild | null = null;
    let daemonClient: DaemonRpcClient | null = null;

    const context = await timedStep('custody.browser_context', () => browser.newContext({ ignoreHTTPSErrors: true }));
    let walletPage = await context.newPage();
    const custodyPage = await context.newPage();
    custodyPage.on('console', (message) => {
      console.log(`[custody:console] ${message.type()}: ${message.text()}`);
    });

    try {
      await timedStep('custody.reset_server', () => resetProdServer(walletPage, {
        apiBaseUrl: API_BASE_URL,
        timeoutMs: TEST_TIMEOUT_MS,
        softPreserveHubs: false,
      }));
      await timedStep('custody.ensure_baseline', () => ensureE2EBaseline(walletPage, {
        apiBaseUrl: API_BASE_URL,
        timeoutMs: TEST_TIMEOUT_MS,
        requireHubMesh: true,
        requireMarketMaker: false,
        minHubCount: 3,
        forceReset: true,
      }));

      const custodySupport = await timedStep('custody.start_support', () => startCustodySupport({
        apiBaseUrl: API_BASE_URL,
        daemonPort,
        custodyPort,
        relayUrl,
        rpcUrl: rpcProxyUrl,
        walletUrl: new URL('/app', APP_BASE_URL).toString(),
        dbRoot: tempRoot,
        seed: 'xln-e2e-custody-seed',
        signerLabel: 'custody-e2e-1',
        profileName: 'Custody',
        jurisdictionId: 'arrakis',
      }));
      daemonChild = custodySupport.daemonChild;
      custodyChild = custodySupport.custodyChild;
      daemonClient = new DaemonRpcClient(`ws://127.0.0.1:${daemonPort}/rpc`);
      const custodyIdentity = custodySupport.identity;
      const senderHubIds = custodySupport.hubIds.slice(0, 2);
      const fundingHubId = senderHubIds[1] ?? senderHubIds[0]!;

      await timedStep('custody.wallet.goto_app', () => gotoApp(walletPage));
      const alice = await timedStep(
        'custody.wallet.create_runtime',
        () => createRuntimeIdentity(walletPage, 'alice', selectDemoMnemonic('alice')),
      );
      for (const [index, hubId] of senderHubIds.entries()) {
        await timedStep(`custody.wallet.connect_hub_${index + 1}`, () => connectRuntimeToHub(walletPage, alice, hubId));
      }
      const walletRenderedBeforeFunding = await timedStep(
        'custody.wallet.read_rendered_out_before_faucet',
        () => getRenderedOutboundForAccount(walletPage, fundingHubId),
      );
      await timedStep('custody.wallet.faucet.usdc', () => faucetOffchain(walletPage, alice.entityId, fundingHubId, '100', 1));
      await timedStep('custody.wallet.faucet.usdt', () => faucetOffchain(walletPage, alice.entityId, fundingHubId, '30', 3));
      await timedStep(
        'custody.wallet.wait_rendered_out_after_faucet',
        () => waitForRenderedOutboundForAccountDelta(
          walletPage,
          fundingHubId,
          walletRenderedBeforeFunding,
          100,
          { timeoutMs: 20_000 },
        ),
      );
      await timedStep(
        'custody.wallet.wait_usdt_out_after_faucet',
        () => waitForOffchainOutboundCapacity(walletPage, alice.entityId, fundingHubId, 3, 30n * TOKEN_SCALE, 20_000),
      );
      await timedStep('custody.open_dashboard', () => custodyPage.goto(custodyBaseUrl));
      await expect(custodyPage.getByRole('heading', { name: 'Deposit' })).toBeVisible({ timeout: 15_000 });
      await expect(custodyPage.locator('.deposit-qr-image').first()).toBeVisible({ timeout: 60_000 });
      await expect(custodyPage.getByRole('button', { name: /^Local Wallet$/i })).toBeVisible({ timeout: 60_000 });
      await custodyPage.screenshot({ path: test.info().outputPath('custody-dashboard-initial.png'), fullPage: true });

      await custodyPage.locator('input[name="amount"]').fill('1');
      await custodyPage.locator('input[name="targetEntityId"]').fill(alice.entityId);
      await custodyPage.getByRole('button', { name: /^Withdraw$/i }).click();
      await expect(custodyPage.getByText('Insufficient custody balance')).toBeVisible({ timeout: 15_000 });

      let dashboard = await readCustodyDashboard(custodyPage, custodyBaseUrl);
      const custodyBalances = new Map<number, bigint>();
      for (const token of dashboard.tokens ?? []) {
        const tokenId = Number(token.tokenId || 0);
        if (tokenId > 0) {
          custodyBalances.set(tokenId, BigInt(String(token.amountMinor || '0')));
        }
      }
      const depositCycles = [
        { whole: 3n, tokenId: 1 },
        { whole: 10n, tokenId: 3 },
      ];

      for (const [cycleIndex, cycle] of depositCycles.entries()) {
        const knownBeforeDeposit = new Set(
          (dashboard.activity ?? [])
            .map(item => String(item.id || ''))
            .filter(Boolean),
        );

        await timedStep(`custody.deposit_cycle_${cycleIndex + 1}`, async () => {
          await custodyPage.locator('select[name="depositTokenId"]').selectOption(String(cycle.tokenId));
          await custodyPage.locator('input[name="depositAmount"]').fill(cycle.whole.toString());
          const invoice = (await custodyPage.locator('.deposit-invoice-string').first().textContent())?.trim() || '';
          const walletHref = (await custodyPage.locator('[data-open-wallet-href]').first().getAttribute('data-open-wallet-href'))?.trim() || '';
          expect(invoice.startsWith('xln:?')).toBe(true);
          expect(walletHref.includes('/app#pay?')).toBe(true);
          if (cycleIndex === 1) {
            const copyButton = custodyPage.locator('[data-copy-invoice]').first();
            await copyButton.click();
            await expect(copyButton).toHaveText(/^Copied$/i, { timeout: 5_000 });
          }
          await walletPage.bringToFront();
          await openWalletPayWorkspace(walletPage);
          const clearInvoiceButton = walletPage.getByRole('button', { name: /^Clear$/i }).first();
          if (await clearInvoiceButton.isVisible().catch(() => false)) {
            await clearInvoiceButton.click();
          }
          await walletPage.getByLabel('Invoice').fill(invoice);
          console.log(`[custody:wallet] invoice-filled cycle=${cycleIndex + 1} url=${walletPage.url()} invoice=${invoice.slice(0, 120)}`);
          await expect
            .poll(async () => {
              const current = await walletPage.getByLabel('Invoice').inputValue();
              return {
                hasId: current.includes(`id=${custodyIdentity.entityId}`),
                hasToken: current.includes(`token=${cycle.tokenId}`),
                hasAmount: current.includes(`amt=${cycle.whole.toString()}`),
              };
            }, { timeout: 5_000 })
            .toEqual({ hasId: true, hasToken: true, hasAmount: true });
          await waitForPopupRoutesAndSubmit(walletPage, custodyIdentity.entityId);
        });

        const depositMinor = cycle.whole * TOKEN_SCALE;
        const currentTokenBalance = custodyBalances.get(cycle.tokenId) ?? 0n;
        custodyBalances.set(cycle.tokenId, currentTokenBalance + depositMinor);
        await custodyPage.bringToFront();
        const depositActivity = await timedStep(`custody.deposit_cycle_${cycleIndex + 1}.wait_credit`, async () => {
          dashboard = await waitForCustodyTokenBalance(
            custodyPage,
            custodyBaseUrl,
            cycle.tokenId,
            custodyBalances.get(cycle.tokenId) ?? 0n,
          );
          return waitForNewActivity(custodyPage, custodyBaseUrl, knownBeforeDeposit, 'deposit');
        });
        expect(BigInt(depositActivity.amountMinor)).toBe(depositMinor);
        expect(Number(depositActivity.tokenId)).toBe(cycle.tokenId);
        expect(dashboard.custody?.lastSyncError ?? null).toBeNull();
      }

      const withdrawCycles = [
        { whole: 2n, tokenId: 1 },
        { whole: 4n, tokenId: 3 },
      ];
      for (const [cycleIndex, cycle] of withdrawCycles.entries()) {
        await walletPage.bringToFront();
        await ensureRuntimeOnline(walletPage, `alice-before-withdraw-cycle-${cycleIndex + 1}`);

        const knownBeforeWithdraw = new Set(
          (dashboard.activity ?? [])
            .map(item => String(item.id || ''))
            .filter(Boolean),
        );
        await custodyPage.locator('select[name="tokenId"]').selectOption(String(cycle.tokenId));
        await custodyPage.locator('input[name="amount"]').fill(cycle.whole.toString());
        await custodyPage.locator('input[name="targetEntityId"]').fill(alice.entityId);

        const withdrawalActivity = await timedStep(`custody.withdraw_cycle_${cycleIndex + 1}`, async () => {
          await custodyPage.getByRole('button', { name: /^Withdraw$/i }).click();
          await expect(custodyPage.getByText(/Queued withdrawal/i)).toBeVisible({ timeout: 15_000 });
          await custodyPage.bringToFront();
          return waitForNewActivity(
            custodyPage,
            custodyBaseUrl,
            knownBeforeWithdraw,
            'withdrawal',
            'finalized',
          );
        });
        expect(BigInt(withdrawalActivity.requestedAmountMinor)).toBe(cycle.whole * TOKEN_SCALE);
        expect(Number(withdrawalActivity.tokenId)).toBe(cycle.tokenId);
        expect(BigInt(withdrawalActivity.feeMinor)).toBeGreaterThan(0n);

        const senderSpentMinor = BigInt(withdrawalActivity.amountMinor);
        custodyBalances.set(cycle.tokenId, (custodyBalances.get(cycle.tokenId) ?? 0n) - senderSpentMinor);
        dashboard = await timedStep(
          `custody.withdraw_cycle_${cycleIndex + 1}.wait_debit`,
          () => waitForCustodyTokenBalance(
            custodyPage,
            custodyBaseUrl,
            cycle.tokenId,
            custodyBalances.get(cycle.tokenId) ?? 0n,
          ),
        );
      }
    } finally {
      await context.close();
      await daemonClient?.close();
      await stopManagedChild(custodyChild);
      await stopManagedChild(daemonChild);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
