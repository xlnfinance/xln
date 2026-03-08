/**
 * E2E: a separate custody daemon and custody web app run outside the wallet stack.
 *
 * Flow and goals:
 * 1. Load the custody page, enter a deposit amount, and click `Deposit with XLN`.
 * 2. The custody app opens the wallet in dedicated `#pay` mode inside a new page.
 * 3. The wallet auto-opens the pay form, scrolls the hosted checkout into view, and pre-finds routes.
 * 4. The user only confirms with `Pay Now`.
 * 5. A clear success state appears and the wallet page auto-closes after persisted confirmation.
 * 6. The custody page keeps polling persisted receipts and updates the hero balance after deposit finalization.
 * 7. The wallet can reload from persisted state and still receive a later custody withdrawal.
 *
 * The same scenario then proves the custody backend refuses withdrawals before credit exists
 * and spends only from already credited offchain funds after the deposit lands.
 */

import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deserializeTaggedJson } from '../runtime/serialization-utils';
import { DaemonRpcClient, type DaemonFrameLog } from '../custody/daemon-client';
import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline, resetProdServer } from './utils/e2e-baseline';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic, switchToRuntimeId } from './utils/e2e-demo-users';
import { getPersistedReceiptCursor, waitForPersistedFrameEvent } from './utils/e2e-runtime-receipts';

const LONG_E2E = process.env.E2E_LONG === '1';
const TEST_TIMEOUT_MS = LONG_E2E ? 240_000 : 150_000;
const CHILD_READY_TIMEOUT_MS = 60_000;
const LOG_TAIL_LINES = 80;

type DebugEntitySummary = {
  entityId?: string;
  isHub?: boolean;
  online?: boolean;
  name?: string;
  accounts?: unknown[];
  publicAccounts?: unknown[];
};

type DebugEntitiesResponse = {
  entities?: DebugEntitySummary[];
};

type ManagedIdentity = {
  entityId: string;
  signerId: string;
  name: string;
};

type DaemonControlCliResult = {
  ok: boolean;
  command: string;
  result: ManagedIdentity;
};

type ManagedChild = {
  name: string;
  proc: ChildProcessWithoutNullStreams;
  stdoutLines: string[];
  stderrLines: string[];
};

type CustodyDashboardPayload = {
  headlineBalance?: {
    amountDisplay?: string;
  };
  custody?: {
    lastSyncError?: string | null;
    lastSyncOkAt?: number | null;
  };
  activity?: Array<{
    kind?: string;
    amountDisplay?: string;
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
    eReplicas?: Map<string, {
      state?: {
        accounts?: Map<string, {
          deltas?: Map<number, unknown>;
        }>;
      };
    }>;
  };
  XLN?: {
    deriveDelta?: (delta: unknown, leftSide: boolean) => {
      outCapacity?: { toString?: () => string } | bigint | string | number;
    };
  };
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

const tailLines = (lines: string[]): string => lines.slice(-LOG_TAIL_LINES).join('\n');

const spawnChild = (
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ManagedChild => {
  const proc = spawn('bun', args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const pushLines = (buffer: Buffer, target: string[]) => {
    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      target.push(trimmed);
      if (target.length > 500) target.shift();
    }
  };

  proc.stdout.on('data', chunk => pushLines(chunk, stdoutLines));
  proc.stderr.on('data', chunk => pushLines(chunk, stderrLines));

  return { name, proc, stdoutLines, stderrLines };
};

const stopChild = async (child: ManagedChild | null): Promise<void> => {
  if (!child || child.proc.exitCode !== null) return;
  child.proc.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (child.proc.exitCode === null && Date.now() < deadline) {
    await delay(100);
  }
  if (child.proc.exitCode === null) {
    child.proc.kill('SIGKILL');
    await delay(200);
  }
};

const waitForHttpReady = async (
  url: string,
  child: ManagedChild,
  timeoutMs = CHILD_READY_TIMEOUT_MS,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not-started';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      lastError = `status=${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (child.proc.exitCode !== null) {
      throw new Error(
        `${child.name} exited early with code=${String(child.proc.exitCode)}\n` +
        `stdout:\n${tailLines(child.stdoutLines)}\n\nstderr:\n${tailLines(child.stderrLines)}`,
      );
    }
    await delay(250);
  }

  throw new Error(
    `${child.name} did not become ready at ${url}: ${lastError}\n` +
    `stdout:\n${tailLines(child.stdoutLines)}\n\nstderr:\n${tailLines(child.stderrLines)}`,
  );
};

const runDaemonControl = async (
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<DaemonControlCliResult> => {
  return await new Promise<DaemonControlCliResult>((resolve, reject) => {
    const proc = spawn('bun', ['runtime/scripts/daemon-control.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) {
        reject(
          new Error(
            `daemon-control failed code=${String(code)}\nstdout:\n${stdout.trim()}\n\nstderr:\n${stderr.trim()}`,
          ),
        );
        return;
      }
      const lines = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        reject(new Error(`daemon-control returned no payload\nstderr:\n${stderr.trim()}`));
        return;
      }
      try {
        resolve(deserializeTaggedJson<DaemonControlCliResult>(lastLine));
      } catch (error) {
        reject(
          new Error(
            `Failed to parse daemon-control payload: ${error instanceof Error ? error.message : String(error)}\n` +
            `stdout:\n${stdout.trim()}\n\nstderr:\n${stderr.trim()}`,
          ),
        );
      }
    });
  });
};

const apiUrl = (pathname: string): string => new URL(pathname, API_BASE_URL).toString();

const toWsUrl = (baseUrl: string, pathname: string): string => {
  const url = new URL(pathname, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

async function fetchDebugEntities(page: Page): Promise<DebugEntitySummary[]> {
  const response = await page.request.get(apiUrl('/api/debug/entities?limit=5000'));
  expect(response.ok(), 'debug entities endpoint must be reachable').toBe(true);
  const body = await response.json() as DebugEntitiesResponse;
  return Array.isArray(body.entities) ? body.entities : [];
}

async function discoverHubIds(page: Page): Promise<string[]> {
  const entities = await fetchDebugEntities(page);
  return entities
    .filter((entry): entry is DebugEntitySummary & { entityId: string } => entry.isHub === true && typeof entry.entityId === 'string')
    .map(entry => entry.entityId.toLowerCase())
    .slice(0, 3);
}

async function waitForDebugEntity(
  page: Page,
  entityId: string,
  predicate: (entry: DebugEntitySummary) => boolean,
  message: string,
): Promise<void> {
  const normalized = entityId.toLowerCase();
  await expect.poll(
    async () => {
      const entities = await fetchDebugEntities(page);
      const match = entities.find(entry => String(entry.entityId || '').toLowerCase() === normalized);
      if (!match) return null;
      return predicate(match)
        ? {
            online: match.online === true,
            accounts: Array.isArray(match.accounts) ? match.accounts.length : 0,
            publicAccounts: Array.isArray(match.publicAccounts) ? match.publicAccounts.length : 0,
          }
        : null;
    },
    {
      timeout: 30_000,
      intervals: [500, 750, 1000],
      message,
    },
  ).not.toBeNull();
}

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

async function submitHostedCheckoutPayment(page: Page): Promise<void> {
  await expect(page.getByText('Hosted Checkout')).toBeVisible({ timeout: 15_000 });
  const hashlockModeButton = page.getByRole('button', { name: 'Hashlock', exact: true });
  await expect(hashlockModeButton).toBeVisible({ timeout: 15_000 });
  await expect(hashlockModeButton).toHaveAttribute('aria-pressed', 'true');
  const payNowButton = page.getByRole('button', { name: 'Pay Now', exact: true });
  await expect(payNowButton).toBeEnabled({ timeout: 30_000 });
  await payNowButton.click();
}

async function waitForHostedCheckoutSuccess(page: Page): Promise<void> {
  await expect.poll(
    async () => {
      if (page.isClosed()) return 'closed';
      const confirmed = await page.getByText('Confirmed', { exact: true }).isVisible().catch(() => false);
      if (confirmed) return 'confirmed';
      const confirmedBody = await page.getByText('Confirmed. Closing checkout...').isVisible().catch(() => false);
      if (confirmedBody) return 'confirmed';
      const toastConfirmed = await page.getByText('Payment confirmed').isVisible().catch(() => false);
      if (toastConfirmed) return 'confirmed';
      return 'pending';
    },
    {
      timeout: 30_000,
      intervals: [250, 500, 750],
      message: 'wallet checkout must show confirmation or auto-close after persisted confirmation',
    },
  ).not.toBe('pending');

  if (!page.isClosed()) {
    await expect.poll(() => page.isClosed(), {
      timeout: 10_000,
      intervals: [250, 500, 750],
      message: 'wallet checkout page must auto-close after persisted confirmation',
    }).toBe(true);
  }
}

async function outCap(page: Page, entityId: string, counterpartyId: string): Promise<bigint> {
  const value = await page.evaluate(({ entityId, counterpartyId }) => {
    const view = window as WalletRuntimeView;
    const env = view.isolatedEnv;
    const deriveDelta = view.XLN?.deriveDelta;
    if (!env?.eReplicas || typeof deriveDelta !== 'function') return '0';

    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      if (!String(replicaKey).startsWith(`${entityId}:`)) continue;
      const account = replica.state?.accounts?.get(counterpartyId);
      if (!account) return '0';
      const delta = account.deltas?.get(1);
      if (!delta) return '0';
      const derived = deriveDelta(delta, String(entityId).toLowerCase() < String(counterpartyId).toLowerCase());
      const outCapacity = derived?.outCapacity;
      if (typeof outCapacity === 'bigint') return outCapacity.toString();
      if (typeof outCapacity === 'number') return String(outCapacity);
      if (typeof outCapacity === 'string') return outCapacity;
      return typeof outCapacity?.toString === 'function' ? outCapacity.toString() : '0';
    }

    return '0';
  }, { entityId, counterpartyId });

  return BigInt(value);
}

async function faucetOffchain(
  page: Page,
  entityId: string,
  hubEntityId: string,
  amount = '100',
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
      const response = await page.request.post(apiUrl('/api/faucet/offchain'), {
        data: {
          userEntityId: entityId,
          userRuntimeId: runtimeId,
          hubEntityId,
          tokenId: 1,
          amount,
        },
      });
      const body = await response.json().catch(() => ({} as Record<string, unknown>));
      result = { ok: response.ok(), status: response.status(), data: body };
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
      code === 'FAUCET_CHANNEL_NOT_READY' ||
      status === 'channel_opening' ||
      status === 'channel_not_ready';
    if (!transient || attempt === 15) break;
    await page.waitForTimeout(1000);
  }

  expect(result.ok, `offchain faucet failed: ${JSON.stringify(result.data)}`).toBe(true);
}

async function waitForOutCapAtLeast(
  page: Page,
  entityId: string,
  counterpartyId: string,
  minOut: bigint,
  timeoutMs = 15_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await outCap(page, entityId, counterpartyId);
    if (current >= minOut) return;
    await page.waitForTimeout(400);
  }

  const current = await outCap(page, entityId, counterpartyId);
  throw new Error(
    `waitForOutCapAtLeast timeout: entity=${entityId.slice(0, 10)} cp=${counterpartyId.slice(0, 10)} ` +
    `current=${current.toString()} min=${minOut.toString()}`,
  );
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

async function reannounceRuntimeProfile(page: Page, entityId: string): Promise<void> {
  const ok = await page.evaluate(async (entityId) => {
    const maybeWindow = window as typeof window & {
      isolatedEnv?: {
        runtimeState?: {
          p2p?: {
            announceLocalProfiles?: () => Promise<void> | void;
            announceProfilesForEntities?: (entityIds: string[], reason?: string) => void;
            refreshGossip?: () => Promise<void> | void;
          };
        };
      };
    };
    const p2p = maybeWindow.isolatedEnv?.runtimeState?.p2p;
    if (!p2p) return false;

    try {
      if (typeof p2p.announceProfilesForEntities === 'function') {
        p2p.announceProfilesForEntities([entityId], 'e2e-wallet-rebind');
      } else if (typeof p2p.announceLocalProfiles === 'function') {
        await p2p.announceLocalProfiles();
      }
      if (typeof p2p.refreshGossip === 'function') {
        await p2p.refreshGossip();
      }
      return true;
    } catch {
      return false;
    }
  }, entityId);

  expect(ok, 'wallet runtime must re-announce its current profile').toBe(true);
}

async function waitForDaemonReceiptEvent(
  daemonClient: DaemonRpcClient,
  options: {
    entityId: string;
    eventName: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  const targetEntityId = options.entityId.toLowerCase();
  const recent: string[] = [];

  while (Date.now() - startedAt < timeoutMs) {
    const response = await daemonClient.getFrameReceipts({
      fromHeight: 1,
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
    }

    await delay(500);
  }

  throw new Error(
    `Timed out waiting for daemon receipt ${options.eventName} on ${targetEntityId.slice(0, 12)} ` +
    `(recent=${recent.join(',') || 'none'})`,
  );
}

async function readCustodyDashboard(
  page: Page,
  custodyBaseUrl: string,
): Promise<CustodyDashboardPayload> {
  const currentUrl = page.url();
  if (!currentUrl.startsWith(custodyBaseUrl)) {
    throw new Error(`custody page navigated away from dashboard origin: ${currentUrl}`);
  }

  return await page.evaluate(async () => {
    const response = await fetch('/api/me', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'cache-control': 'no-store',
      },
    });
    if (!response.ok) {
      throw new Error(`dashboard fetch failed (${response.status})`);
    }
    return await response.json() as CustodyDashboardPayload;
  });
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
    const custodyBaseUrl = `http://127.0.0.1:${custodyPort}`;
    const relayUrl = toWsUrl(API_BASE_URL, '/relay');
    const rpcProxyUrl = apiUrl('/rpc');

    let daemonChild: ManagedChild | null = null;
    let custodyChild: ManagedChild | null = null;
    let daemonClient: DaemonRpcClient | null = null;

    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const walletPage = await context.newPage();
    const custodyPage = await context.newPage();

    try {
      await resetProdServer(walletPage, {
        apiBaseUrl: API_BASE_URL,
        timeoutMs: TEST_TIMEOUT_MS,
        softPreserveHubs: false,
      });
      await ensureE2EBaseline(walletPage, {
        apiBaseUrl: API_BASE_URL,
        timeoutMs: TEST_TIMEOUT_MS,
        requireHubMesh: true,
        requireMarketMaker: false,
        minHubCount: 3,
      });

      const hubIds = await discoverHubIds(walletPage);
      expect(hubIds.length, 'baseline must expose 3 hubs').toBeGreaterThanOrEqual(3);

      daemonChild = spawnChild(
        'custody-daemon',
        ['runtime/server.ts', '--port', String(daemonPort), '--host', '127.0.0.1', '--server-id', `custody-daemon-${daemonPort}`],
        {
          USE_ANVIL: 'true',
          BOOTSTRAP_LOCAL_HUBS: '0',
          ANVIL_RPC: rpcProxyUrl,
          PUBLIC_RPC: rpcProxyUrl,
          RELAY_URL: relayUrl,
          XLN_DB_PATH: join(tempRoot, 'daemon-db'),
        },
      );
      await waitForHttpReady(`http://127.0.0.1:${daemonPort}/api/health`, daemonChild);
      daemonClient = new DaemonRpcClient(`ws://127.0.0.1:${daemonPort}/rpc`);

      const controlResult = await runDaemonControl(
        [
          'setup-custody',
          '--base-url', `http://127.0.0.1:${daemonPort}`,
          '--name', 'Custody',
          '--seed', 'xln-e2e-custody-seed',
          '--signer-label', 'custody-e2e-1',
          '--hub-ids', hubIds.slice(0, 3).join(','),
          '--relay-url', relayUrl,
          '--gossip-poll-ms', '250',
        ],
        {
          USE_ANVIL: 'true',
        },
      );
      expect(controlResult.ok, 'setup-custody must succeed').toBe(true);
      const custodyIdentity = controlResult.result;

      await waitForDebugEntity(
        walletPage,
        custodyIdentity.entityId,
        entry => entry.online === true && Math.max(entry.accounts?.length ?? 0, entry.publicAccounts?.length ?? 0) > 0,
        'custody entity must appear online in relay gossip with at least one advertised account',
      );

      custodyChild = spawnChild(
        'custody-service',
        ['custody/server.ts'],
        {
          CUSTODY_HOST: '127.0.0.1',
          CUSTODY_PORT: String(custodyPort),
          CUSTODY_DAEMON_WS: `ws://127.0.0.1:${daemonPort}/rpc`,
          CUSTODY_WALLET_URL: new URL('/app', APP_BASE_URL).toString(),
          CUSTODY_ENTITY_ID: custodyIdentity.entityId,
          CUSTODY_SIGNER_ID: custodyIdentity.signerId,
          CUSTODY_DB_PATH: join(tempRoot, 'custody.sqlite'),
        },
      );
      await waitForHttpReady(`http://127.0.0.1:${custodyPort}/api/me`, custodyChild);

      await gotoApp(walletPage);
      const alice = await createRuntimeIdentity(walletPage, 'alice', selectDemoMnemonic('alice'));
      await connectRuntimeToHub(walletPage, alice, hubIds[0]!);
      await waitForDebugEntity(
        walletPage,
        alice.entityId,
        entry => entry.online === true && Math.max(entry.accounts?.length ?? 0, entry.publicAccounts?.length ?? 0) > 0,
        'alice runtime must appear online in relay gossip with an advertised hub account',
      );
      const aliceOutBeforeFunding = await outCap(walletPage, alice.entityId, hubIds[0]!);
      await faucetOffchain(walletPage, alice.entityId, hubIds[0]!);
      await waitForOutCapAtLeast(walletPage, alice.entityId, hubIds[0]!, aliceOutBeforeFunding + (10n * 10n ** 18n));
      await ensureRuntimeProfileDownloaded(walletPage, custodyIdentity.entityId);
      await delay(1000);

      await custodyPage.goto(custodyBaseUrl);
      await expect(custodyPage.getByText('How To Integrate XLN')).toBeVisible({ timeout: 15_000 });
      await expect(custodyPage.getByText('Auto session')).toBeVisible({ timeout: 15_000 });

      await custodyPage.locator('input[name="amount"]').fill('1');
      await custodyPage.locator('input[name="targetEntityId"]').fill(alice.entityId);
      await custodyPage.getByRole('button', { name: 'Withdraw via XLN' }).click();
      await expect(custodyPage.getByText('Insufficient custody balance')).toBeVisible({ timeout: 15_000 });

      await custodyPage.locator('input[name="depositAmount"]').fill('10');
      const [checkoutPage] = await Promise.all([
        context.waitForEvent('page'),
        custodyPage.getByRole('button', { name: 'Deposit with XLN' }).click(),
      ]);
      await checkoutPage.waitForLoadState('domcontentloaded');
      await submitHostedCheckoutPayment(checkoutPage);
      await waitForDaemonReceiptEvent(daemonClient, {
        entityId: custodyIdentity.entityId,
        eventName: 'HtlcReceived',
        timeoutMs: 30_000,
      });

      const receiptDebug = await daemonClient.getFrameReceipts({
        fromHeight: 1,
        limit: 32,
        entityId: custodyIdentity.entityId,
        eventNames: ['HtlcReceived', 'PaymentFinalized', 'PaymentFailed'],
      });
      console.log(`[custody-debug] receipt-events=${JSON.stringify(receiptDebug.receipts)}`);
      const dashboardDebug = await readCustodyDashboard(custodyPage, custodyBaseUrl);
      console.log(`[custody-debug] dashboard=${JSON.stringify(dashboardDebug)}`);

      await expect.poll(
        async () => {
          const dashboard = await readCustodyDashboard(custodyPage, custodyBaseUrl);
          return {
            balance: String(dashboard.headlineBalance?.amountDisplay || ''),
            syncError: dashboard.custody?.lastSyncError || null,
            activity: Array.isArray(dashboard.activity) ? dashboard.activity.length : 0,
          };
        },
        {
          timeout: 30_000,
          intervals: [500, 750, 1000],
          message: 'custody backend must reflect the credited deposit',
        },
      ).toMatchObject({
        balance: expect.stringContaining('10'),
        syncError: null,
      });

      await expect.poll(
        async () => {
          return await custodyPage.locator('.balance-amount').first().textContent();
        },
        {
          timeout: 15_000,
          intervals: [500, 750, 1000],
          message: 'custody hero balance must visually reflect the credited deposit',
        },
      ).toContain('10');

      await waitForHostedCheckoutSuccess(checkoutPage);
      await walletPage.reload({ waitUntil: 'domcontentloaded' });
      await walletPage.waitForFunction(() => !!(window as typeof window & { XLN?: unknown }).XLN, { timeout: 30_000 });
      await switchToRuntimeId(walletPage, alice.runtimeId);
      await ensureRuntimeOnline(walletPage, 'alice-after-checkout-reload');
      await reannounceRuntimeProfile(walletPage, alice.entityId);
      await waitForDebugEntity(
        walletPage,
        alice.entityId,
        entry => entry.online === true,
        'alice runtime must come back online after hosted checkout reload',
      );
      await ensureRuntimeProfileDownloaded(walletPage, custodyIdentity.entityId);
      await delay(750);

      await custodyPage.locator('input[name="amount"]').fill('5');
      await custodyPage.locator('input[name="targetEntityId"]').fill(alice.entityId);

      const withdrawCursor = await getPersistedReceiptCursor(walletPage);
      await custodyPage.getByRole('button', { name: 'Withdraw via XLN' }).click();

      await expect(custodyPage.getByText(/Queued withdrawal/i)).toBeVisible({ timeout: 15_000 });
      await waitForPersistedFrameEvent(walletPage, {
        cursor: withdrawCursor,
        eventName: 'HtlcReceived',
        entityId: alice.entityId,
        timeoutMs: 30_000,
      });

      await expect.poll(
        async () => {
          return await custodyPage.locator('.balance-amount').first().textContent();
        },
        {
          timeout: 30_000,
          intervals: [500, 750, 1000],
          message: 'custody balance must debit the withdrawn amount after finalization',
        },
      ).toContain('5');
    } finally {
      await context.close();
      await daemonClient?.close();
      await stopChild(custodyChild);
      await stopChild(daemonChild);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
