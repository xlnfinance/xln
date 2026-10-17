import type { RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import { expect, type Page } from '@playwright/test';
import { getTokenInfo } from '../../core/account/utils';
import { enqueueEntityTxs } from './runtime/e2e-runtime-input';

const DEFAULT_TOKEN_IDS = [1] as const;
const diagnosticOpenTimeoutMs = Number(process.env.E2E_DIAGNOSTIC_OPEN_TIMEOUT_MS || 75_000);
const DEFAULT_OPEN_TIMEOUT_MS = Number.isSafeInteger(diagnosticOpenTimeoutMs) && diagnosticOpenTimeoutMs >= 1_000
  ? diagnosticOpenTimeoutMs
  : 75_000;
const DEFAULT_CREDIT_AMOUNT_DISPLAY = '10000';

type ConnectRuntimeOptions = {
  requireOnline?: boolean;
  disputeConfig?: {
    leftResponseSeconds: number;
    rightResponseSeconds: number;
  };
};

const stringifyDebug = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);

async function readSelectedUiRuntimeIdentity(page: Page): Promise<{ entityId: string; signerId: string }> {
  const trigger = page.getByTestId('context-current').first();
  await expect(trigger).toBeVisible({ timeout: 20_000 });

  const [entityId, signerId] = await Promise.all([
    trigger.getAttribute('data-entity-id'),
    trigger.getAttribute('data-signer-id'),
  ]);

  const selected = {
    entityId: String(entityId || '').trim(),
    signerId: String(signerId || '').trim(),
  };

  expect(selected.entityId, 'UI-selected entityId must be present').toMatch(/^0x[a-fA-F0-9]{64}$/);
  expect(selected.signerId, 'UI-selected signerId must be present').toMatch(/^0x[a-fA-F0-9]{40}$/);
  return selected;
}

type CurrentRuntimeWindow = Window & {
  __xln?: { env(): RuntimeReplica | null; store: { getState(): { activeEntityId: string | null } } };
};

export async function ensureRuntimeOnline(page: Page, tag: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const env = (window as CurrentRuntimeWindow).__xln?.env();
          if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
          const p2p = env.infrastructure?.p2p;
          if (!p2p) throw new Error('CURRENT_WALLET_P2P_MISSING');
          return p2p.isConnected();
        }),
      { timeout: 20_000, message: `[${tag}] runtime must be online` },
    )
    .toBe(true);
}

async function nudgeRuntimeOnline(page: Page): Promise<void> {
  await page.evaluate(() => {
    const p2p = (window as CurrentRuntimeWindow).__xln?.env()?.infrastructure?.p2p;
    if (!p2p) throw new Error('CURRENT_WALLET_P2P_MISSING');
    if (!p2p.isConnected()) p2p.connect();
  });
}

async function isAccountReady(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
  tokenIds: readonly number[],
  timeoutMs = 0,
): Promise<boolean> {
  return page.evaluate(
    async ({ entityId, signerId, hubId, tokenIds, timeoutMs }) => {
      const env = (window as CurrentRuntimeWindow).__xln?.env();
      if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
      const startedAt = Date.now();
      do {
        const replica = env.state.eReplicas.get(`${entityId}:${signerId}`.toLowerCase());
        const account = replica?.state.accounts.get(hubId.toLowerCase());
        if (
          account &&
          account.currentHeight > 0 &&
          !account.pendingFrame &&
          tokenIds.every(tokenId => account.state.deltas.has(tokenId))
        )
          return true;
        if (timeoutMs <= 0) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() - startedAt < timeoutMs);
      return false;
    },
    { entityId, signerId, hubId, tokenIds: [...tokenIds], timeoutMs },
  );
}

async function openAccountsWorkspace(page: Page): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('home-pay')).toBeVisible({ timeout: 20_000 });
}

async function connectHubThroughUi(page: Page, hubId: string): Promise<void> {
  await openAccountsWorkspace(page);
  if (await hasRenderedCommittedAccountCard(page, hubId)) return;
  await waitForHubRuntimeTransportReady(page, hubId);
  await page.getByRole('button', { name: 'Connect another account', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Open account', exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByTestId('open-account-target').fill(hubId);
  await sheet.getByTestId('open-account-credit').fill(DEFAULT_CREDIT_AMOUNT_DISPLAY);
  const submit = sheet.getByTestId('open-account-submit');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(sheet).toBeHidden();
  await waitForRenderedCommittedAccountCard(page, hubId, 'public React account proposal');
}

async function readLocalConnectRuntimeDiagnostic(page: Page, hubId: string): Promise<unknown> {
  return page.evaluate(hubId => {
    const env = (window as CurrentRuntimeWindow).__xln?.env();
    if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
    const p2p = env.infrastructure?.p2p;
    return {
      height: env.state.height,
      timestamp: env.state.timestamp,
      runtimeId: env.runtimeId,
      connected: p2p?.isConnected() ?? false,
      directPeers: p2p?.getDirectPeerState() ?? [],
      hubProfile: env.gossip.getProfile(hubId.toLowerCase()),
      runtimeMempool: env.runtimeMempool.entityInputs.map(input => ({
        entityId: input.entityId,
        txs: input.entityTxs?.map(tx => tx.type) ?? [],
      })),
      replicas: Array.from(env.state.eReplicas, ([key, replica]) => {
        const account = replica.state.accounts.get(hubId.toLowerCase());
        return {
          key,
          height: replica.state.height,
          jHistoryFinality: replica.state.jHistoryFinality,
          mempool: replica.mempool.map(tx => tx.type),
          proposalHeight: replica.proposal?.height ?? null,
          hubAccount: account
            ? {
                height: account.currentHeight,
                root: account.currentFrame.accountStateRoot,
                pendingHeight: account.pendingFrame?.height ?? null,
                mempool: account.mempool.map(tx => tx.type),
                deltas: Array.from(account.state.deltas),
              }
            : null,
        };
      }),
    };
  }, hubId);
}

async function waitForRenderedCommittedAccountCard(
  page: Page,
  hubId: string,
  context: string,
): Promise<void> {
  await openAccountsWorkspace(page);
  await expect
    .poll(async () => await hasRenderedCommittedAccountCard(page, hubId), {
      timeout: DEFAULT_OPEN_TIMEOUT_MS,
      intervals: [250, 500, 750],
      message: `${context}: rendered account ${hubId.slice(0, 10)} must be committed`,
    })
    .toBe(true);
}

async function waitForHubRuntimeProfile(page: Page, hubId: string, timeoutMs = 20_000): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(hubId => {
          const env = (window as CurrentRuntimeWindow).__xln?.env();
          if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
          return Boolean(env.gossip.getProfile(hubId.toLowerCase())?.runtimeId);
        }, hubId),
      { timeout: timeoutMs, message: `hub ${hubId.slice(0, 10)} must have a gossip runtime route` },
    )
    .toBe(true);
}

async function waitForHubRuntimeTransportReady(page: Page, hubId: string, timeoutMs = 30_000): Promise<void> {
  await waitForHubRuntimeProfile(page, hubId, timeoutMs);
  await expect
    .poll(
      () =>
        page.evaluate(hubId => {
          const env = (window as CurrentRuntimeWindow).__xln?.env();
          const p2p = env?.infrastructure?.p2p;
          if (!env || !p2p) throw new Error('CURRENT_WALLET_P2P_MISSING');
          const profile = env.gossip.getProfile(hubId.toLowerCase());
          if (!profile?.runtimeId) return false;
          if (p2p.isConnected()) return true;
          p2p.connect();
          if (!profile.wsUrl) return false;
          const endpoint = new URL(profile.wsUrl);
          const directAllowed =
            window.location.protocol !== 'https:' ||
            endpoint.protocol === 'wss:' ||
            (endpoint.protocol === 'ws:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(endpoint.hostname));
          return (
            directAllowed && p2p.getDirectPeerState().some(peer => peer.runtimeId === profile.runtimeId && peer.open)
          );
        }, hubId),
      { timeout: timeoutMs, message: `hub ${hubId.slice(0, 10)} transport route must be open before account tx` },
    )
    .toBe(true);
}

async function enqueueOpenAccount(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
  disputeConfig?: ConnectRuntimeOptions['disputeConfig'],
): Promise<void> {
  await waitForHubRuntimeTransportReady(page, hubId);
  await enqueueEntityTxs(page, entityId, signerId, [{
    type: 'openAccount',
    data: {
      targetEntityId: hubId,
      disputeConfig: disputeConfig ?? (
        entityId.toLowerCase() < hubId.toLowerCase()
          ? { leftResponseSeconds: 86_400, rightResponseSeconds: 3_600 }
          : { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 }
      ),
      creditAmount: 10_000n * 10n ** BigInt(getTokenInfo(1).decimals),
      tokenId: 1,
    },
  }]);
}

async function extendCreditToken(
  page: Page,
  identity: { entityId: string; signerId: string },
  hubId: string,
  tokenId: number,
  amountDisplay: string,
): Promise<void> {
  await waitForHubRuntimeTransportReady(page, hubId);
  await assertNoLocalHubDivergence(page, identity, hubId, [tokenId], `extendCredit token=${tokenId}`);
  const hubBaseStatus = await readHubAccountStatus(page, identity.entityId, hubId, [1]);
  if (!hubBaseStatus.hasAccount || !hubBaseStatus.ready) {
    await waitForHubBaseAccountReady(page, identity, hubId, `extendCredit token=${tokenId}`);
  }
  const before = await getAccountOpenStatus(page, identity.entityId, identity.signerId, hubId);
  const amount = BigInt(amountDisplay) * 10n ** BigInt(getTokenInfo(tokenId).decimals);
  await enqueueEntityTxs(page, identity.entityId, identity.signerId, [{
    type: 'extendCredit',
    data: {
      counterpartyEntityId: hubId,
      tokenId,
      amount,
    },
  }]);

  try {
    await expect.poll(
      async () => {
        const status = await getAccountOpenStatus(page, identity.entityId, identity.signerId, hubId);
        if (status.currentHeight <= before.currentHeight || status.pendingHeight) return false;
        return await isAccountReady(page, identity.entityId, identity.signerId, hubId, [tokenId], 0);
      },
      {
        timeout: DEFAULT_OPEN_TIMEOUT_MS,
        intervals: [250, 500, 750],
        message: `extendCredit should activate token ${tokenId} for ${hubId.slice(0, 10)}`,
      },
    ).toBe(true);
    await waitForHubAccountReady(page, identity.entityId, hubId, [tokenId]);
  } catch (error) {
    const [localStatus, hubStatus, debugState, relayDebug] = await Promise.all([
      getAccountOpenStatus(page, identity.entityId, identity.signerId, hubId).catch((statusError) => ({
        error: statusError instanceof Error ? statusError.message : String(statusError),
      })),
      readHubAccountStatus(page, identity.entityId, hubId, [tokenId]).catch((statusError) => ({
        error: statusError instanceof Error ? statusError.message : String(statusError),
      })),
      readLocalConnectRuntimeDiagnostic(page, hubId).catch((debugError) => ({
        error: debugError instanceof Error ? debugError.message : String(debugError),
      })),
      readRelayDebugEvents(page, 20).catch((debugError) => ({
        error: debugError instanceof Error ? debugError.message : String(debugError),
      })),
    ]);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
      `localStatus=${stringifyDebug(localStatus)}\n` +
      `hubStatus=${stringifyDebug(hubStatus)}\n` +
      `connectDebug=${stringifyDebug(debugState)}\n` +
      `relayDebug=${stringifyDebug(relayDebug)}`,
    );
  }
}

type AccountOpenStatus = {
  exists: boolean;
  hasDelta: boolean;
  pendingHeight: number | null;
  currentHeight: number;
};

type HubAccountStatus = {
  success?: boolean;
  hasAccount?: boolean;
  ready?: boolean;
  currentHeight?: number;
  pendingFrameHeight?: number | null;
  mempool?: number;
  runtime?: {
    halted?: boolean;
    fatalDebugPayload?: unknown;
  };
  tokens?: Array<{
    tokenId?: number;
    hasDelta?: boolean;
    hubOutCapacity?: string;
  }>;
  directInput?: {
    lastSeen?: {
      at?: number;
      fromRuntimeId?: string;
      entityId?: string;
      signerId?: string;
      txTypes?: string[];
    } | null;
    lastError?: {
      at?: number;
      fromRuntimeId?: string;
      entityId?: string;
      signerId?: string;
      txTypes?: string[];
      error?: string;
    } | null;
  };
  code?: string;
  error?: string;
};

async function assertNoLocalHubDivergence(
  page: Page,
  identity: { entityId: string; signerId: string },
  hubId: string,
  tokenIds: readonly number[],
  context: string,
): Promise<void> {
  const [localStatus, hubStatus] = await Promise.all([
    getAccountOpenStatus(page, identity.entityId, identity.signerId, hubId),
    readHubAccountStatus(page, identity.entityId, hubId, tokenIds).catch((error): HubAccountStatus => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    })),
  ]);

  if (hubStatus.runtime?.halted) {
    throw new Error(
      `${context}: HUB_RUNTIME_HALTED before sending account tx\n` +
      `localStatus=${stringifyDebug(localStatus)}\n` +
      `hubStatus=${stringifyDebug(hubStatus)}`,
    );
  }

}

async function waitForHubBaseAccountReady(
  page: Page,
  identity: { entityId: string; signerId: string },
  hubId: string,
  context: string,
): Promise<void> {
  try {
    await waitForHubAccountReady(page, identity.entityId, hubId, [1]);
  } catch (error) {
    const [localStatus, hubStatus, debugState, relayDebug] = await Promise.all([
      getAccountOpenStatus(page, identity.entityId, identity.signerId, hubId).catch(statusError => ({
        error: statusError instanceof Error ? statusError.message : String(statusError),
      })),
      readHubAccountStatus(page, identity.entityId, hubId, [1]).catch(statusError => ({
        error: statusError instanceof Error ? statusError.message : String(statusError),
      })),
      readLocalConnectRuntimeDiagnostic(page, hubId).catch(debugError => ({
        error: debugError instanceof Error ? debugError.message : String(debugError),
      })),
      readRelayDebugEvents(page, 20).catch(debugError => ({
        error: debugError instanceof Error ? debugError.message : String(debugError),
      })),
    ]);
    throw new Error(
      `${context}: hub-side base account did not commit before next account tx\n` +
      `${error instanceof Error ? error.message : String(error)}\n` +
      `localStatus=${stringifyDebug(localStatus)}\n` +
      `hubStatus=${stringifyDebug(hubStatus)}\n` +
      `connectDebug=${stringifyDebug(debugState)}\n` +
      `relayDebug=${stringifyDebug(relayDebug)}`,
    );
  }
}

async function getAccountOpenStatus(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
): Promise<AccountOpenStatus> {
  return page.evaluate(
    ({ entityId, signerId, hubId }) => {
      const env = (window as CurrentRuntimeWindow).__xln?.env();
      if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
      const account = env.state.eReplicas
        .get(`${entityId}:${signerId}`.toLowerCase())
        ?.state.accounts.get(hubId.toLowerCase());
      return account
        ? {
            exists: true,
            hasDelta: account.state.deltas.has(1),
            pendingHeight: account.pendingFrame?.height ?? null,
            currentHeight: account.currentHeight,
          }
        : { exists: false, hasDelta: false, pendingHeight: null, currentHeight: 0 };
    },
    { entityId, signerId, hubId },
  );
}

async function readRelayDebugEvents(page: Page, last = 20): Promise<unknown> {
  const origin = new URL(page.url()).origin;
  const url = new URL('/api/debug/events', origin);
  url.searchParams.set('last', String(last));
  const response = await page.request.get(url.toString());
  const body = await response.json().catch(() => ({}));
  return {
    ok: response.ok(),
    status: response.status(),
    body,
  };
}

async function readHubAccountStatus(
  page: Page,
  userEntityId: string,
  hubId: string,
  tokenIds: readonly number[],
): Promise<HubAccountStatus> {
  const origin = new URL(page.url()).origin;
  const url = new URL('/api/hub/account-status', origin);
  url.searchParams.set('hubEntityId', hubId);
  url.searchParams.set('counterpartyEntityId', userEntityId);
  if (tokenIds.length > 0) {
    url.searchParams.set('tokenIds', tokenIds.join(','));
  }
  const response = await page.request.get(url.toString());
  const body = await response.json().catch(() => ({} as HubAccountStatus));
  return {
    ...body,
    success: response.ok() && body.success !== false,
  };
}

async function waitForHubAccountReady(
  page: Page,
  userEntityId: string,
  hubId: string,
  tokenIds: readonly number[],
): Promise<void> {
  let lastStatus: HubAccountStatus = { error: 'not-run' };
  let lastEvidence = '';
  await expect.poll(
    async () => {
      lastStatus = await readHubAccountStatus(page, userEntityId, hubId, tokenIds);
      const tokens = Array.isArray(lastStatus.tokens) ? lastStatus.tokens : [];
      const evidence = stringifyDebug({
        hubId,
        userEntityId,
        success: lastStatus.success,
        hasAccount: lastStatus.hasAccount,
        ready: lastStatus.ready,
        tokens,
      });
      if (evidence !== lastEvidence) {
        console.log(`[HUB_ACCOUNT_READINESS] ${evidence}`);
        lastEvidence = evidence;
      }
      const tokenReady = tokenIds.every(tokenId => {
        const token = tokens.find(entry => Number(entry.tokenId) === Number(tokenId));
        return Boolean(token?.hasDelta) && BigInt(String(token?.hubOutCapacity || '0')) > 0n;
      });
      return Boolean(lastStatus.success && lastStatus.hasAccount && lastStatus.ready && tokenReady);
    },
    {
      timeout: DEFAULT_OPEN_TIMEOUT_MS,
      intervals: [250, 500, 750],
      message: `hub-side account ${hubId.slice(0, 10)} must be ready for ${userEntityId.slice(0, 10)}`,
    },
  ).toBe(true);

  expect(
    lastStatus.ready,
    `hub-side account not ready: ${stringifyDebug(lastStatus)}`,
  ).toBe(true);
}

async function hasExportedRuntimeEnv(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean((window as CurrentRuntimeWindow).__xln?.env()?.runtimeId));
}

async function hasExportedRuntimeP2P(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean((window as CurrentRuntimeWindow).__xln?.env()?.infrastructure?.p2p));
}

async function hasRenderedCommittedAccountCard(page: Page, hubId: string): Promise<boolean> {
  if (!(await page.locator(`[data-testid="account-row"][data-counterparty-id="${hubId.toLowerCase()}"]`).isVisible()))
    return false;
  return page.evaluate(hubId => {
    const debug = (window as CurrentRuntimeWindow).__xln;
    if (!debug) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
    const env = debug.env();
    const owner = debug.store.getState().activeEntityId;
    if (!env || !owner) throw new Error('CURRENT_WALLET_OWNER_MISSING');
    return [...env.state.eReplicas.values()].some(
      replica =>
        replica.entityId === owner && (replica.state.accounts.get(hubId.toLowerCase())?.currentHeight ?? 0) > 0,
    );
  }, hubId);
}

export async function connectRuntimeToHub(
  page: Page,
  identity: { entityId: string; signerId: string },
  hubId: string,
  options: ConnectRuntimeOptions = {},
): Promise<void> {
  await connectRuntimeToHubWithCredit(
    page,
    identity,
    hubId,
    DEFAULT_CREDIT_AMOUNT_DISPLAY,
    DEFAULT_TOKEN_IDS,
    options,
  );
}

export async function connectRuntimeToHubWithCredit(
  page: Page,
  identity: { entityId: string; signerId: string },
  hubId: string,
  creditAmountDisplay: string,
  tokenIds: readonly number[] = [1],
  options: ConnectRuntimeOptions = {},
): Promise<void> {
  if (options.requireOnline !== false) {
    await ensureRuntimeOnline(page, 'connect-runtime-to-hub');
  } else {
    await nudgeRuntimeOnline(page);
  }
  const canUseDefaultUiConnect =
    creditAmountDisplay === DEFAULT_CREDIT_AMOUNT_DISPLAY
    && tokenIds.includes(1)
    && options.disputeConfig === undefined;
  const hasRuntimeEnv = await hasExportedRuntimeEnv(page);
  const hasRuntimeP2P = hasRuntimeEnv ? await hasExportedRuntimeP2P(page) : false;
  if (!hasRuntimeEnv || !hasRuntimeP2P) {
    if (!canUseDefaultUiConnect) {
      throw new Error(`prod/runtime-global-free connect only supports default hub connect for ${hubId.slice(0, 10)}`);
    }
    if (await hasRenderedCommittedAccountCard(page, hubId)) return;
    await connectHubThroughUi(page, hubId);
    await expect.poll(
      async () => await hasRenderedCommittedAccountCard(page, hubId),
      {
        timeout: DEFAULT_OPEN_TIMEOUT_MS,
        intervals: [250, 500, 750],
        message: `rendered account ${hubId.slice(0, 10)} must commit after hub connect`,
      },
    ).toBe(true);
    return;
  }
  const initiallyLocalReady = await isAccountReady(page, identity.entityId, identity.signerId, hubId, tokenIds);
  if (initiallyLocalReady) {
    const hubStatus = await readHubAccountStatus(page, identity.entityId, hubId, tokenIds);
    const hubTokens = Array.isArray(hubStatus.tokens) ? hubStatus.tokens : [];
    const hubReady = Boolean(
      hubStatus.success &&
      hubStatus.hasAccount &&
      hubStatus.ready &&
      tokenIds.every(tokenId => {
        const token = hubTokens.find(entry => Number(entry.tokenId) === Number(tokenId));
        return Boolean(token?.hasDelta) && BigInt(String(token?.hubOutCapacity || '0')) > 0n;
      }),
    );
    if (hubReady) {
      await waitForRenderedCommittedAccountCard(page, hubId, 'connectRuntimeToHub already-ready path');
      return;
    }
  }
  const initialStatus = await getAccountOpenStatus(page, identity.entityId, identity.signerId, hubId);
  if (initialStatus.exists && initialStatus.currentHeight > 0) {
    await assertNoLocalHubDivergence(page, identity, hubId, tokenIds, 'connectRuntimeToHub');
    const hubBaseStatus = await readHubAccountStatus(page, identity.entityId, hubId, [1]);
    if (!hubBaseStatus.hasAccount || !hubBaseStatus.ready) {
      await waitForHubBaseAccountReady(page, identity, hubId, 'connectRuntimeToHub');
    }
  }

  if (!initialStatus.exists || (initialStatus.currentHeight === 0 && !initialStatus.pendingHeight)) {
    if (canUseDefaultUiConnect) {
      await connectHubThroughUi(page, hubId);
    } else {
      await enqueueOpenAccount(page, identity.entityId, identity.signerId, hubId, options.disputeConfig);
    }
  }

  let reopenAttempted = false;
  let lastStatus: AccountOpenStatus | null = null;
  try {
    await expect.poll(
      async () => {
        await nudgeRuntimeOnline(page);
        const status = await getAccountOpenStatus(page, identity.entityId, identity.signerId, hubId);
        lastStatus = status;
        if (
          status.exists
          && status.currentHeight === 0
          && !status.pendingHeight
          && !reopenAttempted
        ) {
          reopenAttempted = true;
          if (canUseDefaultUiConnect) {
            await connectHubThroughUi(page, hubId);
          } else {
            await enqueueOpenAccount(page, identity.entityId, identity.signerId, hubId, options.disputeConfig);
          }
          return false;
        }
        return status.exists && status.currentHeight > 0 && !status.pendingHeight;
      },
      {
        timeout: DEFAULT_OPEN_TIMEOUT_MS,
        intervals: [250, 500, 750],
        message: `account ${hubId.slice(0, 10)} must be committed after hub connect`,
      },
    ).toBe(true);
  } catch (error) {
    const debugState = await readLocalConnectRuntimeDiagnostic(page, hubId).catch(debugError => ({
      debugError: debugError instanceof Error ? debugError.message : String(debugError),
    }));
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
      `lastStatus=${stringifyDebug(lastStatus)}\n` +
      `connectDebug=${stringifyDebug(debugState)}`,
    );
  }

  for (const tokenId of tokenIds) {
    await extendCreditToken(page, identity, hubId, tokenId, creditAmountDisplay);
  }

  const opened = await isAccountReady(page, identity.entityId, identity.signerId, hubId, tokenIds, DEFAULT_OPEN_TIMEOUT_MS);
  const finalStatus = await getAccountOpenStatus(page, identity.entityId, identity.signerId, hubId);

  expect(
    opened,
    `account open must converge for ${hubId.slice(0, 10)} ` +
      `(exists=${finalStatus.exists} hasDelta=${finalStatus.hasDelta} height=${finalStatus.currentHeight} pending=${finalStatus.pendingHeight})`,
  ).toBe(true);

  await waitForHubAccountReady(page, identity.entityId, hubId, tokenIds);
  await waitForRenderedCommittedAccountCard(page, hubId, 'connectRuntimeToHub final UI path');
}

/**
 * Admission quotes against the sender Runtime's gossip, not relay debug.
 * Register+faucet is incomplete until every hop has exactly one profile and
 * every user hop advertises the Hub account (receive-ready).
 */
export async function waitForReceiveReadyGossipProfiles(
  page: Page,
  entityIds: readonly string[],
  hubEntityId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const targets = entityIds.map(id => id.toLowerCase());
  const hub = hubEntityId.toLowerCase();
  let lastMissing = 'unpolled';
  try {
    await expect
      .poll(
        async () => page.evaluate(async ({ targets, hub }) => {
          const debug = (
            window as Window & {
              __xln?: { env(): RuntimeReplica | null; xln(): Promise<XLNModule> };
            }
          ).__xln;
          const env = debug?.env();
          if (!debug || !env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
          const xln = await debug.xln();
          await xln.ensureGossipProfiles(env, targets);
          const profiles = env.gossip.getProfiles();
          const byId = new Map<string, (typeof profiles)[number]>();
          for (const profile of profiles) {
            const id = String(profile?.entityId || '').toLowerCase();
            if (id) byId.set(id, profile);
          }
          const missing: string[] = [];
          for (const id of targets) {
            const profile = byId.get(id);
            if (!profile) {
              missing.push(`${id.slice(0, 10)}:absent`);
              continue;
            }
            if (id === hub) continue;
            const accounts = Array.isArray(profile.accounts) ? profile.accounts : [];
            const hasHub = accounts.some(account =>
              String(account?.counterpartyId || '').toLowerCase() === hub,
            );
            if (!hasHub) missing.push(`${id.slice(0, 10)}:no-hub-account`);
          }
          return missing.length === 0 ? 'ready' : missing.join(',');
        }, { targets, hub }).then((state) => {
          lastMissing = String(state);
          return state;
        }),
        {
          timeout: timeoutMs,
          intervals: [200, 400, 800],
          message: `gossip must contain receive-ready profiles for ${targets.map(id => id.slice(0, 10)).join(',')}`,
        },
      )
      .toBe('ready');
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
      `missingReceiveReady=${lastMissing}`,
    );
  }
}

export async function connectHub(
  page: Page,
  hubId: string,
  options: ConnectRuntimeOptions = {},
): Promise<void> {
  await ensureRuntimeOnline(page, 'connect-hub');
  const identity = await readSelectedUiRuntimeIdentity(page);
  await connectRuntimeToHub(page, identity, hubId, options);
}
