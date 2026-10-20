import type { RuntimeReplica, XLNModule, RuntimeAdapterActivityPage } from '../core/api/public/runtime-module';
import type { RuntimeAdapterInspection } from '../ui/src/runtime/adapter';
/**
 * E2E dispute coverage for account UI, settlement batching, reserve return, and reload persistence.
 *
 * These tests prove that a disputed bilateral account can be started from the UI, finalized into reserve,
 * permanently closed, and restored after reload without losing batch history.
 */
import { test, expect, type Page } from './global-setup.mts';
import { Wallet } from 'ethers';
import { timedStep } from './utils/e2e-timing.mts';
import { APP_BASE_URL, resetProdServer } from './utils/e2e-baseline';
import { gotoApp as gotoSharedApp } from './utils/e2e-demo-users';
import { createWalletIdentity, LOCAL_PASSWORD } from '../ui/tests/wallet-ui';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { capturePageScreenshot } from './utils/e2e-screenshots';
import { getJurisdictionStackId } from '../core/jurisdiction/machine/jurisdiction-stack';

type CurrentWalletWindow = Window & {
  __xln?: {
    env(): RuntimeReplica | null;
    xln(): Promise<XLNModule>;
    adapter(): RuntimeAdapterInspection | null;
    store: { getState(): { activeEntityId: string | null } };
  };
};

const INIT_TIMEOUT = 30_000;
const LONG_E2E = process.env.E2E_LONG === '1';
const ISOLATED_BASELINE_READY = process.env.E2E_ISOLATED_BASELINE_READY === '1';
const E2E_DISPUTE_RESPONSE_SECONDS = 5;

function randomMnemonic(): string {
  const mnemonic = Wallet.createRandom().mnemonic;
  if (!mnemonic) throw new Error('DISPUTE_MNEMONIC_UNAVAILABLE');
  return mnemonic.phrase;
}

async function getActiveApiBase(): Promise<string> {
  const apiBase = process.env.E2E_API_BASE_URL;
  if (!apiBase) throw new Error('DISPUTE_STAND_API_BASE_REQUIRED');
  return apiBase.replace(/\/+$/, '');
}

/** Require operator facts from the exact selected hub. */
async function hubDebugApiBase(page: Page, apiBase: string, hubEntityId: string): Promise<string> {
  const response = await page.request.get(`${apiBase}/api/health`);
  if (!response.ok()) throw new Error(`DISPUTE_HUB_HEALTH_HTTP:${response.status()}`);
  const health = (await response.json()) as { hubs?: Array<{ entityId?: string; apiUrl?: string }> };
  const hub = health.hubs?.find(hub => hub.entityId?.toLowerCase() === hubEntityId.toLowerCase());
  if (!hub?.apiUrl) throw new Error(`DISPUTE_HUB_API_UNAVAILABLE:${hubEntityId}`);
  return hub.apiUrl.replace(/\/+$/, '');
}

async function ensureHubAccountOpen(
  page: Page,
  identity: { entityId: string; signerId: string },
  disputeMode: 'auto' | 'manual' = 'auto',
): Promise<{ entityId: string; signerId: string; counterpartyId: string }> {
  const apiBase = await getActiveApiBase();
  const response = await page.request.get(`${apiBase}/api/debug/entities`);
  expect(response.ok(), 'debug entities endpoint must be available').toBe(true);
  const body = (await response.json()) as {
    entities?: Array<{ entityId?: string; isHub?: boolean; name?: string; metadata?: { name?: string } }>;
  };
  const hubs = (Array.isArray(body.entities) ? body.entities : []).filter(
    entity => entity.isHub === true && typeof entity.entityId === 'string',
  );
  const preferredHub = hubs.find(entity => {
    const name = String(entity.name || entity.metadata?.name || '')
      .trim()
      .toUpperCase();
    return disputeMode === 'manual' ? name === 'H2' : name !== 'H2';
  });
  const hubId = preferredHub?.entityId;
  expect(typeof hubId === 'string' && hubId.length > 0, `${disputeMode} dispute hub must be available`).toBe(true);

  if (!hubId) throw new Error('DISPUTE_HUB_UNAVAILABLE');
  await connectRuntimeToHub(
    page,
    identity,
    hubId,
    disputeMode === 'manual'
      ? {
          disputeConfig: {
            leftResponseSeconds: E2E_DISPUTE_RESPONSE_SECONDS,
            rightResponseSeconds: E2E_DISPUTE_RESPONSE_SECONDS,
          },
        }
      : {},
  );

  return {
    entityId: identity.entityId,
    signerId: identity.signerId,
    counterpartyId: hubId,
  };
}

async function readLocalReserveState(page: Page, entityId: string): Promise<bigint> {
  const value = await page.evaluate(entityId => {
    const env = (window as CurrentWalletWindow).__xln?.env();
    if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
    const replica = [...env.state.eReplicas.values()].find(entry => entry.entityId === entityId);
    if (!replica) throw new Error(`DISPUTE_ENTITY_MISSING:${entityId}`);
    return (replica.state.reserves.get(1) ?? 0n).toString();
  }, entityId);
  return BigInt(value);
}

async function readOnchainReserveViaAnvil(
  page: Page,
  entityId: string,
  opts: { hubEntityId: string },
): Promise<bigint> {
  const apiBase = await getActiveApiBase();
  const jurisdiction = await page
    .evaluate(
      ({ entityId }) => {
        const env = (window as CurrentWalletWindow).__xln?.env();
        if (!env?.state?.eReplicas) return null;
        const entityLower = String(entityId || '').toLowerCase();
        for (const [key, rep] of env.state.eReplicas.entries()) {
          const [eid] = String(key).split(':');
          if (String(eid || '').toLowerCase() !== entityLower) continue;
          const config = rep?.state?.config?.jurisdiction || null;
          if (config && typeof config === 'object') {
            return {
              chainId: Number(config.chainId),
              depositoryAddress: String(config.depositoryAddress || '').trim(),
            };
          }
          return null;
        }
        return null;
      },
      { entityId },
    )
    .catch(() => null);
  const jurisdictionRef = getJurisdictionStackId(jurisdiction);
  const params = new URLSearchParams({
    entityId,
    tokenId: '1',
  });
  if (jurisdictionRef) params.set('jurisdiction', jurisdictionRef);
  if (opts.hubEntityId) params.set('hubEntityId', opts.hubEntityId);
  // Anything the orchestrator forwards to a hub is stamped as coming from a
  // public proxy, so the hub refuses operator-only routes like /api/debug/*.
  // Ask the hub that owns the reserve directly; its own port is local operator.
  const debugBase = await hubDebugApiBase(page, apiBase, opts.hubEntityId);
  const response = await page.request.get(`${debugBase}/api/debug/reserve?${params.toString()}`);
  if (!response.ok()) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(`Unable to read on-chain reserve: status=${response.status()} body=${bodyText}`);
  }
  const bodyText = await response.text();
  const body = JSON.parse(bodyText) as { reserve?: string };
  if (typeof body.reserve !== 'string') {
    throw new Error(`Unable to read on-chain reserve: body=${bodyText}`);
  }
  return BigInt(body.reserve);
}

async function readAccountState(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<{
  exists: boolean;
  status: string;
  activeDispute: boolean;
  disputeTimeout: number;
  disputeStartTimestamp: number;
  leftResponseSeconds: number;
  rightResponseSeconds: number;
  block: number;
  jBatchDisputeStarts: number;
  jBatchDisputeFinalizations: number;
}> {
  return await page.evaluate(
    async ({ entityId, signerId, counterpartyId }) => {
      const env = (window as CurrentWalletWindow).__xln?.env();
      if (!env?.state?.eReplicas) {
        return {
          exists: false,
          status: '',
          activeDispute: false,
          disputeTimeout: 0,
          disputeStartTimestamp: 0,
          leftResponseSeconds: 0,
          rightResponseSeconds: 0,
          block: 0,
          jBatchDisputeStarts: 0,
          jBatchDisputeFinalizations: 0,
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
      const batch = rep?.state?.jBatchState?.batch;
      return {
        exists: !!account,
        status: String(account?.status || ''),
        activeDispute: !!account?.activeDispute,
        disputeTimeout: Number(account?.activeDispute?.disputeTimeout || 0),
        disputeStartTimestamp: Number(account?.activeDispute?.disputeStartTimestamp || 0),
        leftResponseSeconds: Number(account?.state?.disputeConfig?.leftResponseSeconds || 0),
        rightResponseSeconds: Number(account?.state?.disputeConfig?.rightResponseSeconds || 0),
        block: 0,
        jBatchDisputeStarts: Number(batch?.disputeStarts?.length || 0),
        jBatchDisputeFinalizations: Number(batch?.disputeFinalizations?.length || 0),
      };
    },
    { entityId, signerId, counterpartyId },
  );
}

async function readCurrentChainTimestamp(page: Page): Promise<number> {
  const body = await postRpc(page, 'eth_getBlockByNumber', ['latest', false]);
  const timestamp = (body.result as { timestamp?: unknown } | undefined)?.timestamp;
  if (typeof timestamp !== 'string') {
    throw new Error(`unexpected latest block timestamp: ${JSON.stringify(body)}`);
  }
  return Number.parseInt(timestamp, 16);
}

async function postRpc(page: Page, method: string, params: unknown[]): Promise<{ result?: unknown; error?: unknown }> {
  const apiBase = await getActiveApiBase();
  // The stack serves JSON-RPC at /rpc; /api/rpc has no route and 404s.
  const response = await page.request.post(`${apiBase}/rpc`, {
    data: {
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    },
  });
  const text = await response.text();
  let body: { result?: unknown; error?: unknown } = {};
  try {
    body = text ? (JSON.parse(text) as { result?: unknown; error?: unknown }) : {};
  } catch {
    body = { error: text.slice(0, 500) };
  }
  if (!response.ok()) throw new Error(`${method} RPC HTTP ${response.status()}: ${text.slice(0, 500)}`);
  if (body.error) throw new Error(`${method} RPC error: ${JSON.stringify(body.error)}`);
  return body;
}

async function mineOneBlock(page: Page): Promise<void> {
  await postRpc(page, 'evm_mine', []);
}

/** Advance the deterministic E2E chain to the contract's unix-second deadline. */
async function waitForUnixSeconds(page: Page, targetTimestamp: number): Promise<void> {
  const current = await readCurrentChainTimestamp(page);
  if (current >= targetTimestamp) return;
  // Account response policies are seconds on L1. Mining N blocks would quietly
  // reintroduce the retired block-delay model and make the test chain-specific.
  await postRpc(page, 'evm_setNextBlockTimestamp', [targetTimestamp]);
  await mineOneBlock(page);
  const advanced = await readCurrentChainTimestamp(page);
  if (advanced < targetTimestamp) {
    throw new Error(`failed to advance chain time: target=${targetTimestamp} actual=${advanced}`);
  }
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
      const env = (window as CurrentWalletWindow).__xln?.env();
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

function parseUiAmount(text: string): number {
  const cleaned = String(text || '')
    .replace(/\s+/g, '')
    .replace(/[^0-9,.-]/g, '')
    .replace(/,/g, '');
  const parsed = Number(cleaned || '0');
  if (!Number.isFinite(parsed)) throw new Error(`Unable to parse UI amount: "${text}"`);
  return parsed;
}

async function ensureEntityWorkspaceVisible(page: Page, entityId?: string): Promise<void> {
  if (entityId)
    await expect
      .poll(() => page.evaluate(() => (window as CurrentWalletWindow).__xln?.store.getState().activeEntityId))
      .toBe(entityId);
  await expect(page.getByTestId('nav-home').locator('visible=true').first()).toBeVisible();
}

async function ensureAccountWorkspaceVisible(page: Page, counterpartyId?: string, entityId?: string): Promise<void> {
  await ensureEntityWorkspaceVisible(page, entityId);
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('home-accounts')).toBeVisible();
  if (counterpartyId)
    await expect(page.locator(`[data-testid="account-row"][data-counterparty-id="${counterpartyId}"]`)).toBeVisible();
}

async function ensureEntityShellVisible(page: Page): Promise<void> {
  await expect(page.getByTestId('nav-home').locator('visible=true').first()).toBeVisible();
}

async function readReserveBalanceUi(page: Page, symbol = 'USDC'): Promise<number> {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-assets').click();
  const balance = page.getByTestId('faucet-reserve-balance');
  await expect(balance).toContainText(symbol);
  return parseUiAmount(await balance.innerText());
}

async function readAccountsCardOwedUi(page: Page): Promise<number> {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  const row = page.getByTestId('manage-position').locator('.kv').filter({ hasText: 'You owe' });
  await expect(row).toBeVisible();
  return parseUiAmount(await row.locator('.v').innerText());
}

async function seedDisputePreconditions(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<void> {
  const before = await readAccountMeta(page, entityId, signerId, counterpartyId);
  await page.evaluate(
    async ({ entityId, counterpartyId }) => {
      const env = (window as CurrentWalletWindow).__xln?.env();
      if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
      const runtimeId = String(env.runtimeId || '').toLowerCase();
      const response = await fetch(`${window.location.origin}/api/faucet/offchain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userEntityId: entityId,
          userRuntimeId: runtimeId,
          tokenId: 1,
          amount: '100',
          hubEntityId: counterpartyId,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.success) {
        throw new Error(body?.error || `offchain faucet failed (${response.status})`);
      }
    },
    { entityId, signerId, counterpartyId },
  );

  await expect
    .poll(
      async () => {
        const current = await readAccountMeta(page, entityId, signerId, counterpartyId);
        const hasFreshProofHash =
          current.counterpartyDisputeProofBodyHash.length > 0 &&
          current.counterpartyDisputeProofBodyHash !== before.counterpartyDisputeProofBodyHash;
        const hasFreshProofNonce =
          typeof current.counterpartyDisputeProofNonce === 'number' &&
          current.counterpartyDisputeProofNonce > 0 &&
          (before.counterpartyDisputeProofNonce === null ||
            current.counterpartyDisputeProofNonce > before.counterpartyDisputeProofNonce);
        return {
          frameAdvanced: current.frameHeight > before.frameHeight,
          hasProof: current.hasCounterpartyDisputeProof,
          pendingFrame: current.pendingFrame,
          freshProofHash: hasFreshProofHash,
          freshProofNonce: hasFreshProofNonce,
          proofHash: current.counterpartyDisputeProofBodyHash,
          proofNonce: current.counterpartyDisputeProofNonce,
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
}

async function broadcastPendingBatchViaUi(page: Page, entityId: string): Promise<void> {
  await ensureEntityWorkspaceVisible(page, entityId);
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('pending-batch')).toContainText('Dispute start');
  await page.getByTestId('batch-broadcast').click();
  // Finality can replace the start batch with the scheduler's finalize batch.
  // Observe the submitted operation; later assertions require both exact receipts.
  await expect(page.getByTestId('pending-batch').filter({ hasText: 'Dispute start' })).toHaveCount(0);
}

async function ensureNoSentBatchLatch(page: Page, entityId: string, signerId: string): Promise<void> {
  // A confirmed batch must clear through canonical J finality; never erase a stuck submission in a test.
  await expect
    .poll(async () => (await readJBatchSnapshot(page, entityId, signerId)).sentExists, {
      timeout: 10_000,
      intervals: [100, 250, 500],
    })
    .toBe(false);
}

async function assertBatchHistoryVisible(page: Page, entityId: string, signerId: string): Promise<void> {
  await ensureEntityWorkspaceVisible(page, entityId);
  await ensureEntityShellVisible(page);
  await expect
    .poll(
      async () => {
        const snapshot = await readJBatchSnapshot(page, entityId, signerId);
        return snapshot.batchHistoryCount;
      },
      { timeout: 20_000, intervals: [500, 1000, 2000] },
    )
    .toBeGreaterThan(0);
}

async function startDisputeFromManageWorkspace(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<void> {
  await ensureAccountWorkspaceVisible(page, counterpartyId, entityId);
  await page.locator(`[data-testid="account-row"][data-counterparty-id="${counterpartyId}"]`).click();
  await page.getByTestId('account-manage').click();
  await page.getByTestId('manage-tab-dispute').click();
  await page.getByTestId('dispute-prepare').click();
  await page.getByTestId('dispute-prepare-confirm').click();
  await expect
    .poll(async () => (await readAccountState(page, entityId, signerId, counterpartyId)).jBatchDisputeStarts, {
      timeout: 10_000,
      intervals: [100, 250, 500],
    })
    .toBeGreaterThan(0);
}

async function readDisputeDebug(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<{
  status: string;
  activeDispute: boolean;
  jBatchDisputeStarts: number;
  pendingEntityInputs: number;
  hasProofHanko: boolean;
}> {
  return await page.evaluate(
    ({ entityId, signerId, counterpartyId }) => {
      const env = (window as CurrentWalletWindow).__xln?.env();
      if (!env?.state?.eReplicas) {
        return {
          status: '',
          activeDispute: false,
          jBatchDisputeStarts: 0,
          pendingEntityInputs: 0,
          hasProofHanko: false,
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
        status: String(account?.status || ''),
        activeDispute: !!account?.activeDispute,
        jBatchDisputeStarts: Number(rep?.state?.jBatchState?.batch?.disputeStarts?.length || 0),
        pendingEntityInputs: Number(env.runtimeMempool.entityInputs.length || 0),
        hasProofHanko: !!account?.counterpartyDisputeProofHanko,
      };
    },
    { entityId, signerId, counterpartyId },
  );
}

async function readJBatchSnapshot(page: Page, entityId: string, signerId: string) {
  return page.evaluate(
    async ({ entityId, signerId }) => {
      const debug = (window as CurrentWalletWindow).__xln;
      const env = debug?.env();
      const adapter = debug?.adapter();
      const replica = env?.state.eReplicas.get(`${entityId}:${signerId}`);
      if (!replica || !adapter) throw new Error('DISPUTE_BATCH_OWNER_UNAVAILABLE');
      const activity = await adapter.read<RuntimeAdapterActivityPage>('activity', {
        entityId,
        kind: 'onchain',
        limit: 500,
        scanLimit: 2_000,
      });
      // Activity is newest first. Only observed HankoBatchProcessed events count;
      // queued commands or submission attempts are not chain confirmations.
      const history = activity.events.filter(event => event.rawType === 'HankoBatchProcessed');
      const last = history[0];
      const block = last?.subtitle.match(/J#(\d+)/)?.[1];
      if (last && !block) throw new Error(`DISPUTE_BATCH_J_BLOCK_MISSING:${last.id}`);
      return {
        pendingDisputeStarts: replica.state.jBatchState?.batch.disputeStarts.length ?? 0,
        sentExists: Boolean(replica.state.jBatchState?.sentBatch),
        batchHistoryCount: history.length,
        batchEventIds: history.map(event => event.id),
        lastBatchStatus: last?.status ?? '',
        lastBatchJBlock: Number(block ?? 0),
      };
    },
    { entityId, signerId },
  );
}

async function readSignedClaim(page: Page, entityId: string, counterpartyId: string): Promise<bigint> {
  const amount = await page.evaluate(
    async ({ entityId, counterpartyId }) => {
      const debug = (window as CurrentWalletWindow).__xln;
      const env = debug?.env();
      const replica = [...(env?.state.eReplicas.values() ?? [])].find(replica => replica.entityId === entityId);
      const account = replica?.state.accounts.get(counterpartyId);
      const delta = account?.state.deltas.get(1);
      if (!debug || !account || !delta || account.pendingFrame || !account.counterpartyDisputeProofHanko)
        throw new Error('DISPUTE_SIGNED_USDC_CLAIM_UNAVAILABLE');
      const xln = await debug.xln();
      const d = xln.deriveDelta(delta, xln.isLeftEntity(entityId, counterpartyId));
      return (d.outCollateral + d.outPeerCredit - d.inOwnCredit).toString();
    },
    { entityId, counterpartyId },
  );
  return BigInt(amount);
}

async function assertClosedAccountUi(page: Page, counterpartyId: string): Promise<void> {
  await ensureAccountWorkspaceVisible(page, counterpartyId);
  const row = page.locator(`[data-testid="account-row"][data-counterparty-id="${counterpartyId}"]`);
  await expect(row).toContainText('Closed after dispute');
  await row.click();
  await expect(page.getByTestId('account-status')).toHaveText('Closed after dispute');
  await expect(page.getByTestId('account-dispute-state')).toHaveText(
    'Dispute finalized. This account is permanently closed.',
  );
  await expect(page.getByTestId('account-extend-credit')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Pay', exact: true })).toBeDisabled();
  await expect(page.getByTestId('account-dispute')).toHaveCount(0);
}

test.describe('E2E Dispute Flow', () => {
  test.describe.configure({ timeout: LONG_E2E ? 480_000 : 180_000 });

  test.beforeEach(async ({ page }) => {
    if (ISOLATED_BASELINE_READY) {
      console.log('[E2E-TIMING] dispute.reset_server.skip 0ms');
      return;
    }
    await timedStep('dispute.reset_server', () => resetProdServer(page, { timeoutMs: LONG_E2E ? 240_000 : 180_000 }));
  });

  // Scenario: trigger a dispute from the entity workspace, observe reserve returning after finalize,
  // then confirm reload restores finality and the permanently closed Account.
  test('entity workspace dispute lifecycle returns reserve', { tag: '@resilience' }, async ({ page }, testInfo) => {
    test.setTimeout(LONG_E2E ? 420_000 : 300_000);
    page.on('console', msg => {
      if (msg.type() === 'error') {
        process.stdout.write(`[BROWSER:error] ${msg.text()}\n`);
      }
    });

    await timedStep('dispute.goto_app', () =>
      gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 500 }),
    );
    const identity = await timedStep('dispute.create_runtime', () =>
      createWalletIdentity(page, `dispute-rt-${Date.now()}`, randomMnemonic()),
    );
    // H1/H3 may correctly finalize as the counterparty immediately after DisputeStarted.
    // Use H2's explicit manual mode so this lifecycle test deterministically observes
    // the active state before advancing to the timeout and finalization stages.
    const accountRef = await timedStep('dispute.ensure_hub_account', () =>
      ensureHubAccountOpen(page, identity, 'manual'),
    );
    await timedStep('dispute.seed_preconditions', () =>
      seedDisputePreconditions(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId),
    );

    const localReserveBefore = await readLocalReserveState(page, accountRef.entityId);
    expect(localReserveBefore).toBeGreaterThanOrEqual(0n);
    const reserveBefore = await readOnchainReserveViaAnvil(page, accountRef.entityId, {
      hubEntityId: accountRef.counterpartyId,
    });
    const claim = await readSignedClaim(page, accountRef.entityId, accountRef.counterpartyId);
    expect(claim, 'the real offchain faucet committed exactly 100 USDC of signed value').toBe(100_000_000n);
    const hubReserve = await readOnchainReserveViaAnvil(page, accountRef.counterpartyId, {
      hubEntityId: accountRef.counterpartyId,
    });
    expect(hubReserve, 'this fully collectible claim needs liquid hub reserve').toBeGreaterThanOrEqual(claim);
    expect(await readReserveBalanceUi(page, 'USDC')).toBe(Number(reserveBefore) / 1_000_000);
    const batchBeforeDispute = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);

    try {
      await timedStep('dispute.ui_start_dispute', () =>
        startDisputeFromManageWorkspace(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId),
      );
    } catch (error) {
      const debug = await readDisputeDebug(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`disputeStart not observed via UI click. cause=${message} debug=${JSON.stringify(debug)}`);
    }
    await timedStep('dispute.wait_batch_queue_dispute_start', async () => {
      await expect
        .poll(
          async () => {
            const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
            return snap.pendingDisputeStarts;
          },
          { timeout: 60_000, intervals: [500, 1000, 2000] },
        )
        .toBeGreaterThan(batchBeforeDispute.pendingDisputeStarts);
    });
    const disputeQueued = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
    const disputeHistoryBeforeBroadcast = disputeQueued.batchHistoryCount;

    await timedStep('dispute.broadcast_start_batch', () => broadcastPendingBatchViaUi(page, accountRef.entityId));
    await timedStep('dispute.wait_batch_history_confirmed', async () => {
      try {
        await expect
          .poll(
            async () => {
              const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
              return {
                batchHistoryCount: snap.batchHistoryCount,
                lastBatchStatus: snap.lastBatchStatus,
              };
            },
            { timeout: 120_000, intervals: [500, 1000, 2000] },
          )
          .toMatchObject({
            batchHistoryCount: expect.any(Number),
            lastBatchStatus: 'recorded',
          });
        await expect
          .poll(
            async () => {
              const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
              return snap.batchHistoryCount;
            },
            { timeout: 120_000, intervals: [500, 1000, 2000] },
          )
          .toBeGreaterThan(disputeHistoryBeforeBroadcast);
      } catch {
        const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
        throw new Error(`dispute broadcast not finalized. snapshot=${JSON.stringify(snap)}`);
      }
    });

    let disputedState = await readAccountState(
      page,
      accountRef.entityId,
      accountRef.signerId,
      accountRef.counterpartyId,
    );
    await timedStep('dispute.wait_active_dispute', async () => {
      await expect
        .poll(
          async () => {
            disputedState = await readAccountState(
              page,
              accountRef.entityId,
              accountRef.signerId,
              accountRef.counterpartyId,
            );
            return disputedState.activeDispute;
          },
          { timeout: 60_000, intervals: [500, 1000, 2000] },
        )
        .toBe(true);
    });
    expect(disputedState.activeDispute, 'dispute must become active after disputeStart broadcast').toBe(true);
    await ensureAccountWorkspaceVisible(page, undefined, accountRef.entityId);
    await capturePageScreenshot(page, testInfo, 'dispute-active-desktop.png', {
      fullPage: false,
      ux: {
        title: 'desktop active dispute',
        group: 'Disputes',
        description: 'Account list after a dispute start batch is confirmed on-chain.',
        platform: 'desktop',
        tags: ['dispute', 'batch', 'active'],
      },
    });

    const currentChainTimestamp = await readCurrentChainTimestamp(page);
    expect(disputedState.disputeStartTimestamp, 'disputeStartTimestamp should be set').toBeGreaterThan(0);
    expect(disputedState.disputeTimeout, 'disputeTimeout should be a future unix timestamp').toBeGreaterThan(
      currentChainTimestamp,
    );
    expect(disputedState.disputeTimeout).toBe(
      disputedState.disputeStartTimestamp + disputedState.leftResponseSeconds + disputedState.rightResponseSeconds,
    );

    const finalizeBatchBefore = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
    await timedStep('dispute.wait_timeout_seconds', () => waitForUnixSeconds(page, disputedState.disputeTimeout));
    await timedStep('dispute.wait_auto_finalize_history_confirmed', async () => {
      await expect
        .poll(
          async () => {
            const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
            return {
              batchHistoryCount: snap.batchHistoryCount,
              lastBatchStatus: snap.lastBatchStatus,
            };
          },
          { timeout: 120_000, intervals: [500, 1000, 2000] },
        )
        .toMatchObject({
          batchHistoryCount: expect.any(Number),
          lastBatchStatus: 'recorded',
        });
      await expect
        .poll(
          async () => {
            const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
            return snap.batchHistoryCount;
            // The signed test Account uses a short seconds-based response policy so
            // the real scheduler clock reaches the deadline without weakening the
            // production defaults exercised by ordinary hub connections.
          },
          { timeout: 180_000, intervals: [500, 1000, 2000] },
        )
        .toBeGreaterThan(finalizeBatchBefore.batchHistoryCount);
    });
    await timedStep('dispute.wait_finalize_applied', async () => {
      await expect
        .poll(
          async () => {
            const state = await readAccountState(
              page,
              accountRef.entityId,
              accountRef.signerId,
              accountRef.counterpartyId,
            );
            return !state.activeDispute && state.status === 'disputed';
          },
          { timeout: 120_000, intervals: [500, 1000, 2000] },
        )
        .toBe(true);
    });

    const reserveAfter = await readOnchainReserveViaAnvil(page, accountRef.entityId, {
      hubEntityId: accountRef.counterpartyId,
    });
    expect(reserveAfter, 'finalization collects the exact signed claim into reserve').toBe(reserveBefore + claim);
    await expect.poll(() => readLocalReserveState(page, accountRef.entityId)).toBe(reserveAfter);
    console.log(`DISPUTE_EXACT_MONEY claim=${claim} reserveBefore=${reserveBefore} reserveAfter=${reserveAfter}`);
    await timedStep('dispute.wait_ui_reserve_balance', async () => {
      await expect
        .poll(
          async () => {
            return await readReserveBalanceUi(page, 'USDC');
          },
          { timeout: 60_000, intervals: [500, 1000, 2000] },
        )
        .toBe(Number(reserveAfter) / 1_000_000);
    });
    await timedStep('dispute.wait_ui_accounts_owed_zero', async () => {
      await expect
        .poll(
          async () => {
            return await readAccountsCardOwedUi(page);
          },
          { timeout: 60_000, intervals: [500, 1000, 2000] },
        )
        .toBeLessThanOrEqual(0);
    });

    // Current React keeps the closed Account visible as evidence, with financial actions disabled.
    await timedStep('dispute.closed_account_ui', () => assertClosedAccountUi(page, accountRef.counterpartyId));
    await timedStep('dispute.confirmed_batch_released', () =>
      ensureNoSentBatchLatch(page, accountRef.entityId, accountRef.signerId),
    );

    await assertBatchHistoryVisible(page, accountRef.entityId, accountRef.signerId);

    const finalSnapshot = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
    expect(finalSnapshot.batchHistoryCount).toBe(batchBeforeDispute.batchHistoryCount + 2);
    expect(finalSnapshot.lastBatchStatus).toBe('recorded');
    expect(finalSnapshot.lastBatchJBlock).toBeGreaterThan(0);
    await timedStep('dispute.reload_confirm_batch_released', () =>
      ensureNoSentBatchLatch(page, accountRef.entityId, accountRef.signerId),
    );

    // Reload hard-assert: WAL restore keeps finalized dispute + batch history.
    await timedStep('dispute.reload_page', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await page.waitForFunction(
        ({ runtimeId, entityId }) => {
          const debug = (window as CurrentWalletWindow).__xln;
          return debug?.env()?.runtimeId === runtimeId && debug.store.getState().activeEntityId === entityId;
        },
        identity,
        { timeout: 10_000 },
      );
    });
    await timedStep('dispute.reload_assert_reserve', async () => {
      await expect
        .poll(
          async () =>
            await readOnchainReserveViaAnvil(page, accountRef.entityId, {
              hubEntityId: accountRef.counterpartyId,
            }),
          {
            timeout: 60_000,
            intervals: [500, 1000, 2000],
          },
        )
        .toBe(reserveAfter);
    });
    await timedStep('dispute.reload_assert_finalized_disputed_entry', async () => {
      await assertClosedAccountUi(page, accountRef.counterpartyId);
      await capturePageScreenshot(page, testInfo, 'dispute-finalized-recovery-desktop.png', { fullPage: false });
    });
    await timedStep('dispute.reload_assert_batch_history', async () => {
      await expect
        .poll(
          async () => {
            const snapshot = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
            return snapshot.batchEventIds;
          },
          { timeout: 10_000, intervals: [100, 250, 500] },
        )
        .toEqual(finalSnapshot.batchEventIds);
    });
  });

  // Scenario: the entity settle workspace must be able to sign and broadcast the queued dispute batch,
  // and history must reflect the dispute lifecycle without entering account panel UI.
  test('entity settle workspace Sign & Broadcast submits dispute batch', { tag: '@resilience' }, async ({ page }) => {
    test.setTimeout(LONG_E2E ? 240_000 : 120_000);
    page.on('console', msg => {
      if (msg.type() === 'error') {
        process.stdout.write(`[BROWSER:error] ${msg.text()}\n`);
      }
    });

    await timedStep('dispute_broadcast.goto_app', () =>
      gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 500 }),
    );
    const identity = await timedStep('dispute_broadcast.create_runtime', () =>
      createWalletIdentity(page, `dispute-ui-broadcast-rt-${Date.now()}`, randomMnemonic()),
    );
    const accountRef = await timedStep('dispute_broadcast.ensure_hub_account', () =>
      ensureHubAccountOpen(page, identity),
    );
    await timedStep('dispute_broadcast.seed_preconditions', () =>
      seedDisputePreconditions(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId),
    );

    await timedStep('dispute_broadcast.start_dispute', () =>
      startDisputeFromManageWorkspace(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId),
    );
    await timedStep('dispute_broadcast.broadcast', () => broadcastPendingBatchViaUi(page, accountRef.entityId));

    await timedStep('dispute_broadcast.wait_batch_history_confirmed', async () => {
      await expect
        .poll(
          async () => {
            const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
            return {
              batchHistoryCount: snap.batchHistoryCount,
              lastBatchStatus: snap.lastBatchStatus,
            };
          },
          { timeout: 60_000, intervals: [500, 1000, 2000] },
        )
        .toMatchObject({
          batchHistoryCount: expect.any(Number),
          lastBatchStatus: 'recorded',
        });
      await expect
        .poll(
          async () => {
            const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
            return snap.batchHistoryCount;
          },
          { timeout: 60_000, intervals: [500, 1000, 2000] },
        )
        .toBeGreaterThanOrEqual(1);
    });

    await timedStep('dispute_broadcast.current_disputed_entry', async () => {
      await ensureAccountWorkspaceVisible(page, accountRef.counterpartyId, accountRef.entityId);
      const row = page.locator(`[data-testid="account-row"][data-counterparty-id="${accountRef.counterpartyId}"]`);
      await expect(row).toContainText(/Dispute in progress|Closed after dispute/);
      await row.click();
      await expect(page.getByTestId('account-extend-credit')).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Pay', exact: true })).toBeDisabled();
    });
  });
});
