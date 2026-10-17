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

async function ensureRuntimeOnline(page: Page, tag: string): Promise<void> {
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

async function openWorkspaceTab(page: Page, tabTestId: string): Promise<void> {
  await openAccountsWorkspace(page);
  const tabs = page.getByTestId(tabTestId);
  const readTabStatus = async (): Promise<'visible' | 'active-hidden' | 'missing'> => {
    const count = await tabs.count();
    for (let index = 0; index < count; index += 1) {
      const tab = tabs.nth(index);
      if (await tab.isVisible().catch(() => false)) return 'visible';
      const [className, ariaSelected, dataState, ariaCurrent] = await Promise.all([
        tab.getAttribute('class').catch(() => ''),
        tab.getAttribute('aria-selected').catch(() => ''),
        tab.getAttribute('data-state').catch(() => ''),
        tab.getAttribute('aria-current').catch(() => ''),
      ]);
      const active = /\bactive\b/.test(String(className || ''))
        || ariaSelected === 'true'
        || dataState === 'active'
        || ariaCurrent === 'page';
      if (active) return 'active-hidden';
    }
    return 'missing';
  };

  await expect
    .poll(readTabStatus, {
      timeout: 20_000,
      intervals: [200, 400, 800],
      message: `${tabTestId} workspace tab must be visible or already active`,
    })
    .not.toBe('missing');

  const count = await tabs.count();
  for (let index = 0; index < count; index += 1) {
    const tab = tabs.nth(index);
    if (!await tab.isVisible().catch(() => false)) continue;
    await tab.scrollIntoViewIfNeeded();
    await tab.click({ timeout: 5_000 });
    return;
  }
  // Responsive screenshot layouts can hide the already-active tab. In that case the requested workspace is open.
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
  return page.evaluate(({ hubId }) => {
    const view = window as typeof window & {
      __xln?: {
        runtimeConnectivity?: {
          connected?: boolean;
          directPeers?: unknown;
          queue?: unknown;
        };
      };
      isolatedEnv?: {
        state?: {
          height?: number;
          timestamp?: number;
          jReplicas?: Map<string, {
            blockNumber?: bigint;
            chainId?: number;
            depositoryAddress?: string;
          }>;
          eReplicas?: Map<string, {
            entityId?: string;
            signerId?: string;
            isProposer?: boolean;
            mempool?: Array<{ type?: string; data?: unknown }>;
            proposal?: { height?: number; txs?: Array<{ type?: string }> };
            jHistory?: {
              scannedThroughHeight?: number;
              contiguousThroughHeight?: number;
              eventBlocks?: Map<number, { events?: Array<{ type?: string }> }>;
              blockHashes?: Map<number, string>;
            };
            jPrefixRound?: {
              targetEntityHeight?: number;
              attestations?: Map<string, unknown>;
              certificate?: { selected?: { scannedThroughHeight?: number } };
            };
            state?: {
              entityId?: string;
              height?: number;
              lastFinalizedJHeight?: number;
              jHistoryFinality?: { scannedThroughHeight?: number; eventHistoryRoot?: string };
              config?: {
                threshold?: bigint;
                validators?: string[];
                shares?: Record<string, bigint>;
                jurisdiction?: { name?: string; chainId?: number };
              };
              messages?: string[];
              proposals?: Map<string, { status?: string; action?: { type?: string } }>;
              accounts?: Map<string, {
                currentHeight?: number;
                pendingFrame?: { height?: number };
                mempool?: Array<{ type?: string }>;
                deltas?: Map<number, unknown>;
              }>;
            };
          }>;
        };
        runtimeId?: string;
        infrastructure?: {
          halted?: boolean;
          fatalDebugPayload?: unknown;
          loopActive?: boolean;
        };
        runtimeInput?: { entityInputs?: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }> };
        runtimeMempool?: { entityInputs?: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }> };
        history?: Array<{
          height?: number;
          runtimeInput?: {
            runtimeTxs?: Array<{ type?: string; data?: Record<string, unknown> }>;
            entityInputs?: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }>;
          };
        }>;
      };
    };
    const env = view.isolatedEnv;
    const summarizeInputs = (inputs: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }> | undefined) =>
      (inputs || []).slice(-10).map((input) => ({
        entityId: String(input.entityId || '').slice(-8),
        txs: (input.entityTxs || []).map((tx) => String(tx?.type || '')),
      }));
    const normalize = (value: unknown): string => String(value || '').trim().toLowerCase();
    const targetHub = normalize(hubId);
    const replicas = Array.from(env?.state?.eReplicas?.entries?.() || []).map(([key, replica]) => {
      const account = replica.state?.accounts instanceof Map
        ? replica.state.accounts.get(targetHub) ?? null
        : null;
      return {
        key,
        entityId: replica.state?.entityId ?? replica.entityId ?? null,
        signerId: replica.signerId ?? null,
        stateHeight: Number(replica.state?.height || 0),
        config: replica.state?.config ? {
          threshold: String(replica.state.config.threshold ?? ''),
          validators: replica.state.config.validators ?? [],
          shares: Object.fromEntries(Object.entries(replica.state.config.shares || {}).map(([id, shares]) => [id, String(shares)])),
          jurisdiction: replica.state.config.jurisdiction ?? null,
        } : null,
        isProposer: Boolean(replica.isProposer),
        mempool: (replica.mempool || []).map((tx) => String(tx?.type || '')),
        proposal: replica.proposal ? {
          height: Number(replica.proposal.height || 0),
          txs: (replica.proposal.txs || []).map((tx) => String(tx?.type || '')),
        } : null,
        jHistory: replica.jHistory ? {
          scannedThroughHeight: Number(replica.jHistory.scannedThroughHeight || 0),
          contiguousThroughHeight: Number(replica.jHistory.contiguousThroughHeight || 0),
          eventBlockCount: replica.jHistory.eventBlocks instanceof Map ? replica.jHistory.eventBlocks.size : 0,
          eventBlocks: replica.jHistory.eventBlocks instanceof Map
            ? Array.from(replica.jHistory.eventBlocks.entries()).slice(-10).map(([height, block]) => ({
                height,
                events: (block.events || []).map((event) => String(event?.type || '')),
              }))
            : [],
          blockHashCount: replica.jHistory.blockHashes instanceof Map ? replica.jHistory.blockHashes.size : 0,
          firstBlockHashHeight: replica.jHistory.blockHashes instanceof Map
            ? Number(replica.jHistory.blockHashes.keys().next().value || 0)
            : 0,
        } : null,
        jPrefixRound: replica.jPrefixRound ? {
          targetEntityHeight: Number(replica.jPrefixRound.targetEntityHeight || 0),
          attestationCount: replica.jPrefixRound.attestations instanceof Map
            ? replica.jPrefixRound.attestations.size
            : 0,
          certifiedThroughHeight: Number(replica.jPrefixRound.certificate?.selected?.scannedThroughHeight || 0),
        } : null,
        lastFinalizedJHeight: Number(replica.state?.lastFinalizedJHeight || 0),
        jHistoryFinality: replica.state?.jHistoryFinality ? {
          scannedThroughHeight: Number(replica.state.jHistoryFinality.scannedThroughHeight || 0),
          eventHistoryRoot: replica.state.jHistoryFinality.eventHistoryRoot ?? null,
        } : null,
        messages: (replica.state?.messages || []).slice(-10),
        accountIds: replica.state?.accounts instanceof Map
          ? Array.from(replica.state.accounts.keys())
          : [],
        proposals: replica.state?.proposals instanceof Map
          ? Array.from(replica.state.proposals.entries()).slice(-10).map(([id, proposal]) => ({
              id,
              status: proposal?.status ?? null,
              actionType: proposal?.action?.type ?? null,
            }))
          : [],
        hubAccount: account ? {
          currentHeight: Number(account.currentHeight || 0),
          pendingFrameHeight: account.pendingFrame ? Number(account.pendingFrame.height || 0) : null,
          mempool: (account.mempool || []).map((tx) => String(tx?.type || '')),
          deltaTokenIds: account.state.deltas instanceof Map ? Array.from(account.state.deltas.keys()).map(Number) : [],
        } : null,
      };
    });
    return {
      height: Number(env?.state?.height || 0),
      timestamp: Number(env?.state?.timestamp || 0),
      runtimeId: env?.runtimeId ?? null,
      uiErrors: Array.from(document.querySelectorAll('.hub-panel .error-banner, [role="alert"], .toast'))
        .map((entry) => String(entry.textContent || '').trim())
        .filter(Boolean)
        .slice(-10),
      runtimeInput: summarizeInputs(env?.runtimeInput?.entityInputs),
      runtimeMempool: summarizeInputs(env?.runtimeMempool?.entityInputs),
      recentFrames: (env?.history || []).slice(-100).map((frame) => ({
        height: Number(frame.height || 0),
        runtimeTxs: (frame.runtimeInput?.runtimeTxs || []).map((tx) => {
          const type = String(tx?.type || '');
          if (type !== 'observeJRange') return { type };
          const headers = Array.isArray(tx.data?.headers)
            ? tx.data.headers as Array<{ jHeight?: number }>
            : [];
          return {
            type,
            entityId: String(tx.data?.entityId || '').slice(-8),
            signerId: String(tx.data?.signerId || '').slice(-8),
            jurisdictionRef: String(tx.data?.jurisdictionRef || ''),
            scannedThroughHeight: Number(tx.data?.scannedThroughHeight || 0),
            headerCount: headers.length,
            firstHeader: Number(headers[0]?.jHeight || 0),
            lastHeader: Number(headers.at(-1)?.jHeight || 0),
          };
        }),
        entityInputs: summarizeInputs(frame.runtimeInput?.entityInputs),
      })),
      jurisdictions: Array.from(env?.state?.jReplicas?.entries?.() || []).map(([name, replica]) => ({
        name,
        blockNumber: String(replica.blockNumber ?? ''),
        chainId: Number(replica.chainId ?? 0),
        depositoryAddress: replica.contracts?.depository ?? null,
      })),
      replicas,
    };
  }, { hubId });
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

async function waitForPublicHubRuntimeProfile(page: Page, hubId: string, timeoutMs = 20_000): Promise<void> {
  let lastProfileState: unknown = null;
  try {
    await expect
      .poll(
        async () => {
          const origin = new URL(page.url()).origin;
          const url = new URL('/api/gossip/profile', origin);
          url.searchParams.set('entityId', hubId);
          const response = await page.request.get(url.toString()).catch((error) => ({
            ok: () => false,
            status: () => 0,
            json: async () => ({ error: error instanceof Error ? error.message : String(error) }),
          }));
          const body = await response.json().catch(() => ({} as {
            found?: boolean;
            profile?: { entityId?: string; runtimeId?: string; metadata?: { runtimeId?: string } } | null;
            error?: string;
          }));
          const profile = body.profile;
          const entityMatches = String(profile?.entityId || '').toLowerCase() === hubId.toLowerCase();
          const runtimeId = String(profile?.runtimeId || profile?.metadata?.runtimeId || '').trim();
          lastProfileState = {
            status: response.status(),
            found: body.found,
            entityMatches,
            runtimeId,
            error: body.error,
          };
          return response.ok() && body.found !== false && entityMatches && runtimeId.length > 0;
        },
        {
          timeout: timeoutMs,
          intervals: [250, 500, 1000],
          message: `hub ${hubId.slice(0, 10)} must be discoverable through public gossip profile API before UI connect`,
        },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
      `lastPublicHubProfileState=${stringifyDebug(lastProfileState)}`,
    );
  }
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

async function selectConfigureAccount(page: Page, hubId: string): Promise<void> {
  const selector = page.getByTestId('configure-account-selector').first();
  await expect(selector).toBeVisible({ timeout: 20_000 });
  const optionTestId = `configure-account-selector-option-${hubId.toLowerCase()}`;

  const closedTrigger = selector.locator('.closed-trigger').first();
  if (await closedTrigger.isVisible().catch(() => false)) {
    if (await closedTrigger.textContent().then((text) => String(text || '').toLowerCase().includes(hubId.toLowerCase().slice(0, 10))).catch(() => false)) {
      return;
    }
    await closedTrigger.click();
  }

  const input = selector.locator('input').first();
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.click();
  await input.fill(hubId);
  const option = page.getByTestId(optionTestId).first();
  if (await option.isVisible().catch(() => false)) {
    await option.dispatchEvent('mousedown');
  } else {
    const matchedOption = page.locator('.dropdown-item').filter({ hasText: hubId }).first();
    await expect(matchedOption).toBeVisible({ timeout: 20_000 });
    await matchedOption.dispatchEvent('mousedown');
  }
  await expect(selector.locator('.closed-trigger').first()).toContainText(hubId.slice(0, 10), { timeout: 20_000 });
}

async function openConfigureWorkspace(page: Page, hubId: string): Promise<void> {
  await openWorkspaceTab(page, 'account-workspace-tab-configure');
  await expect(page.locator('.configure-panel').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.configure-empty').first()).not.toBeVisible({ timeout: 20_000 });
  await selectConfigureAccount(page, hubId);
}

async function addTokenToAccount(page: Page, hubId: string, tokenId: number): Promise<void> {
  await openConfigureWorkspace(page, hubId);
  const tokenTab = page.getByTestId('configure-tab-token').first();
  await expect(tokenTab).toBeVisible({ timeout: 20_000 });
  await tokenTab.click();
  const tokenSelect = page.locator('.configure-token-select').first();
  await expect(tokenSelect).toBeVisible({ timeout: 20_000 });
  await tokenSelect.selectOption(String(tokenId));
  const addButton = page.getByTestId('configure-token-add').first();
  await expect(addButton).toBeEnabled({ timeout: 20_000 });
  await addButton.click();
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
    readHubAccountStatus(page, identity.entityId, hubId, tokenIds).catch((error) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies HubAccountStatus)),
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
      getAccountOpenStatus(page, identity.entityId, identity.signerId, hubId).catch((statusError) => ({
        error: statusError instanceof Error ? statusError.message : String(statusError),
      })),
      readHubAccountStatus(page, identity.entityId, hubId, [1]).catch((statusError) => ({
        error: statusError instanceof Error ? statusError.message : String(statusError),
      })),
      getConnectDebugState(page, identity, hubId).catch((debugError) => ({
        error: debugError instanceof Error ? debugError.message : String(debugError),
      })),
      readRelayDebugEvents(page, 20).catch((debugError) => ({
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

async function getConnectDebugState(
  page: Page,
  identity: { entityId: string; signerId: string },
  hubId: string,
): Promise<unknown> {
  return page.evaluate(({ identity, hubId }) => {
    const view = window as typeof window & {
      __xln?: {
        runtimeConnectivity?: {
          connected?: boolean;
          directPeers?: unknown;
          queue?: unknown;
        };
      };
      isolatedEnv?: {
        state?: {
          height?: number;
          timestamp?: number;
          eReplicas?: Map<string, {
            state?: {
              messages?: string[];
              accounts?: Map<string, {
                currentHeight?: number;
                pendingFrame?: { height?: number };
                mempool?: Array<{ type?: string }>;
                state?: {
                  leftEntity?: string;
                  rightEntity?: string;
                };
                proofHeader?: { fromEntity?: string; toEntity?: string };
              }>;
            };
          }>;
        };
        runtimeInput?: { entityInputs?: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }> };
        runtimeMempool?: { entityInputs?: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }> };
        gossip?: { getProfiles?: () => Array<{ entityId?: string; runtimeId?: string; metadata?: unknown }> };
      };
    };
    const env = view.isolatedEnv;
    const connectivity = view.__xln?.runtimeConnectivity;
    const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();
    const resolveCounterpartyAccount = (
      accounts: Map<string, {
        currentHeight?: number;
        pendingFrame?: { height?: number };
        mempool?: Array<{ type?: string }>;
        state?: {
          leftEntity?: string;
          rightEntity?: string;
        };
        proofHeader?: { fromEntity?: string; toEntity?: string };
      }>,
      ownerEntityId: string,
      counterpartyEntityId: string,
    ) => {
      const owner = normalizeEntityId(ownerEntityId);
      const target = normalizeEntityId(counterpartyEntityId);
      const accountBelongsToPair = (account: {
        state?: {
          leftEntity?: string;
          rightEntity?: string;
        };
        proofHeader?: { fromEntity?: string; toEntity?: string };
      } | null | undefined): boolean => {
        if (!account) return false;
        const proofFrom = normalizeEntityId(account.proofHeader?.fromEntity);
        const proofTo = normalizeEntityId(account.proofHeader?.toEntity);
        if (proofFrom || proofTo) return proofFrom === owner && proofTo === target;
        const left = normalizeEntityId(account.state?.leftEntity);
        const right = normalizeEntityId(account.state?.rightEntity);
        return (left === owner && right === target) || (left === target && right === owner);
      };
      const direct = accounts.get(target) ?? accounts.get(String(counterpartyEntityId || ''));
      if (accountBelongsToPair(direct)) return direct;
      for (const [accountKey, account] of accounts.entries()) {
        if (normalizeEntityId(accountKey) === target && accountBelongsToPair(account)) return account;
        const left = normalizeEntityId(account.state?.leftEntity);
        const right = normalizeEntityId(account.state?.rightEntity);
        if ((left === owner && right === target) || (right === owner && left === target)) return account;
      }
      return null;
    };
    const replica = env?.state?.eReplicas?.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
    const accounts = replica?.state?.accounts;
    const account = accounts instanceof Map
      ? resolveCounterpartyAccount(accounts, identity.entityId, hubId)
      : null;
    const profile = env?.gossip?.getProfiles?.().find((candidate) =>
      String(candidate?.entityId || '').toLowerCase() === String(hubId || '').toLowerCase(),
    );
    const summarizeInputs = (inputs: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }> | undefined) =>
      (inputs || []).slice(-10).map((input) => ({
        entityId: String(input.entityId || '').slice(-8),
        txs: (input.entityTxs || []).map((tx) => tx.type),
      }));
    return {
      height: env?.state?.height,
      timestamp: env?.state?.timestamp,
      p2p: {
        connected: connectivity?.connected ?? null,
        directPeers: connectivity?.directPeers ?? null,
        queue: connectivity?.queue ?? null,
      },
      account: account ? {
        currentHeight: Number(account.currentHeight || 0),
        pendingHeight: account.pendingFrame ? Number(account.pendingFrame.height || 0) : null,
        mempool: (account.mempool || []).map((tx) => tx.type),
        leftEntity: String(account.state?.leftEntity || ''),
        rightEntity: String(account.state?.rightEntity || ''),
        proofFrom: String(account.proofHeader?.fromEntity || ''),
        proofTo: String(account.proofHeader?.toEntity || ''),
      } : null,
      runtimeInput: summarizeInputs(env?.runtimeInput?.entityInputs),
      runtimeMempool: summarizeInputs(env?.runtimeMempool?.entityInputs),
      hubProfile: profile ? {
        runtimeId: String(profile.runtimeId || ''),
        metadata: profile.metadata,
      } : null,
      recentMessages: (replica?.state?.messages || []).slice(-8),
    };
  }, { identity, hubId });
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
    const debugState = await getConnectDebugState(page, identity, hubId).catch((debugError) => ({
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
