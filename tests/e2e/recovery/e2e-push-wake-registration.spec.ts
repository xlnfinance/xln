import { test, expect, type Page } from '../../global-setup.mts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, hexlify } from 'ethers';

import { gotoApp as gotoSharedApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import { connectRuntimeToHub } from '../../utils/e2e-connect';
import { createWalletIdentity } from '../../../ui/tests/wallet-ui';
import { timedStep } from '../../utils/e2e-timing.mts';
import { requireIsolatedBaseUrl } from '../../utils/runtime/e2e-isolated-env';
import { closeRuntimePage } from '../../utils/runtime/e2e-runtime-shutdown.mts';
import { deriveSignerAddressSync, deriveSignerKeySync } from '../../../core/account/crypto';
import { createXlnJsonRpcProvider } from '../../../core/jurisdiction/adapter';
import { mineRpcToBlockExact } from '../../../core/scenarios/harness/rpc-block-mining';
import {
  buildPushRegistrationMessage,
  buildPushUnregisterMessage,
  hashPushToken,
} from '../../../core/watchtower/push/registration';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const INIT_TIMEOUT = 30_000;

test.setTimeout(240_000);

type CapturedPush = {
  token?: string;
  platform?: string;
  collapseKey?: string;
  data?: { kind?: string; entityId?: string; txHash?: string };
};

async function allocatePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw new Error('PORT_ALLOCATOR_ADDRESS_INVALID');
  }
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function startPushCaptureWebhook(): Promise<{
  url: string;
  notifications: CapturedPush[];
  close: () => Promise<void>;
}> {
  const notifications: CapturedPush[] = [];
  const server: HttpServer = createHttpServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'METHOD_NOT_ALLOWED' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CapturedPush;
        notifications.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: notifications.length }));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });
  const port = await allocatePort();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    url: `http://127.0.0.1:${port}/capture`,
    notifications,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

function relayToApiBase(relayUrl: string | null | undefined): string | null {
  if (!relayUrl) return null;
  try {
    const relay = new URL(relayUrl);
    const protocol = relay.protocol === 'wss:' ? 'https:' : relay.protocol === 'ws:' ? 'http:' : relay.protocol;
    return `${protocol}//${relay.host}`;
  } catch {
    return null;
  }
}

async function getActiveApiBase(page: Page): Promise<string> {
  if (process.env.E2E_API_BASE_URL) return process.env.E2E_API_BASE_URL;
  const runtimeApi = await page.evaluate(() => {
    const relay =
      (
        window as typeof window & {
          __xln?: { runtimeConnectivity?: { relayUrls?: string[] } };
        }
      ).__xln?.runtimeConnectivity?.relayUrls?.[0] ?? null;
    return typeof relay === 'string' ? relay : null;
  });
  return relayToApiBase(runtimeApi) ?? APP_BASE_URL;
}

async function confirmDisputeForWatchtower(rpcUrl: string): Promise<void> {
  const provider = createXlnJsonRpcProvider(rpcUrl);
  try {
    const head = BigInt(await provider.send('eth_blockNumber', []));
    const result = await mineRpcToBlockExact(provider, head + 12n);
    expect(result.minedBlocks, 'watchtower finality boundary must mine exactly 12 blocks').toBe(12n);
  } finally {
    provider.destroy();
  }
}

async function readActivePushWakeTarget(page: Page): Promise<{
  entityId: string;
  signerId: string;
  chainId: number;
  depositoryAddress: string;
  rpcUrl: string;
}> {
  return await page.evaluate(() => {
    const env = (
      window as typeof window & {
        __xln: {
          env(): {
            runtimeId?: string;
            state?: {
              eReplicas?: Map<string, any>;
              jReplicas?: Map<string, any>;
            };
          };
          store: { getState(): { activeEntityId: string } };
        };
      }
    ).__xln.env();
    if (!env?.state?.eReplicas || !env?.state?.jReplicas) throw new Error('PUSH_E2E_ENV_UNAVAILABLE');
    const activeEntityId = (window as any).__xln.store.getState().activeEntityId;
    for (const [rawKey, replica] of env.state.eReplicas.entries()) {
      const [entityId, signerId] = String(rawKey).split(':');
      if (!entityId?.startsWith('0x') || entityId.length !== 66 || !signerId) continue;
      if (entityId !== activeEntityId) continue;
      const jurisdiction = replica?.state?.config?.jurisdiction || {};
      const chainId = Number(jurisdiction.chainId || 0);
      const depository = String(jurisdiction.depositoryAddress || '').toLowerCase();
      const name = String(jurisdiction.name || '');
      for (const jr of env.state.jReplicas.values()) {
        const jrName = String(jr?.name || '');
        const jrChainId = Number(jr?.chainId || jr?.jadapter?.chainId || 0);
        const jrDepository = String(jr?.depositoryAddress || jr?.contracts?.depository || '').toLowerCase();
        if (jrName !== name && (jrChainId !== chainId || jrDepository !== depository)) continue;
        const candidates = [
          jurisdiction.address,
          jr?.rpc,
          jr?.jadapter?.rpc,
          ...(Array.isArray(jr?.jadapter?.rpcs) ? jr.jadapter.rpcs : []),
          ...(Array.isArray(jr?.rpcs) ? jr.rpcs : []),
        ]
          .filter(Boolean)
          .map(String);
        const rpcUrl = candidates.find(value => /^https?:\/\//i.test(value));
        if (rpcUrl) {
          const resolvedDepository = String(
            jurisdiction.depositoryAddress ||
              jr?.depositoryAddress ||
              jr?.contracts?.depository ||
              jr?.jadapter?.addresses?.depository ||
              '',
          ).toLowerCase();
          return {
            entityId,
            signerId,
            chainId,
            depositoryAddress: resolvedDepository,
            rpcUrl,
          };
        }
      }
    }
    throw new Error('PUSH_E2E_TARGET_UNRESOLVED');
  });
}

async function ensureAnyHubAccountOpen(page: Page): Promise<{
  entityId: string;
  signerId: string;
  counterpartyId: string;
  counterpartyName: string;
  counterpartyRuntimeId: string;
}> {
  const activeTarget = await readActivePushWakeTarget(page);
  const apiBase = await getActiveApiBase(page);
  const response = await page.request.get(`${apiBase}/api/debug/entities`);
  expect(response.ok(), 'debug entities endpoint must be available').toBe(true);
  const body = (await response.json()) as {
    entities?: Array<{
      entityId?: string;
      runtimeId?: string;
      isHub?: boolean;
      name?: string;
      metadata?: { name?: string; jurisdiction?: { chainId?: number } };
    }>;
  };
  const hubs = (Array.isArray(body.entities) ? body.entities : [])
    .filter(entity => entity.isHub === true && typeof entity.entityId === 'string')
    .filter(entity => entity.metadata?.jurisdiction?.chainId === activeTarget.chainId);
  const preferredHub =
    hubs.find(entity => {
      const name = String(entity.name || entity.metadata?.name || '')
        .trim()
        .toUpperCase();
      return name === 'H1';
    }) ??
    hubs.find(entity => {
      const name = String(entity.name || entity.metadata?.name || '')
        .trim()
        .toUpperCase();
      return name !== 'H2';
    }) ??
    hubs[0];
  const hubId = preferredHub?.entityId;
  expect(typeof hubId === 'string' && hubId.length > 0, 'at least one hub must be available').toBe(true);
  const hubName = String(preferredHub?.name || preferredHub?.metadata?.name || '')
    .trim()
    .toUpperCase();
  expect(/^H[123]$/.test(hubName), 'selected hub must be one of the deterministic mesh hubs').toBe(true);
  const hubRuntimeId = String(preferredHub?.runtimeId || '')
    .trim()
    .toLowerCase();
  expect(hubRuntimeId.length > 0, 'selected hub runtimeId must be advertised').toBe(true);

  await timedStep('push_wake.connect_account', () => connectRuntimeToHub(page, activeTarget, hubId!));
  const target = await readActivePushWakeTarget(page);
  return {
    entityId: target.entityId,
    signerId: target.signerId,
    counterpartyId: hubId!,
    counterpartyName: hubName,
    counterpartyRuntimeId: hubRuntimeId,
  };
}

const hubRuntimeOwnerWallet = (hubName: string, expectedRuntimeId: string): Wallet => {
  const normalized = String(hubName || '')
    .trim()
    .toLowerCase();
  if (!/^h[123]$/.test(normalized)) throw new Error(`PUSH_E2E_UNSUPPORTED_HUB:${hubName}`);
  const seed = `xln-e2e-${normalized}`;
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  if (runtimeId !== expectedRuntimeId.toLowerCase()) {
    throw new Error(`PUSH_E2E_HUB_RUNTIME_ID_MISMATCH: derived=${runtimeId} advertised=${expectedRuntimeId}`);
  }
  return new Wallet(hexlify(deriveSignerKeySync(seed, '1')));
};

async function registerDirectPushWakeToken(
  baseUrl: string,
  params: {
    runtimeId: string;
    ownerWallet: Wallet;
    entityId: string;
    token: string;
    platform: 'desktop';
    chainId: number;
    depositoryAddress: string;
    rpcUrl: string;
  },
): Promise<{ tokenHash: string }> {
  const tokenHash = hashPushToken(params.token);
  const signedAt = Date.now();
  const ownerSignature = await params.ownerWallet.signMessage(
    buildPushRegistrationMessage(
      params.runtimeId,
      params.entityId,
      tokenHash,
      params.platform,
      params.chainId,
      params.depositoryAddress,
      params.rpcUrl,
      signedAt,
    ),
  );
  const response = await fetch(`${baseUrl}/api/push/register`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'push_registration',
      version: 1,
      runtimeId: params.runtimeId,
      entityId: params.entityId,
      token: params.token,
      platform: params.platform,
      chainId: params.chainId,
      depositoryAddress: params.depositoryAddress,
      rpcUrl: params.rpcUrl,
      signedAt,
      ownerSignature,
    }),
  });
  const bodyText = await response.text();
  expect(response.ok, `direct victim push registration failed: ${bodyText}`).toBe(true);
  return { tokenHash };
}

async function unregisterDirectPushWakeToken(
  baseUrl: string,
  params: {
    runtimeId: string;
    ownerWallet: Wallet;
    tokenHash: string;
  },
): Promise<void> {
  const signedAt = Date.now();
  const ownerSignature = await params.ownerWallet.signMessage(
    buildPushUnregisterMessage(params.runtimeId, params.tokenHash, signedAt),
  );
  const response = await fetch(`${baseUrl}/api/push/unregister`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'push_unregister',
      version: 1,
      runtimeId: params.runtimeId,
      tokenHash: params.tokenHash,
      signedAt,
      ownerSignature,
    }),
  });
  const bodyText = await response.text();
  expect(response.ok, `direct victim push unregister failed: ${bodyText}`).toBe(true);
}

async function readAccountMeta(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<{
  frameHeight: number;
  hasCounterpartyDisputeProof: boolean;
  pendingFrame: boolean;
  counterpartyDisputeProofBodyHash: string;
  counterpartyDisputeProofNonce: number | null;
}> {
  return await page.evaluate(
    ({ entityId, signerId, counterpartyId }) => {
      const env = (window as any).__xln.env();
      if (!env?.state?.eReplicas) {
        return {
          frameHeight: 0,
          hasCounterpartyDisputeProof: false,
          pendingFrame: false,
          counterpartyDisputeProofBodyHash: '',
          counterpartyDisputeProofNonce: null,
        };
      }
      const key = Array.from(env.state.eReplicas.keys()).find((k: string) => {
        const [eid, sid] = String(k).split(':');
        return (
          String(eid || '').toLowerCase() === String(entityId).toLowerCase() &&
          String(sid || '').toLowerCase() === String(signerId).toLowerCase()
        );
      });
      const rep = key ? env.state.eReplicas.get(key) : null;
      const account = rep?.state?.accounts?.get?.(counterpartyId);
      return {
        frameHeight: Number(account?.currentHeight || 0),
        hasCounterpartyDisputeProof: !!account?.counterpartyDisputeProofHanko,
        pendingFrame: !!account?.pendingFrame,
        counterpartyDisputeProofBodyHash: String(account?.counterpartyDisputeProofBodyHash || ''),
        counterpartyDisputeProofNonce:
          typeof account?.counterpartyDisputeProofNonce === 'number'
            ? Number(account.counterpartyDisputeProofNonce)
            : null,
      };
    },
    { entityId, signerId, counterpartyId },
  );
}

async function seedDisputePreconditions(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<void> {
  const before = await readAccountMeta(page, entityId, signerId, counterpartyId);
  let lastError = 'seed-not-attempted';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.evaluate(
        async ({ entityId, counterpartyId }) => {
          const env = (window as any).__xln.env();
          if (!env) throw new Error('PUSH_E2E_RUNTIME_MISSING');
          const response = await fetch(`${window.location.origin}/api/faucet/offchain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userEntityId: entityId,
              userRuntimeId: String(env.runtimeId || '').toLowerCase(),
              tokenId: 1,
              amount: '100',
              hubEntityId: counterpartyId,
            }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || !body?.success)
            throw new Error(body?.error || `offchain faucet failed (${response.status})`);
        },
        { entityId, counterpartyId },
      );

      await expect
        .poll(
          async () => {
            const current = await readAccountMeta(page, entityId, signerId, counterpartyId);
            return {
              frameAdvanced: current.frameHeight > before.frameHeight,
              hasProof: current.hasCounterpartyDisputeProof,
              pendingFrame: current.pendingFrame,
              freshProofHash:
                current.counterpartyDisputeProofBodyHash.length > 0 &&
                current.counterpartyDisputeProofBodyHash !== before.counterpartyDisputeProofBodyHash,
              freshProofNonce:
                typeof current.counterpartyDisputeProofNonce === 'number' &&
                current.counterpartyDisputeProofNonce > 0 &&
                (before.counterpartyDisputeProofNonce === null ||
                  current.counterpartyDisputeProofNonce > before.counterpartyDisputeProofNonce),
            };
          },
          { timeout: 45_000, intervals: [500, 1000, 2000] },
        )
        .toMatchObject({
          frameAdvanced: true,
          hasProof: true,
          pendingFrame: false,
          freshProofHash: true,
          freshProofNonce: true,
        });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await page.waitForTimeout(1000);
    }
  }
  throw new Error(`Unable to seed dispute preconditions: ${lastError}`);
}

async function readAccountState(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<{ activeDispute: boolean; jBatchDisputeStarts: number }> {
  return await page.evaluate(
    ({ entityId, signerId, counterpartyId }) => {
      const env = (window as any).__xln.env();
      const key = Array.from(env?.state?.eReplicas?.keys?.() || []).find((k: string) => {
        const [eid, sid] = String(k).split(':');
        return (
          String(eid || '').toLowerCase() === String(entityId).toLowerCase() &&
          String(sid || '').toLowerCase() === String(signerId).toLowerCase()
        );
      });
      const rep = key ? env.state.eReplicas.get(key) : null;
      const account = rep?.state?.accounts?.get?.(counterpartyId);
      const batch = rep?.state?.jBatchState?.batch;
      return {
        activeDispute: !!account?.activeDispute,
        jBatchDisputeStarts: Number(batch?.disputeStarts?.length || 0),
      };
    },
    { entityId, signerId, counterpartyId },
  );
}

async function readJBatchSnapshot(
  page: Page,
  entityId: string,
  signerId: string,
): Promise<{ pendingDisputeStarts: number; entityNonce: number; batchStatus: string; sentBatch: boolean }> {
  return await page.evaluate(
    ({ entityId, signerId }) => {
      const env = (window as any).__xln.env();
      const key = Array.from(env?.state?.eReplicas?.keys?.() || []).find((k: string) => {
        const [eid, sid] = String(k).split(':');
        return (
          String(eid || '').toLowerCase() === String(entityId).toLowerCase() &&
          String(sid || '').toLowerCase() === String(signerId).toLowerCase()
        );
      });
      const rep = key ? env.state.eReplicas.get(key) : null;
      const pending = rep?.state?.jBatchState?.batch;
      return {
        pendingDisputeStarts: Number(pending?.disputeStarts?.length || 0),
        entityNonce: Number(rep?.state?.jBatchState?.entityNonce || 0),
        batchStatus: String(rep?.state?.jBatchState?.status || ''),
        sentBatch: Boolean(rep?.state?.jBatchState?.sentBatch),
      };
    },
    { entityId, signerId },
  );
}

async function startDisputeFromManageUi(
  page: Page,
  counterpartyId: string,
  waitUntilQueued: () => Promise<boolean>,
): Promise<void> {
  await page.locator('[data-testid=nav-home]:visible').click();
  await page.locator(`[data-testid="account-row"][data-counterparty-id="${counterpartyId}"]`).click();
  await page.getByTestId('account-dispute').click();
  await page.getByTestId('dispute-prepare').click();
  await page.getByTestId('dispute-prepare-confirm').click();
  await expect.poll(waitUntilQueued, { timeout: 60_000 }).toBe(true);
}

async function broadcastPendingBatchViaUi(page: Page): Promise<void> {
  await page.locator('[data-testid=nav-home]:visible').click();
  const signButton = page.getByTestId('batch-broadcast');
  await expect(signButton).toBeVisible({ timeout: 30_000 });
  await expect(signButton).toBeEnabled({ timeout: 120_000 });
  await signButton.click();
}

async function gotoApp(page: Page): Promise<void> {
  await page.addInitScript(rpcOverride => {
    (
      window as Window & {
        xlnDesktop?: {
          platform: 'desktop';
          getPushWakeToken: () => Promise<{ value: string; platform: 'desktop' }>;
        };
        __XLN_PUSH_WAKE_RPC_URLS__?: Record<string, string>;
      }
    ).xlnDesktop = {
      platform: 'desktop',
      getPushWakeToken: async () => ({ value: 'e2e-real-desktop-bridge-token', platform: 'desktop' }),
    };
    if (typeof rpcOverride === 'string' && rpcOverride) {
      (window as Window & { __XLN_PUSH_WAKE_RPC_URLS__?: Record<string, string> }).__XLN_PUSH_WAKE_RPC_URLS__ = {
        default: rpcOverride,
      };
    }
  }, process.env.E2E_ANVIL_RPC || '');
  await gotoSharedApp(page, {
    appBaseUrl: APP_BASE_URL,
    initTimeoutMs: INIT_TIMEOUT,
    settleMs: 500,
  });
}

async function waitForWatchtower(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/tower/healthz`);
      if (response.ok) {
        const payload = (await response.json()) as { ok?: boolean; pushWake?: { enabled?: boolean } };
        if (payload.ok && payload.pushWake?.enabled) return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`watchtower did not become healthy: ${lastError}`);
}

async function readPushRegistrationCount(baseUrl: string): Promise<number> {
  const response = await fetch(`${baseUrl}/api/tower/healthz`);
  const payload = (await response.json()) as {
    pushWake?: { stats?: { registrationCount?: number } };
  };
  return Number(payload.pushWake?.stats?.registrationCount || 0);
}

async function startPushWatchtower(options: { webhookUrl: string; allowedRpcUrl: string }): Promise<{
  proc: ChildProcessWithoutNullStreams;
  url: string;
}> {
  const port = Number(process.env.E2E_WATCHTOWER_PORT);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error('PUSH_LEASED_TOWER_PORT_REQUIRED');
  const dbRoot = await mkdtemp(join(tmpdir(), 'xln-push-e2e-'));
  const proc = spawn(
    'bun',
    ['core/watchtower/standalone-server.ts', '--host', '127.0.0.1', '--port', String(port), '--enable-push-wake'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        XLN_PUSH_DB_PATH: join(dbRoot, 'push.level'),
        XLN_WATCHTOWER_DB_PATH: join(dbRoot, 'watchtower.level'),
        XLN_PUSH_SWEEP_INTERVAL_MS: '1000',
        XLN_PUSH_WEBHOOK_URL: options.webhookUrl,
        XLN_WATCHTOWER_ALLOWED_RPC_URLS: options.allowedRpcUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  proc.stdout.on('data', chunk => process.stdout.write(`[push-watchtower] ${chunk.toString()}`));
  proc.stderr.on('data', chunk => process.stderr.write(`[push-watchtower] ${chunk.toString()}`));

  const url = `http://127.0.0.1:${port}`;
  await waitForWatchtower(url);
  return { proc, url };
}

async function openRecoverySettings(page: Page): Promise<void> {
  await page.locator('[data-testid=nav-home]:visible').click();
  await page.getByTestId('home-sovereignty').click();
  await expect(page.getByTestId('sovereignty-watchtower')).toBeVisible({ timeout: INIT_TIMEOUT });
  await page.getByTestId('push-notifications').locator('summary').first().click();
}

test(
  'settings registers and revokes signed push wake token through browser UI',
  { tag: '@functional' },
  async ({ page }) => {
    const capture = await startPushCaptureWebhook();
    let tower: Awaited<ReturnType<typeof startPushWatchtower>> | null = null;

    try {
      await gotoApp(page);
      await timedStep('push_wake.create_wallet', () =>
        createWalletIdentity(page, 'Push wake', selectDemoMnemonic('alice')),
      );
      const accountRef = await ensureAnyHubAccountOpen(page);
      const target = await readActivePushWakeTarget(page);
      const watchtowerRpcUrl = process.env.E2E_ANVIL_RPC || target.rpcUrl;
      expect(accountRef.entityId.toLowerCase(), 'hub account must stay on the active push entity').toBe(
        target.entityId.toLowerCase(),
      );
      expect(target.chainId, 'push wake target chainId must be resolved').toBeGreaterThan(0);
      expect(target.depositoryAddress, 'push wake target depository must be resolved').toMatch(/^0x[0-9a-f]{40}$/);
      tower = await startPushWatchtower({
        webhookUrl: capture.url,
        allowedRpcUrl: watchtowerRpcUrl,
      });

      await timedStep('push_wake.open_settings', () => openRecoverySettings(page));
      await page.getByTestId('watchtower-url').fill(tower.url);
      await timedStep('push_wake.add_tower', () => page.getByTestId('watchtower-add').click());
      await expect(page.getByTestId('watchtower-row').filter({ hasText: tower.url })).toBeVisible({ timeout: 10_000 });
      const notifications = page.getByTestId('push-notifications');
      const register = notifications.getByRole('button', { name: 'Enable notifications', exact: true });
      await expect(register).toBeEnabled({ timeout: 15_000 });
      await timedStep('push_wake.register', () => register.click());
      await expect(notifications).toContainText('Registration accepted.', { timeout: 20_000 });
      await expect(notifications).toContainText('1 locally recorded tower registrations');
      await expect.poll(() => readPushRegistrationCount(tower!.url), { timeout: 10_000 }).toBe(1);
      const storedStatus = await page.evaluate(() => localStorage.getItem('xln-push-wake-registrations-v1') || '');
      expect(storedStatus).not.toContain('e2e-real-desktop-bridge-token');
      expect(storedStatus).toContain('desktop');

      const victimWallet = hubRuntimeOwnerWallet(accountRef.counterpartyName, accountRef.counterpartyRuntimeId);
      const victimToken = 'e2e-real-h1-victim-bridge-token';
      const victimRegistration = await registerDirectPushWakeToken(tower.url, {
        runtimeId: accountRef.counterpartyRuntimeId,
        ownerWallet: victimWallet,
        entityId: accountRef.counterpartyId,
        token: victimToken,
        platform: 'desktop',
        chainId: target.chainId,
        depositoryAddress: target.depositoryAddress,
        rpcUrl: watchtowerRpcUrl,
      });
      await expect.poll(() => readPushRegistrationCount(tower!.url), { timeout: 10_000 }).toBe(2);

      await seedDisputePreconditions(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);

      const batchBeforeDispute = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
      await startDisputeFromManageUi(page, accountRef.counterpartyId, async () => {
        const state = await readAccountState(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
        return state.jBatchDisputeStarts > 0;
      });
      await expect
        .poll(
          async () => {
            const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
            return snap.pendingDisputeStarts;
          },
          { timeout: 60_000, intervals: [500, 1000, 2000] },
        )
        .toBeGreaterThan(batchBeforeDispute.pendingDisputeStarts);

      await broadcastPendingBatchViaUi(page);
      await expect
        .poll(
          async () => {
            const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
            return {
              entityNonce: snap.entityNonce,
              batchStatus: snap.batchStatus,
              sentBatch: snap.sentBatch,
              pendingDisputeStarts: snap.pendingDisputeStarts,
            };
          },
          { timeout: 45_000, intervals: [500, 1000, 2000] },
        )
        .toMatchObject({
          entityNonce: expect.any(Number),
          batchStatus: 'empty',
          sentBatch: false,
          pendingDisputeStarts: 0,
        });
      expect((await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId)).entityNonce).toBeGreaterThan(
        batchBeforeDispute.entityNonce,
      );

      await confirmDisputeForWatchtower(watchtowerRpcUrl);
      await expect.poll(() => capture.notifications.length, { timeout: 20_000, intervals: [500, 1000, 2000] }).toBe(1);
      expect(capture.notifications[0]).toMatchObject({
        token: victimToken,
        platform: 'desktop',
        data: {
          kind: 'dispute_wake',
          entityId: accountRef.counterpartyId.toLowerCase(),
        },
      });
      await page.waitForTimeout(2_500);
      expect(capture.notifications).toHaveLength(1);

      await openRecoverySettings(page);
      await expect(page.getByRole('button', { name: 'Remove registrations', exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await timedStep('push_wake.revoke', () =>
        page.getByRole('button', { name: 'Remove registrations', exact: true }).click(),
      );
      await expect(page.getByTestId('push-notifications')).toContainText('Tower registrations removed.', {
        timeout: 20_000,
      });
      await expect(page.getByTestId('push-notifications')).toContainText('0 locally recorded tower registrations');
      await expect.poll(() => readPushRegistrationCount(tower!.url), { timeout: 10_000 }).toBe(1);
      await unregisterDirectPushWakeToken(tower.url, {
        runtimeId: accountRef.counterpartyRuntimeId,
        ownerWallet: victimWallet,
        tokenHash: victimRegistration.tokenHash,
      });
      await expect.poll(() => readPushRegistrationCount(tower!.url), { timeout: 10_000 }).toBe(0);
      await page.waitForTimeout(2_500);
      expect(capture.notifications).toHaveLength(1);
    } finally {
      // React recovery polling belongs to the open page, including after push revocation.
      // Close that client before stopping its tower so teardown cannot create a late 503.
      await timedStep('push_wake.close_client', () => closeRuntimePage(page));
      if (tower?.proc.exitCode === null) tower.proc.kill('SIGTERM');
      await capture.close();
    }
  },
);
