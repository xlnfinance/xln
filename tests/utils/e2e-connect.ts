import { expect, type Page } from '@playwright/test';

const DEFAULT_TOKEN_IDS = [1, 3, 2] as const;
const DEFAULT_OPEN_TIMEOUT_MS = 75_000;
const DEFAULT_CREDIT_AMOUNT_DISPLAY = '10000';

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

      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeoutMs) {
        for (const [replicaKey, replica] of env.eReplicas.entries()) {
          const [replicaEntityId, replicaSignerId] = String(replicaKey).split(':');
          if (String(replicaEntityId || '').toLowerCase() !== String(entityId || '').toLowerCase()) continue;
          if (String(replicaSignerId || '').toLowerCase() !== String(signerId || '').toLowerCase()) continue;
          const account = replica.state?.accounts?.get(hubId);
          if (!account) continue;
          const hasDelta = tokenIds.every((tokenId) => Boolean(account.deltas?.get?.(tokenId)));
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
  const startUsingButton = page.getByRole('button', { name: /Start( using xln)?|Continue/i }).first();
  if (!await startUsingButton.isVisible().catch(() => false)) return;

  const riskCheckbox = page.getByRole('checkbox', {
    name: /I understand.*testnet software|I understand and accept the risks/i,
  }).first();
  if (await riskCheckbox.isVisible().catch(() => false)) {
    const checked = await riskCheckbox.isChecked().catch(() => false);
    if (!checked) await riskCheckbox.check();
  }

  await startUsingButton.click();
  await expect(startUsingButton).not.toBeVisible({ timeout: 20_000 });
}

async function openAccountsWorkspace(page: Page): Promise<void> {
  await dismissOnboardingIfVisible(page);
  const accountsTab = page.getByTestId('tab-accounts').first();
  const accountList = page.getByTestId('account-list-wrapper').first();
  const workspaceTabs = page.locator('nav[aria-label="Account workspace"]').first();
  const isAccountsWorkspaceVisible = async () =>
    await accountList.isVisible().catch(() => false)
      || await workspaceTabs.isVisible().catch(() => false);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await isAccountsWorkspaceVisible()) break;
    if (await accountsTab.isVisible().catch(() => false)) {
      await accountsTab.click();
      await page.waitForTimeout(300);
      continue;
    }
  }

  await expect
    .poll(async () => await isAccountsWorkspaceVisible(), {
      timeout: 20_000,
      intervals: [200, 400, 800],
      message: 'accounts workspace must be visible',
    })
    .toBe(true);
}

async function openWorkspaceTab(page: Page, label: RegExp): Promise<void> {
  await openAccountsWorkspace(page);
  const tab = page.locator('.account-workspace-tab').filter({ hasText: label }).first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.scrollIntoViewIfNeeded();
  await tab.click();
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

async function ensureHubCardVisible(page: Page, hubId: string): Promise<void> {
  await openWorkspaceTab(page, /Open Account/i);
  const panel = page.locator('.hub-panel').first();
  await expect(panel).toBeVisible({ timeout: 20_000 });
  const hubCardLabel = await resolveHubCardLabel(page, hubId);
  const hubCard = panel.locator('.hub-card').filter({ hasText: hubCardLabel }).first();
  const refresh = panel.getByRole('button', { name: /^Refresh$/ }).first();
  const detailsButtons = panel.locator('.expand-toggle');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await hubCard.isVisible().catch(() => false)) return;
    const count = await detailsButtons.count();
    for (let index = 0; index < count; index += 1) {
      const button = detailsButtons.nth(index);
      if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => {});
      }
    }
    if (await hubCard.isVisible().catch(() => false)) return;
    await expect(refresh).toBeVisible({ timeout: 10_000 });
    await refresh.click();
    await page.waitForTimeout(1_000);
  }

  await expect(hubCard, `hub ${hubId} must appear in hub discovery`).toBeVisible({ timeout: 20_000 });
}

async function connectHubThroughUi(page: Page, hubId: string): Promise<void> {
  await ensureHubCardVisible(page, hubId);
  const hubCardLabel = await resolveHubCardLabel(page, hubId);
  const hubCard = page.locator('.hub-card').filter({ hasText: hubCardLabel }).first();
  const connectButton = hubCard.getByRole('button', { name: /Connect/i }).first();
  if (await connectButton.isVisible().catch(() => false)) {
    await connectButton.click();
  }
}

async function enqueueOpenAccount(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
): Promise<void> {
  const queued = await page.evaluate(async ({ entityId, signerId, hubId }) => {
    const view = window as typeof window & {
      isolatedEnv?: unknown;
      __xln_env?: unknown;
      XLN?: { enqueueRuntimeInput?: (env: unknown, input: unknown) => void };
      __xln_instance?: { enqueueRuntimeInput?: (env: unknown, input: unknown) => void };
    };
    const env = view.isolatedEnv ?? view.__xln_env;
    const XLN = view.XLN
      ?? view.__xln_instance
      ?? await import(/* @vite-ignore */ new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href);
    if (!env || !XLN?.enqueueRuntimeInput) return { ok: false, error: 'isolatedEnv/XLN missing' };

    XLN.enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'openAccount',
          data: {
            targetEntityId: hubId,
            creditAmount: 10_000n * 10n ** 18n,
            tokenId: 1,
          },
        }],
      }],
    });
    return { ok: true };
  }, { entityId, signerId, hubId });

  expect(queued.ok, queued.error || `openAccount enqueue failed for ${hubId.slice(0, 10)}`).toBe(true);
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
    await option.click();
  } else {
    const fallbackOption = page.locator('.dropdown-item').filter({ hasText: hubId }).first();
    await expect(fallbackOption).toBeVisible({ timeout: 20_000 });
    await fallbackOption.click();
  }
  await expect(selector.locator('.closed-trigger').first()).toContainText(hubId.slice(0, 10), { timeout: 20_000 });
}

async function openConfigureWorkspace(page: Page, hubId: string): Promise<void> {
  await openWorkspaceTab(page, /Configure/i);
  await expect(page.locator('.configure-panel').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.configure-empty').first()).not.toBeVisible({ timeout: 20_000 });
  await selectConfigureAccount(page, hubId);
}

async function addTokenToAccount(page: Page, hubId: string, tokenId: number): Promise<void> {
  await openConfigureWorkspace(page, hubId);
  const tokenTab = page.locator('.configure-tab').filter({ hasText: /Add Token/i }).first();
  await expect(tokenTab).toBeVisible({ timeout: 20_000 });
  await tokenTab.click();
  const tokenSelect = page.locator('.configure-token-select').first();
  await expect(tokenSelect).toBeVisible({ timeout: 20_000 });
  await tokenSelect.selectOption(String(tokenId));
  const addButton = page.getByRole('button', { name: /^Add Token$/ }).first();
  await expect(addButton).toBeEnabled({ timeout: 20_000 });
  await addButton.click();
}

async function extendCreditToken(page: Page, hubId: string, tokenId: number, amountDisplay: string): Promise<void> {
  const amount = BigInt(amountDisplay) * 10n ** 18n;
  const queued = await page.evaluate(async ({ hubId, tokenId, amount }) => {
    const view = window as typeof window & {
      isolatedEnv?: unknown;
      __xln_env?: unknown;
      XLN?: { enqueueRuntimeInput?: (env: unknown, input: unknown) => void };
      __xln_instance?: { enqueueRuntimeInput?: (env: unknown, input: unknown) => void };
    };
    const env = view.isolatedEnv ?? view.__xln_env;
    const XLN = view.XLN
      ?? view.__xln_instance
      ?? await import(/* @vite-ignore */ new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href);
    if (!env || !XLN?.enqueueRuntimeInput) return { ok: false, error: 'isolatedEnv/XLN missing' };

    const replicas = (env as { eReplicas?: Map<string, unknown>; runtimeId?: string }).eReplicas;
    const runtimeId = String((env as { runtimeId?: string }).runtimeId || '').toLowerCase();
    let identity: { entityId: string; signerId: string } | null = null;
    if (replicas instanceof Map) {
      for (const rawKey of replicas.keys()) {
        const [entityId, signerId] = String(rawKey).split(':');
        if (!entityId?.startsWith('0x') || entityId.length !== 66 || !signerId) continue;
        if (runtimeId && String(signerId).toLowerCase() !== runtimeId) continue;
        identity = { entityId, signerId };
        break;
      }
    }
    if (!identity) return { ok: false, error: 'local identity missing' };

    XLN.enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: identity.entityId,
        signerId: identity.signerId,
        entityTxs: [{
          type: 'extendCredit',
          data: {
            counterpartyEntityId: hubId,
            tokenId,
            amount,
          },
        }],
      }],
    });
    return { ok: true };
  }, { hubId, tokenId, amount });
  expect(queued.ok, queued.error || `extendCredit enqueue failed for token ${tokenId}`).toBe(true);

  await expect.poll(
    async () => {
      const runtimeIdentity = await page.evaluate(() => {
        const env = (window as typeof window & {
          isolatedEnv?: {
            runtimeId?: string;
            eReplicas?: Map<string, unknown>;
          };
        }).isolatedEnv;
        if (!env?.eReplicas) return null;
        const runtimeId = String(env.runtimeId || '').toLowerCase();
        for (const rawKey of env.eReplicas.keys()) {
          const [entityId, signerId] = String(rawKey).split(':');
          if (!entityId?.startsWith('0x') || entityId.length !== 66 || !signerId) continue;
          if (runtimeId && String(signerId).toLowerCase() !== runtimeId) continue;
          return { entityId, signerId };
        }
        return null;
      });
      if (!runtimeIdentity) return false;
      return await isAccountReady(page, runtimeIdentity.entityId, runtimeIdentity.signerId, hubId, [tokenId], 0);
    },
    {
      timeout: DEFAULT_OPEN_TIMEOUT_MS,
      intervals: [250, 500, 750],
      message: `extendCredit should activate token ${tokenId} for ${hubId.slice(0, 10)}`,
    },
  ).toBe(true);
}

type AccountOpenStatus = {
  exists: boolean;
  hasDelta: boolean;
  pendingHeight: number | null;
  currentHeight: number;
};

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

      for (const [replicaKey, replica] of env.eReplicas.entries()) {
        const [replicaEntityId, replicaSignerId] = String(replicaKey).split(':');
        if (String(replicaEntityId || '').toLowerCase() !== String(entityId || '').toLowerCase()) continue;
        if (String(replicaSignerId || '').toLowerCase() !== String(signerId || '').toLowerCase()) continue;
        const account = replica.state?.accounts?.get(hubId);
        if (!account) continue;
        return {
          exists: true,
          hasDelta: Boolean(account.deltas?.get?.(1)),
          pendingHeight: account.pendingFrame ? Number(account.pendingFrame.height || 0) : null,
          currentHeight: Number(account.currentHeight || 0),
        };
      }

      return { exists: false, hasDelta: false, pendingHeight: null, currentHeight: 0 };
    },
    { entityId, signerId, hubId },
  );
}

export async function connectRuntimeToHub(
  page: Page,
  identity: { entityId: string; signerId: string },
  hubId: string,
): Promise<void> {
  if (await isAccountReady(page, identity.entityId, identity.signerId, hubId, DEFAULT_TOKEN_IDS)) {
    return;
  }
  const initialStatus = await getAccountOpenStatus(page, identity.entityId, identity.signerId, hubId);

  if (!initialStatus.exists) {
    await enqueueOpenAccount(page, identity.entityId, identity.signerId, hubId);
  }

  await expect.poll(
    async () => {
      await nudgeRuntimeOnline(page);
      const status = await getAccountOpenStatus(page, identity.entityId, identity.signerId, hubId);
      return status.exists && status.currentHeight > 0 && !status.pendingHeight;
    },
    {
      timeout: DEFAULT_OPEN_TIMEOUT_MS,
      intervals: [250, 500, 750],
      message: `account ${hubId.slice(0, 10)} must be committed after hub connect`,
    },
  ).toBe(true);

  for (const tokenId of DEFAULT_TOKEN_IDS) {
    await extendCreditToken(page, hubId, tokenId, DEFAULT_CREDIT_AMOUNT_DISPLAY);
  }

  const opened = await isAccountReady(page, identity.entityId, identity.signerId, hubId, DEFAULT_TOKEN_IDS, DEFAULT_OPEN_TIMEOUT_MS);
  const finalStatus = await getAccountOpenStatus(page, identity.entityId, identity.signerId, hubId);

  expect(
    opened,
    `account open must converge for ${hubId.slice(0, 10)} ` +
      `(exists=${finalStatus.exists} hasDelta=${finalStatus.hasDelta} height=${finalStatus.currentHeight} pending=${finalStatus.pendingHeight})`,
  ).toBe(true);
}

export async function connectHub(page: Page, hubId: string): Promise<void> {
  await ensureRuntimeOnline(page, 'connect-hub');

  const identity = await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env?.eReplicas) return null;

    const runtimeId = String(env.runtimeId || '').toLowerCase();
    for (const replicaKey of env.eReplicas.keys()) {
      const [entityId, signerId] = String(replicaKey).split(':');
      if (!entityId?.startsWith('0x') || entityId.length !== 66 || !signerId) continue;
      if (runtimeId && String(signerId).toLowerCase() !== runtimeId) continue;
      return { entityId, signerId };
    }

    return null;
  });

  expect(identity, 'runtime must expose a local entity before opening an account').not.toBeNull();
  await connectRuntimeToHub(page, identity!, hubId);
}
