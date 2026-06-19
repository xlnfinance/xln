import { expect, type Page } from '@playwright/test';
import { enqueueEntityTxs } from './e2e-runtime-input';

const DEFAULT_TOKEN_IDS = [1] as const;
const DEFAULT_OPEN_TIMEOUT_MS = 75_000;
const DEFAULT_CREDIT_AMOUNT_DISPLAY = '10000';

type ConnectRuntimeOptions = {
  requireOnline?: boolean;
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

async function ensureRuntimeOnline(page: Page, tag: string): Promise<void> {
  const ok = await page.evaluate(async () => {
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

    const startedAt = Date.now();
    while (Date.now() - startedAt < 20_000) {
      if (typeof p2p.isConnected === 'function' && p2p.isConnected()) return true;
      if (typeof p2p.connect === 'function') {
        try { p2p.connect(); } catch {}
      } else if (typeof p2p.reconnect === 'function') {
        try { p2p.reconnect(); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return typeof p2p.isConnected === 'function' && p2p.isConnected();
  });

  expect(ok, `[${tag}] runtime must be online`).toBe(true);
}

async function nudgeRuntimeOnline(page: Page): Promise<void> {
  await page.evaluate(() => {
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
    if (!p2p || (typeof p2p.isConnected === 'function' && p2p.isConnected())) return;
    if (typeof p2p.connect === 'function') {
      try { p2p.connect(); } catch {}
      return;
    }
    if (typeof p2p.reconnect === 'function') {
      try { p2p.reconnect(); } catch {}
    }
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Execution context was destroyed')) return;
    throw error;
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
      const env = (window as typeof window & {
        isolatedEnv?: {
          eReplicas?: Map<string, {
            state?: {
              accounts?: Map<string, {
                deltas?: Map<number, unknown>;
                pendingFrame?: unknown;
                currentHeight?: number;
              }>;
            };
          }>;
        };
      }).isolatedEnv;
      if (!env?.eReplicas) return false;

      const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();
      const resolveCounterpartyAccount = (
        accounts: Map<string, {
          deltas?: Map<number, unknown>;
          pendingFrame?: unknown;
          currentHeight?: number;
          currentFrame?: { height?: number };
          leftEntity?: string;
          rightEntity?: string;
          counterpartyEntityId?: string;
          proofHeader?: { fromEntity?: string; toEntity?: string };
        }>,
        ownerEntityId: string,
        counterpartyEntityId: string,
      ) => {
        const owner = normalizeEntityId(ownerEntityId);
        const target = normalizeEntityId(counterpartyEntityId);
        const accountBelongsToPair = (account: {
          leftEntity?: string;
          rightEntity?: string;
          counterpartyEntityId?: string;
          proofHeader?: { fromEntity?: string; toEntity?: string };
        } | null | undefined): boolean => {
          if (!account) return false;
          const proofFrom = normalizeEntityId(account.proofHeader?.fromEntity);
          const proofTo = normalizeEntityId(account.proofHeader?.toEntity);
          if (proofFrom || proofTo) return proofFrom === owner && proofTo === target;
          const left = normalizeEntityId(account.leftEntity);
          const right = normalizeEntityId(account.rightEntity);
          if (left && right) {
            return (left === owner && right === target) || (left === target && right === owner);
          }
          const counterparty = normalizeEntityId(account.counterpartyEntityId);
          return !counterparty || counterparty === target;
        };
        const direct = accounts.get(target) ?? accounts.get(String(counterpartyEntityId || ''));
        if (accountBelongsToPair(direct)) return direct;
        for (const [accountKey, account] of accounts.entries()) {
          if (normalizeEntityId(accountKey) === target && accountBelongsToPair(account)) return account;
          const left = normalizeEntityId(account.leftEntity);
          const right = normalizeEntityId(account.rightEntity);
          if ((left === owner && right === target) || (right === owner && left === target)) return account;
          if (accountBelongsToPair(account)) return account;
        }
        return null;
      };

      const startedAt = Date.now();
	      while (Date.now() - startedAt <= timeoutMs) {
	        for (const [replicaKey, replica] of env.eReplicas.entries()) {
	          const [replicaEntityId, replicaSignerId] = String(replicaKey).split(':');
	          if (String(replicaEntityId || '').toLowerCase() !== String(entityId || '').toLowerCase()) continue;
	          if (String(replicaSignerId || '').toLowerCase() !== String(signerId || '').toLowerCase()) continue;
	          const accounts = replica.state?.accounts;
	          const account = accounts instanceof Map
	            ? resolveCounterpartyAccount(accounts, entityId, hubId)
	            : null;
	          if (!account) continue;
	          const hasDelta = tokenIds.every((tokenId) => {
	            if (!(account.deltas instanceof Map)) return false;
	            for (const [deltaTokenId] of account.deltas.entries()) {
	              if (Number(deltaTokenId) === tokenId) return true;
	            }
	            return false;
	          });
	          const noPending = !account.pendingFrame;
	          const hasFrame = Number(account.currentHeight || 0) > 0;
	          if (hasDelta && noPending && hasFrame) return true;
	        }
        if (timeoutMs <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      return false;
    },
    { entityId, signerId, hubId, tokenIds: [...tokenIds], timeoutMs },
  );
}

async function dismissOnboardingIfVisible(page: Page): Promise<void> {
  const onboarding = page.locator('.onboarding').first();
  if (!await onboarding.isVisible().catch(() => false)) return;
  const startUsingButton = onboarding.getByRole('button', { name: /Start( using xln)?|Continue/i }).first();

  const setupError = onboarding.locator('.error-msg').first();
  const readSetupError = async (): Promise<string> => {
    if (!await setupError.isVisible().catch(() => false)) return '';
    return String(await setupError.innerText({ timeout: 1_000 }).catch(() => '')).trim();
  };
  const waitForSetupToFinish = async (context: string): Promise<void> => {
    const deadline = Date.now() + DEFAULT_OPEN_TIMEOUT_MS;
    let lastText = '';
    while (Date.now() < deadline) {
      if (!await onboarding.isVisible().catch(() => false)) return;
      const errorText = await readSetupError();
      if (errorText) throw new Error(`${context}: ${errorText}`);
      lastText = String(await onboarding.innerText({ timeout: 1_000 }).catch(() => '')).replace(/\s+/g, ' ').slice(0, 500);
      await page.waitForTimeout(500);
    }
    throw new Error(`${context}: onboarding did not complete. Last visible state: ${lastText || 'empty'}`);
  };

  const initialError = await readSetupError();
  if (initialError) {
    throw new Error(`onboarding setup failed before workspace open: ${initialError}`);
  }
  if (!await startUsingButton.isVisible().catch(() => false)) {
    await waitForSetupToFinish('onboarding setup already in progress');
    return;
  }

  const riskCheckbox = page.getByRole('checkbox', {
    name: /I understand.*testnet software|I understand and accept the risks/i,
  }).first();
  if (await riskCheckbox.isVisible().catch(() => false)) {
    const checked = await riskCheckbox.isChecked().catch(() => false);
    if (!checked) await riskCheckbox.check({ timeout: 2000 }).catch(() => null);
  }

  await startUsingButton.click({ force: true, timeout: 5_000 }).catch(() => null);
  await page.evaluate(() => {
    const start = Array.from(document.querySelectorAll('button'))
      .find((button) => /^Start$/i.test(String(button.textContent || '').trim()));
    start?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }).catch(() => null);

  const postClickError = await readSetupError();
  if (postClickError) {
    throw new Error(`onboarding setup failed after Start: ${postClickError}`);
  }
  await waitForSetupToFinish('onboarding setup after Start');
}

async function openAccountsWorkspace(page: Page): Promise<void> {
  await dismissOnboardingIfVisible(page);
  const accountsTab = page.getByTestId('tab-accounts').first();
  const accountList = page.getByTestId('account-list-wrapper').first();
  const workspaceTabs = page.locator('nav[aria-label="Account workspace"]').first();
  const activeWalletGate = page.getByRole('heading', { name: /XLN wallet available/i }).first();
  const isAccountsWorkspaceVisible = async () =>
    await accountList.isVisible().catch(() => false)
      || await workspaceTabs.isVisible().catch(() => false);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await dismissOnboardingIfVisible(page);
    if (await isAccountsWorkspaceVisible()) break;
    if (await activeWalletGate.isVisible().catch(() => false)) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(500);
      await dismissOnboardingIfVisible(page);
      continue;
    }
    if (await accountsTab.isVisible().catch(() => false)) {
      await accountsTab.click({ timeout: 5_000 });
      await page.waitForTimeout(300);
      continue;
    }
  }

  await dismissOnboardingIfVisible(page);
  await expect
    .poll(async () => {
      await dismissOnboardingIfVisible(page);
      return await isAccountsWorkspaceVisible();
    }, {
      timeout: 20_000,
      intervals: [200, 400, 800],
      message: 'accounts workspace must be visible',
    })
    .toBe(true);
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

function compactEntityLabel(entityId: string): string {
  return `${entityId.slice(0, 10)}...${entityId.slice(-6)}`;
}

async function resolveHubCardLabel(page: Page, hubId: string): Promise<string> {
  const resolved = await page.evaluate((targetHubId) => {
    const view = window as typeof window & {
      isolatedEnv?: {
        gossip?: {
          getProfiles?: () => Array<{ entityId?: string; metadata?: { name?: string }; name?: string }>;
        };
      };
    };
    const profiles = view.isolatedEnv?.gossip?.getProfiles?.() || [];
    const match = profiles.find((profile) => String(profile?.entityId || '').toLowerCase() === String(targetHubId || '').toLowerCase());
    return String(match?.metadata?.name || match?.name || '').trim();
  }, hubId);
  return resolved || compactEntityLabel(hubId);
}

async function resolveHubCardLocator(page: Page, hubId: string, root = page.locator('body')) {
  const hubIdNorm = hubId.toLowerCase();
  const exactHubCard = root.locator(`.hub-card[data-hub-entity-id="${hubIdNorm}"]`).first();
  if (await exactHubCard.isVisible().catch(() => false)) return exactHubCard;

  const hubCardLabel = await resolveHubCardLabel(page, hubId);
  return root.locator('.hub-card').filter({ hasText: hubCardLabel }).first();
}

async function ensureHubCardVisible(page: Page, hubId: string): Promise<void> {
  await openWorkspaceTab(page, 'account-workspace-tab-open');
  const panel = page.locator('.hub-panel').first();
  await expect(panel).toBeVisible({ timeout: 20_000 });
  const refresh = panel.getByRole('button', { name: /^Refresh$/ }).first();
  const detailsButtons = panel.locator('.expand-toggle');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const hubCard = await resolveHubCardLocator(page, hubId, panel);
    if (await hubCard.isVisible().catch(() => false)) return;
    const count = await detailsButtons.count();
    for (let index = 0; index < count; index += 1) {
      const button = detailsButtons.nth(index);
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 2_000 }).catch(() => {});
      }
    }
    if (await hubCard.isVisible().catch(() => false)) return;
    await expect(refresh).toBeVisible({ timeout: 10_000 });
    if (await refresh.isEnabled().catch(() => false)) {
      await refresh.click({ timeout: 5_000 });
    }
    await page.waitForTimeout(1_000);
  }

  const hubCard = await resolveHubCardLocator(page, hubId, panel);
  await expect(hubCard, `hub ${hubId} must appear in hub discovery`).toBeVisible({ timeout: 20_000 });
}

async function connectHubThroughUi(page: Page, hubId: string): Promise<void> {
  await ensureHubCardVisible(page, hubId);
  if (await hasRenderedCommittedAccountCard(page, hubId)) return;
  if (await hasExportedRuntimeP2P(page)) {
    await waitForHubRuntimeTransportReady(page, hubId);
  } else {
    await waitForPublicHubRuntimeProfile(page, hubId);
  }
  if (await hasRenderedCommittedAccountCard(page, hubId)) return;

  let lastUiState = 'not-read';
  try {
    await expect
      .poll(
        async () => {
          if (await hasRenderedCommittedAccountCard(page, hubId)) {
            lastUiState = 'committed-account-card';
            return true;
          }

          const panel = page.locator('.hub-panel').first();
          if (!await panel.isVisible().catch(() => false)) {
            lastUiState = 'hub-panel-missing';
            return false;
          }

          const hubCard = await resolveHubCardLocator(page, hubId, panel);
          if (!await hubCard.isVisible().catch(() => false)) {
            lastUiState = 'hub-card-missing';
            return false;
          }

          const dataState = String(await hubCard.getAttribute('data-connection-state').catch(() => '') || '').toLowerCase();
          if (dataState === 'open') {
            lastUiState = 'open-awaiting-committed-card';
            return false;
          }
          if (dataState === 'opening') {
            lastUiState = 'opening-awaiting-committed-card';
            return false;
          }

          const openState = hubCard.locator('.connection-state').filter({ hasText: /^Open$/i }).first();
          if (await openState.isVisible().catch(() => false)) {
            lastUiState = 'open-legacy-awaiting-committed-card';
            return false;
          }

          const openingState = hubCard.locator('.connection-state').filter({ hasText: /^Opening$/i }).first();
          if (await openingState.isVisible().catch(() => false)) {
            lastUiState = 'opening-legacy-awaiting-committed-card';
            return false;
          }

          const connectByTestId = hubCard.getByTestId('hub-connect-button').first();
          const connectButton = await connectByTestId.isVisible().catch(() => false)
            ? connectByTestId
            : hubCard.getByRole('button', { name: /Connect/i }).first();
          if (
            await connectButton.isVisible().catch(() => false)
            && await connectButton.isEnabled().catch(() => false)
          ) {
            await connectButton.click({ timeout: 5_000 });
            lastUiState = 'connect-clicked';
            return false;
          }

          const text = await hubCard.innerText({ timeout: 1_000 }).catch(() => '');
          lastUiState = `state=${dataState || 'unknown'} text=${text.replace(/\s+/g, ' ').slice(0, 180)}`;
          return false;
        },
        {
          timeout: DEFAULT_OPEN_TIMEOUT_MS,
          intervals: [100, 250, 500],
          message: `hub ${hubId} must render a committed account card after Connect`,
        },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
      `lastHubConnectUiState=${lastUiState}`,
    );
  }
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
  let lastProfileState: unknown = null;
  try {
    await expect
      .poll(
      async () => page.evaluate(async (targetHubId) => {
        const env = (window as typeof window & {
          isolatedEnv?: {
            gossip?: { getProfiles?: () => Array<{ entityId?: string; runtimeId?: string }> };
            runtimeState?: {
              p2p?: {
                isConnected?: () => boolean;
                connect?: () => void;
                reconnect?: () => void;
                ensureProfiles?: (ids: string[]) => Promise<boolean>;
              };
            };
          };
        }).isolatedEnv;
        const target = String(targetHubId || '').toLowerCase();
        const getProfile = () => env?.gossip?.getProfiles?.().find((candidate) =>
          String(candidate?.entityId || '').toLowerCase() === target,
        );
        const profile = getProfile();
        if (String(profile?.runtimeId || '').trim()) return true;

        const p2p = env?.runtimeState?.p2p;
        if (!p2p) {
          return { ok: false, reason: 'missing-p2p', profileCount: env?.gossip?.getProfiles?.().length || 0 };
        }

        const connectedBefore = typeof p2p.isConnected === 'function' ? p2p.isConnected() : null;
        if (!connectedBefore) {
          if (typeof p2p.connect === 'function') {
            try { p2p.connect(); } catch {}
          } else if (typeof p2p.reconnect === 'function') {
            try { p2p.reconnect(); } catch {}
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        const ensureResult = await p2p.ensureProfiles?.([target]).catch((error) =>
          error instanceof Error ? error.message : String(error),
        );
        const refreshedProfile = getProfile();
        return {
          ok: Boolean(String(refreshedProfile?.runtimeId || '').trim()),
          reason: refreshedProfile ? 'profile-without-runtime' : 'missing-profile',
          connectedBefore,
          connectedAfter: typeof p2p.isConnected === 'function' ? p2p.isConnected() : null,
          ensureResult,
          profileCount: env?.gossip?.getProfiles?.().length || 0,
          targetRuntimeId: String(refreshedProfile?.runtimeId || '').trim(),
        };
      }, hubId).then((state) => {
        lastProfileState = state;
        return state === true || Boolean((state as { ok?: boolean } | null)?.ok);
      }),
      {
        timeout: timeoutMs,
        intervals: [100, 250, 500],
        message: `hub ${hubId.slice(0, 10)} must have a gossip runtime route before connect`,
      },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
      `lastHubProfileState=${stringifyDebug(lastProfileState)}`,
    );
  }
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
  let lastStatus: unknown = null;
  try {
    await expect
      .poll(
      async () => page.evaluate(async (targetHubId) => {
        const env = (window as typeof window & {
          isolatedEnv?: {
            gossip?: {
              getProfiles?: () => Array<{ entityId?: string; runtimeId?: string; wsUrl?: string | null }>;
            };
            runtimeState?: {
              p2p?: {
                isConnected?: () => boolean;
                connect?: () => void;
                reconnect?: () => void;
                ensureProfiles?: (ids: string[]) => Promise<boolean>;
                getDirectPeerState?: () => Array<{ runtimeId: string; endpoint: string; open: boolean; lastError?: string; lastErrorAt?: number }>;
                ensureDirectClientForRuntime?: (runtimeId: string) => void;
                syncDirectPeerConnections?: () => void;
              };
            };
          };
        }).isolatedEnv;
        const target = String(targetHubId || '').toLowerCase();
        const p2p = env?.runtimeState?.p2p;
        const profile = env?.gossip?.getProfiles?.().find((candidate) =>
          String(candidate?.entityId || '').toLowerCase() === target,
        );
        const runtimeId = String(profile?.runtimeId || '').trim().toLowerCase();
        if (!p2p || !runtimeId) {
          await p2p?.ensureProfiles?.([target]).catch(() => false);
          return { ok: false, reason: 'missing-profile-or-p2p', runtimeId };
        }

        const relayConnected = typeof p2p.isConnected === 'function' && p2p.isConnected();
        if (!relayConnected) {
          if (typeof p2p.connect === 'function') {
            try { p2p.connect(); } catch {}
          } else if (typeof p2p.reconnect === 'function') {
            try { p2p.reconnect(); } catch {}
          }
        }

        const directEndpoint = String(profile?.wsUrl || '').trim();
        const directAllowed = (() => {
          if (!directEndpoint) return false;
          if (String(window.location?.protocol || '').toLowerCase() !== 'https:') return true;
          try {
            const parsed = new URL(directEndpoint);
            if (parsed.protocol === 'wss:') return true;
            if (parsed.protocol !== 'ws:') return false;
            const host = String(parsed.hostname || '').toLowerCase();
            return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
          } catch {
            return false;
          }
        })();
        if (directAllowed) {
          try { p2p.ensureDirectClientForRuntime?.(runtimeId); } catch {}
          try { p2p.syncDirectPeerConnections?.(); } catch {}
          const directPeers = typeof p2p.getDirectPeerState === 'function'
            ? p2p.getDirectPeerState()
            : [];
          const peer = directPeers.find((entry) => String(entry.runtimeId || '').toLowerCase() === runtimeId);
          return {
            ok: peer?.open === true,
            reason: peer?.open === true ? 'direct-open' : 'direct-not-open',
            runtimeId,
            directEndpoint,
            directAllowed,
            relayConnected,
            directPeers,
          };
        }

        const relayClients = await fetch('/api/clients', { cache: 'no-store' })
          .then((response) => response.ok ? response.json() : null)
          .catch(() => null) as { clients?: string[] } | null;
        const relayTargetConnected = Array.isArray(relayClients?.clients)
          && relayClients.clients.some((clientRuntimeId) => String(clientRuntimeId || '').toLowerCase() === runtimeId);
        return {
          ok: relayConnected && relayTargetConnected,
          reason: relayConnected
            ? relayTargetConnected ? 'relay-target-open' : 'relay-target-not-open'
            : 'relay-not-open',
          runtimeId,
          directEndpoint,
          directAllowed,
          relayConnected,
          relayTargetConnected,
          relayClients: relayClients?.clients || [],
          directPeers: typeof p2p.getDirectPeerState === 'function' ? p2p.getDirectPeerState() : [],
        };
      }, hubId).then((status) => {
        lastStatus = status;
        return Boolean(status.ok);
      }),
      {
        timeout: timeoutMs,
        intervals: [100, 250, 500],
        message: `hub ${hubId.slice(0, 10)} transport route must be open before account tx`,
      },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
      `lastTransportStatus=${stringifyDebug(lastStatus)}`,
    );
  }

  expect(
    Boolean((lastStatus as { ok?: boolean } | null)?.ok),
    `hub transport route not ready: ${stringifyDebug(lastStatus)}`,
  ).toBe(true);
}

async function enqueueOpenAccount(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
): Promise<void> {
  await waitForHubRuntimeTransportReady(page, hubId);
  await enqueueEntityTxs(page, entityId, signerId, [{
    type: 'openAccount',
    data: {
      targetEntityId: hubId,
      creditAmount: 10_000n * 10n ** 18n,
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
    const fallbackOption = page.locator('.dropdown-item').filter({ hasText: hubId }).first();
    await expect(fallbackOption).toBeVisible({ timeout: 20_000 });
    await fallbackOption.dispatchEvent('mousedown');
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
  const amount = BigInt(amountDisplay) * 10n ** 18n;
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
        return await isAccountReady(page, identity.entityId, identity.signerId, hubId, [tokenId], 0);
      },
      {
        timeout: DEFAULT_OPEN_TIMEOUT_MS,
        intervals: [250, 500, 750],
        message: `extendCredit should activate token ${tokenId} for ${hubId.slice(0, 10)}`,
      },
    ).toBe(true);
  } catch (error) {
    const [localStatus, hubStatus, debugState, relayDebug] = await Promise.all([
      getAccountOpenStatus(page, identity.entityId, identity.signerId, hubId).catch((statusError) => ({
        error: statusError instanceof Error ? statusError.message : String(statusError),
      })),
      readHubAccountStatus(page, identity.entityId, hubId, [tokenId]).catch((statusError) => ({
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
      const env = (window as typeof window & {
        isolatedEnv?: {
          eReplicas?: Map<string, {
            state?: {
              accounts?: Map<string, {
                deltas?: Map<number, unknown>;
                pendingFrame?: { height?: number };
                currentHeight?: number;
              }>;
            };
          }>;
        };
      }).isolatedEnv;
      if (!env?.eReplicas) {
        return { exists: false, hasDelta: false, pendingHeight: null, currentHeight: 0 };
      }

      const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();
      const resolveCounterpartyAccount = (
        accounts: Map<string, {
          deltas?: Map<number, unknown>;
          pendingFrame?: { height?: number };
          currentHeight?: number;
          currentFrame?: { height?: number };
          leftEntity?: string;
          rightEntity?: string;
          counterpartyEntityId?: string;
          proofHeader?: { fromEntity?: string; toEntity?: string };
        }>,
        ownerEntityId: string,
        counterpartyEntityId: string,
      ) => {
        const owner = normalizeEntityId(ownerEntityId);
        const target = normalizeEntityId(counterpartyEntityId);
        const accountBelongsToPair = (account: {
          leftEntity?: string;
          rightEntity?: string;
          counterpartyEntityId?: string;
          proofHeader?: { fromEntity?: string; toEntity?: string };
        } | null | undefined): boolean => {
          if (!account) return false;
          const proofFrom = normalizeEntityId(account.proofHeader?.fromEntity);
          const proofTo = normalizeEntityId(account.proofHeader?.toEntity);
          if (proofFrom || proofTo) return proofFrom === owner && proofTo === target;
          const left = normalizeEntityId(account.leftEntity);
          const right = normalizeEntityId(account.rightEntity);
          if (left && right) {
            return (left === owner && right === target) || (left === target && right === owner);
          }
          const counterparty = normalizeEntityId(account.counterpartyEntityId);
          return !counterparty || counterparty === target;
        };
        const direct = accounts.get(target) ?? accounts.get(String(counterpartyEntityId || ''));
        if (accountBelongsToPair(direct)) return direct;
        for (const [accountKey, account] of accounts.entries()) {
          if (normalizeEntityId(accountKey) === target && accountBelongsToPair(account)) return account;
          const left = normalizeEntityId(account.leftEntity);
          const right = normalizeEntityId(account.rightEntity);
          if ((left === owner && right === target) || (right === owner && left === target)) return account;
          if (accountBelongsToPair(account)) return account;
        }
        return null;
      };

      for (const [replicaKey, replica] of env.eReplicas.entries()) {
        const [replicaEntityId, replicaSignerId] = String(replicaKey).split(':');
        if (String(replicaEntityId || '').toLowerCase() !== String(entityId || '').toLowerCase()) continue;
        if (String(replicaSignerId || '').toLowerCase() !== String(signerId || '').toLowerCase()) continue;
	        const accounts = replica.state?.accounts;
	        const account = accounts instanceof Map
	          ? resolveCounterpartyAccount(accounts, entityId, hubId)
	          : null;
	        if (!account) continue;
	        const hasTokenOneDelta = (() => {
	          if (!(account.deltas instanceof Map)) return false;
	          for (const [deltaTokenId] of account.deltas.entries()) {
	            if (Number(deltaTokenId) === 1) return true;
	          }
	          return false;
	        })();
	        return {
	          exists: true,
	          hasDelta: hasTokenOneDelta,
	          pendingHeight: account.pendingFrame ? Number(account.pendingFrame.height || 0) : null,
	          currentHeight: Number(account.currentHeight || 0),
	        };
      }

      return { exists: false, hasDelta: false, pendingHeight: null, currentHeight: 0 };
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
    const env = (window as typeof window & {
      isolatedEnv?: {
        height?: number;
        timestamp?: number;
        runtimeInput?: { entityInputs?: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }> };
        runtimeMempool?: { entityInputs?: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }> };
        eReplicas?: Map<string, {
          state?: {
            messages?: string[];
            accounts?: Map<string, {
              currentHeight?: number;
              pendingFrame?: { height?: number };
              mempool?: Array<{ type?: string }>;
            }>;
          };
        }>;
        gossip?: { getProfiles?: () => Array<{ entityId?: string; runtimeId?: string; metadata?: unknown }> };
        runtimeState?: {
          p2p?: {
            getDirectPeerState?: () => Array<{ runtimeId: string; endpoint: string; open: boolean; lastError?: string; lastErrorAt?: number }>;
            getQueueState?: () => unknown;
            getReconnectState?: () => unknown;
            isConnected?: () => boolean;
          };
        };
      };
    }).isolatedEnv;
    const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();
    const resolveCounterpartyAccount = (
      accounts: Map<string, {
	        currentHeight?: number;
	        pendingFrame?: { height?: number };
	        mempool?: Array<{ type?: string }>;
	        leftEntity?: string;
	        rightEntity?: string;
	        counterpartyEntityId?: string;
	        proofHeader?: { fromEntity?: string; toEntity?: string };
	      }>,
	      ownerEntityId: string,
	      counterpartyEntityId: string,
	    ) => {
	      const owner = normalizeEntityId(ownerEntityId);
	      const target = normalizeEntityId(counterpartyEntityId);
	      const accountBelongsToPair = (account: {
	        leftEntity?: string;
	        rightEntity?: string;
	        counterpartyEntityId?: string;
	        proofHeader?: { fromEntity?: string; toEntity?: string };
	      } | null | undefined): boolean => {
	        if (!account) return false;
	        const proofFrom = normalizeEntityId(account.proofHeader?.fromEntity);
	        const proofTo = normalizeEntityId(account.proofHeader?.toEntity);
	        if (proofFrom || proofTo) return proofFrom === owner && proofTo === target;
	        const left = normalizeEntityId(account.leftEntity);
	        const right = normalizeEntityId(account.rightEntity);
	        if (left && right) {
	          return (left === owner && right === target) || (left === target && right === owner);
	        }
	        const counterparty = normalizeEntityId(account.counterpartyEntityId);
	        return !counterparty || counterparty === target;
	      };
	      const direct = accounts.get(target) ?? accounts.get(String(counterpartyEntityId || ''));
	      if (accountBelongsToPair(direct)) return direct;
	      for (const [accountKey, account] of accounts.entries()) {
	        if (normalizeEntityId(accountKey) === target && accountBelongsToPair(account)) return account;
	        const left = normalizeEntityId(account.leftEntity);
	        const right = normalizeEntityId(account.rightEntity);
	        if ((left === owner && right === target) || (right === owner && left === target)) return account;
	        if (accountBelongsToPair(account)) return account;
	      }
	      return null;
	    };
    const replica = env?.eReplicas?.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
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
      height: env?.height,
      timestamp: env?.timestamp,
      p2p: {
        connected: env?.runtimeState?.p2p?.isConnected?.() ?? null,
        directPeers: env?.runtimeState?.p2p?.getDirectPeerState?.() ?? null,
        queue: env?.runtimeState?.p2p?.getQueueState?.() ?? null,
        reconnect: env?.runtimeState?.p2p?.getReconnectState?.() ?? null,
      },
	      account: account ? {
	        currentHeight: Number(account.currentHeight || 0),
	        pendingHeight: account.pendingFrame ? Number(account.pendingFrame.height || 0) : null,
	        mempool: (account.mempool || []).map((tx) => tx.type),
	        leftEntity: String(account.leftEntity || ''),
	        rightEntity: String(account.rightEntity || ''),
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
  await expect.poll(
    async () => {
      lastStatus = await readHubAccountStatus(page, userEntityId, hubId, tokenIds);
      const tokens = Array.isArray(lastStatus.tokens) ? lastStatus.tokens : [];
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
  return await page.evaluate(() => typeof (window as typeof window & { isolatedEnv?: unknown }).isolatedEnv !== 'undefined');
}

async function hasExportedRuntimeP2P(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeState?: {
          p2p?: unknown;
        };
      };
    }).isolatedEnv;
    return Boolean(env?.runtimeState?.p2p);
  }).catch(() => false);
}

async function hasRenderedCommittedAccountCard(page: Page, hubId: string): Promise<boolean> {
  return page.evaluate((targetHubId) => {
    const normalizeEntityId = (value: string): string => String(value || '').trim().toLowerCase();
    const target = normalizeEntityId(targetHubId);
    const cards = Array.from(document.querySelectorAll('.account-preview'));
    const card = cards.find((entry) => {
      const rawCounterpartyId = String(
        entry.getAttribute('data-counterparty-id')
        || entry.querySelector('.entity-id, .id, [data-entity-id]')?.textContent
        || '',
      ).trim();
      return normalizeEntityId(rawCounterpartyId) === target;
    });
    if (!card) return false;
    const text = String(card.textContent || '');
    return !/Awaiting first frame/i.test(text);
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
    && tokenIds.includes(1);
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
      await enqueueOpenAccount(page, identity.entityId, identity.signerId, hubId);
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
            await enqueueOpenAccount(page, identity.entityId, identity.signerId, hubId);
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
    if (canUseDefaultUiConnect && tokenId === 1) continue;
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

export async function connectHub(page: Page, hubId: string): Promise<void> {
  await ensureRuntimeOnline(page, 'connect-hub');
  const identity = await readSelectedUiRuntimeIdentity(page);
  await connectRuntimeToHub(page, identity, hubId);
}
