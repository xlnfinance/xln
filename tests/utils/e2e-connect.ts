import { expect, type Page } from '@playwright/test';
import { getTokenInfo } from '../../runtime/account/utils';
import { selectContextEntityIfAvailable } from './e2e-demo-users';
import { enqueueEntityTxs } from './e2e-runtime-input';

const DEFAULT_TOKEN_IDS = [1] as const;
const diagnosticOpenTimeoutMs = Number(process.env.E2E_DIAGNOSTIC_OPEN_TIMEOUT_MS || 75_000);
const DEFAULT_OPEN_TIMEOUT_MS = Number.isSafeInteger(diagnosticOpenTimeoutMs) && diagnosticOpenTimeoutMs >= 1_000
  ? diagnosticOpenTimeoutMs
  : 75_000;
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
        infrastructure?: {
          p2p?: {
            isConnected?: () => boolean;
            connect?: () => void;
            reconnect?: () => void;
          };
        };
      };
    }).isolatedEnv;
    const p2p = env?.infrastructure?.p2p;
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
        infrastructure?: {
          p2p?: {
            isConnected?: () => boolean;
            connect?: () => void;
            reconnect?: () => void;
          };
        };
      };
    }).isolatedEnv;
    const p2p = env?.infrastructure?.p2p;
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
          state?: {
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
        };
      }).isolatedEnv;
      if (!env?.state?.eReplicas) return false;

      const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();
      const resolveCounterpartyAccount = (
        accounts: Map<string, {
          state: {
            deltas: Map<number, unknown>;
            leftEntity: string;
            rightEntity: string;
          };
          pendingFrame?: unknown;
          currentHeight?: number;
          currentFrame?: { height?: number };
          proofHeader?: { fromEntity?: string; toEntity?: string };
        }>,
        ownerEntityId: string,
        counterpartyEntityId: string,
      ) => {
        const owner = normalizeEntityId(ownerEntityId);
        const target = normalizeEntityId(counterpartyEntityId);
        const accountBelongsToPair = (account: {
          state: { leftEntity: string; rightEntity: string };
          proofHeader?: { fromEntity?: string; toEntity?: string };
        } | null | undefined): boolean => {
          if (!account) return false;
          const proofFrom = normalizeEntityId(account.proofHeader?.fromEntity);
          const proofTo = normalizeEntityId(account.proofHeader?.toEntity);
          if (proofFrom || proofTo) return proofFrom === owner && proofTo === target;
          const left = normalizeEntityId(account.state.leftEntity);
          const right = normalizeEntityId(account.state.rightEntity);
          return (left === owner && right === target) || (left === target && right === owner);
        };
        const direct = accounts.get(target) ?? accounts.get(String(counterpartyEntityId || ''));
        if (accountBelongsToPair(direct)) return direct;
        for (const [accountKey, account] of accounts.entries()) {
          if (normalizeEntityId(accountKey) === target && accountBelongsToPair(account)) return account;
          const left = normalizeEntityId(account.state.leftEntity);
          const right = normalizeEntityId(account.state.rightEntity);
          if ((left === owner && right === target) || (right === owner && left === target)) return account;
          if (accountBelongsToPair(account)) return account;
        }
        return null;
      };

      const startedAt = Date.now();
	      while (Date.now() - startedAt <= timeoutMs) {
	        for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
	          const [replicaEntityId, replicaSignerId] = String(replicaKey).split(':');
	          if (String(replicaEntityId || '').toLowerCase() !== String(entityId || '').toLowerCase()) continue;
	          if (String(replicaSignerId || '').toLowerCase() !== String(signerId || '').toLowerCase()) continue;
	          const accounts = replica.state?.accounts;
	          const account = accounts instanceof Map
	            ? resolveCounterpartyAccount(accounts, entityId, hubId)
	            : null;
	          if (!account) continue;
	          const hasDelta = tokenIds.every((tokenId) => {
	            if (!(account.state.deltas instanceof Map)) return false;
	            for (const [deltaTokenId] of account.state.deltas.entries()) {
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
  const workspace = page.getByTestId('wallet-accounts-overview');
  if (!await workspace.isVisible().catch(() => false)) {
    const accountsNav = page.getByTestId('wallet-nav-accounts');
    await expect(accountsNav).toBeVisible({ timeout: 20_000 });
    await accountsNav.click();
  }
  await expect(workspace, 'accounts workspace must be visible').toBeVisible({ timeout: 20_000 });
}

async function waitForUsableOpenAccountProfile(
  page: Page,
  sourceEntityId: string,
  hubId: string,
  timeoutMs = 30_000,
): Promise<void> {
  let lastProfileState: unknown = null;
  try {
    await expect.poll(
      async () => page.evaluate(async ({ sourceEntityId, hubId }) => {
        type JurisdictionLike = {
          name?: unknown;
          chainId?: unknown;
          depositoryAddress?: unknown;
        };
        type EntityReplicaLike = {
          entityId?: unknown;
          position?: { jurisdiction?: unknown };
          state?: {
            entityId?: unknown;
            config?: { jurisdiction?: unknown };
          };
        };
        const env = (window as typeof window & {
          isolatedEnv?: {
            state?: { eReplicas?: Map<unknown, EntityReplicaLike> };
            gossip?: {
              getProfiles?: () => Array<{
                entityId?: string;
                runtimeId?: string;
                metadata?: { jurisdiction?: unknown };
              }>;
            };
            infrastructure?: {
              p2p?: { ensureProfiles?: (ids: string[]) => Promise<boolean> };
            };
          };
        }).isolatedEnv;
        const normalizeEntityId = (value: unknown): string =>
          String(value || '').trim().toLowerCase();
        const jurisdictionKey = (value: unknown): string => {
          if (value && typeof value === 'object') {
            const jurisdiction = value as JurisdictionLike;
            const chainId = String(jurisdiction.chainId ?? '').trim();
            const depository = String(jurisdiction.depositoryAddress ?? '').trim().toLowerCase();
            if (chainId && depository) return `dep:${chainId}:${depository}`;
            if (chainId) return '';
            return String(jurisdiction.name || '').trim().toLowerCase();
          }
          return String(value || '').trim().toLowerCase();
        };
        const getLocalJurisdiction = (targetEntityId: string): { found: boolean; key: string } => {
          const target = normalizeEntityId(targetEntityId);
          for (const [replicaKey, replica] of env?.state?.eReplicas?.entries?.() || []) {
            const entityId = normalizeEntityId(
              replica?.state?.entityId || replica?.entityId || replicaKey,
            );
            if (entityId !== target) continue;
            return {
              found: true,
              key: jurisdictionKey(replica?.state?.config?.jurisdiction)
                || jurisdictionKey(replica?.position?.jurisdiction),
            };
          }
          return { found: false, key: '' };
        };

        const source = normalizeEntityId(sourceEntityId);
        const target = normalizeEntityId(hubId);
        const ensureResult = await env?.infrastructure?.p2p?.ensureProfiles?.([target])
          .catch((error) => error instanceof Error ? error.message : String(error));
        const sourceJurisdiction = getLocalJurisdiction(source);
        const localCounterparty = getLocalJurisdiction(target);
        const profile = env?.gossip?.getProfiles?.().find((candidate) =>
          normalizeEntityId(candidate?.entityId) === target,
        );
        const profileJurisdiction = jurisdictionKey(profile?.metadata?.jurisdiction);
        const runtimeId = String(profile?.runtimeId || '').trim();
        const usable = Boolean(sourceJurisdiction.key) && (
          localCounterparty.found
            ? Boolean(localCounterparty.key && localCounterparty.key === sourceJurisdiction.key)
            : Boolean(runtimeId && profileJurisdiction === sourceJurisdiction.key)
        );

        return {
          ok: usable,
          ensureResult,
          sourceJurisdiction: sourceJurisdiction.key,
          localCounterpartyFound: localCounterparty.found,
          counterpartyJurisdiction: localCounterparty.found
            ? localCounterparty.key
            : profileJurisdiction,
          runtimeId,
        };
      }, { sourceEntityId, hubId }).then((state) => {
        lastProfileState = state;
        return state.ok;
      }),
      {
        timeout: timeoutMs,
        intervals: [100, 250, 500],
        message: `hub ${hubId.slice(0, 10)} must have a production-usable profile before UI connect`,
      },
    ).toBe(true);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n`
      + `lastOpenAccountProfileState=${stringifyDebug(lastProfileState)}`,
    );
  }
}

async function connectHubThroughUi(page: Page, sourceEntityId: string, hubId: string): Promise<void> {
  await selectContextEntityIfAvailable(page, sourceEntityId);
  await openAccountsWorkspace(page);
  const selectedIdentity = await readSelectedUiRuntimeIdentity(page);
  expect(
    selectedIdentity.entityId.toLowerCase(),
    'UI-selected entity must match the account-open source entity',
  ).toBe(sourceEntityId.toLowerCase());
  if (await hasRenderedCommittedAccountCard(page, hubId)) return;
  if (await hasExportedRuntimeP2P(page)) {
    await waitForHubRuntimeTransportReady(page, hubId);
  } else {
    await waitForPublicHubRuntimeProfile(page, hubId);
  }
  await waitForUsableOpenAccountProfile(page, sourceEntityId, hubId);
  if (await hasRenderedCommittedAccountCard(page, hubId)) return;
  const form = page.getByTestId('wallet-open-account');
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.getByLabel('Open account with entity ID').fill(hubId.toLowerCase());
  await form.getByRole('button', { name: 'Review open account' }).click();
  await form.getByRole('button', { name: 'Submit account intent' }).click();
  await expect.poll(async () => {
    const error = form.getByRole('alert');
    if (await error.isVisible().catch(() => false)) {
      const diagnostics = await readLocalConnectRuntimeDiagnostic(page, hubId);
      throw new Error(
        `OPEN_ACCOUNT_UI_ERROR:${String(await error.textContent() || '').trim()}`
        + ` diagnostics=${stringifyDebug(diagnostics)}`,
      );
    }
    return hasRenderedCommittedAccountCard(page, hubId);
  }, {
    timeout: DEFAULT_OPEN_TIMEOUT_MS,
    intervals: [250, 500, 750],
    message: `hub ${hubId} must render a committed account after submit`,
  }).toBe(true);
}

async function readLocalConnectRuntimeDiagnostic(page: Page, hubId: string): Promise<unknown> {
  return page.evaluate(({ hubId }) => {
    const env = (window as typeof window & {
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
        gossip?: {
          getProfiles?: () => Array<{
            entityId?: string;
            runtimeId?: string;
            lastUpdated?: number;
            metadata?: { isHub?: boolean; jurisdiction?: unknown };
          }>;
        };
        infrastructure?: {
          halted?: boolean;
          fatalDebugPayload?: unknown;
          loopActive?: boolean;
          p2p?: {
            isConnected?: () => boolean;
            getQueueState?: () => unknown;
            getReconnectState?: () => unknown;
          };
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
    }).isolatedEnv;
    const summarizeInputs = (inputs: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }> | undefined) =>
      (inputs || []).slice(-10).map((input) => ({
        entityId: String(input.entityId || '').slice(-8),
        txs: (input.entityTxs || []).map((tx) => String(tx?.type || '')),
      }));
    const normalize = (value: unknown): string => String(value || '').trim().toLowerCase();
    const targetHub = normalize(hubId);
    const targetProfile = env?.gossip?.getProfiles?.().find((profile) => normalize(profile.entityId) === targetHub);
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
      targetProfile: targetProfile ? {
        entityId: targetProfile.entityId ?? null,
        runtimeId: targetProfile.runtimeId ?? null,
        lastUpdated: Number(targetProfile.lastUpdated || 0),
        metadata: targetProfile.metadata ?? null,
      } : null,
      infrastructure: env?.infrastructure ? {
        halted: Boolean(env.infrastructure.halted),
        loopActive: Boolean(env.infrastructure.loopActive),
        fatalDebugPayload: env.infrastructure.fatalDebugPayload ?? null,
        p2p: env.infrastructure.p2p ? {
          connected: env.infrastructure.p2p.isConnected?.() ?? null,
          queue: env.infrastructure.p2p.getQueueState?.() ?? null,
          reconnect: env.infrastructure.p2p.getReconnectState?.() ?? null,
        } : null,
      } : null,
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
        depositoryAddress: replica.depositoryAddress ?? null,
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
  let lastProfileState: unknown = null;
  try {
    await expect
      .poll(
      async () => page.evaluate(async (targetHubId) => {
        const env = (window as typeof window & {
          isolatedEnv?: {
            gossip?: { getProfiles?: () => Array<{ entityId?: string; runtimeId?: string }> };
            infrastructure?: {
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

        const p2p = env?.infrastructure?.p2p;
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
            infrastructure?: {
              p2p?: {
                isConnected?: () => boolean;
                connect?: () => void;
                reconnect?: () => void;
                ensureProfiles?: (ids: string[]) => Promise<boolean>;
                getDirectPeerState?: () => Array<{ runtimeId: string; endpoint: string; open: boolean; lastError?: string; lastErrorAt?: number }>;
                ensureDirectClientForRuntime?: (runtimeId: string) => void;
              };
            };
          };
        }).isolatedEnv;
        const target = String(targetHubId || '').toLowerCase();
        const p2p = env?.infrastructure?.p2p;
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

        return {
          // Recipient presence is deliberately private. The actual payment or
          // profile exchange proves delivery; readiness only proves our relay.
          ok: relayConnected,
          reason: relayConnected ? 'relay-open' : 'relay-not-open',
          runtimeId,
          directEndpoint,
          directAllowed,
          relayConnected,
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
      creditAmount: 10_000n * 10n ** BigInt(getTokenInfo(1).decimals),
      tokenId: 1,
    },
  }]);
}

async function openConfigureWorkspace(page: Page, hubId: string): Promise<void> {
  await openAccountsWorkspace(page);
  const account = page.locator(
    `[data-testid="wallet-account-row"][data-counterparty-id="${hubId.toLowerCase()}"]`,
  ).first();
  await expect(account).toBeVisible({ timeout: 20_000 });
  await account.click();
  await expect(page.getByTestId('wallet-account-configure')).toBeVisible({ timeout: 20_000 });
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
      const env = (window as typeof window & {
        isolatedEnv?: {
          state?: {
            eReplicas?: Map<string, {
              state?: {
                accounts?: Map<string, {
                  state: {
                    deltas: Map<number, unknown>;
                    leftEntity: string;
                    rightEntity: string;
                  };
                  pendingFrame?: { height?: number };
                  currentHeight?: number;
                }>;
              };
            }>;
          };
        };
      }).isolatedEnv;
      if (!env?.state?.eReplicas) {
        return { exists: false, hasDelta: false, pendingHeight: null, currentHeight: 0 };
      }

      const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();
      const resolveCounterpartyAccount = (
        accounts: Map<string, {
          state: {
            deltas: Map<number, unknown>;
            leftEntity: string;
            rightEntity: string;
          };
          pendingFrame?: { height?: number };
          currentHeight?: number;
          currentFrame?: { height?: number };
          proofHeader?: { fromEntity?: string; toEntity?: string };
        }>,
        ownerEntityId: string,
        counterpartyEntityId: string,
      ) => {
        const owner = normalizeEntityId(ownerEntityId);
        const target = normalizeEntityId(counterpartyEntityId);
        const accountBelongsToPair = (account: {
          state: { leftEntity: string; rightEntity: string };
          proofHeader?: { fromEntity?: string; toEntity?: string };
        } | null | undefined): boolean => {
          if (!account) return false;
          const proofFrom = normalizeEntityId(account.proofHeader?.fromEntity);
          const proofTo = normalizeEntityId(account.proofHeader?.toEntity);
          if (proofFrom || proofTo) return proofFrom === owner && proofTo === target;
          const left = normalizeEntityId(account.state.leftEntity);
          const right = normalizeEntityId(account.state.rightEntity);
          return (left === owner && right === target) || (left === target && right === owner);
        };
        const direct = accounts.get(target) ?? accounts.get(String(counterpartyEntityId || ''));
        if (accountBelongsToPair(direct)) return direct;
        for (const [accountKey, account] of accounts.entries()) {
          if (normalizeEntityId(accountKey) === target && accountBelongsToPair(account)) return account;
          const left = normalizeEntityId(account.state.leftEntity);
          const right = normalizeEntityId(account.state.rightEntity);
          if ((left === owner && right === target) || (right === owner && left === target)) return account;
          if (accountBelongsToPair(account)) return account;
        }
        return null;
      };

      for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
        const [replicaEntityId, replicaSignerId] = String(replicaKey).split(':');
        if (String(replicaEntityId || '').toLowerCase() !== String(entityId || '').toLowerCase()) continue;
        if (String(replicaSignerId || '').toLowerCase() !== String(signerId || '').toLowerCase()) continue;
	        const accounts = replica.state?.accounts;
	        const account = accounts instanceof Map
	          ? resolveCounterpartyAccount(accounts, entityId, hubId)
	          : null;
	        if (!account) continue;
	        const hasTokenOneDelta = (() => {
	          if (!(account.state.deltas instanceof Map)) return false;
	          for (const [deltaTokenId] of account.state.deltas.entries()) {
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
        infrastructure?: {
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
        connected: env?.infrastructure?.p2p?.isConnected?.() ?? null,
        directPeers: env?.infrastructure?.p2p?.getDirectPeerState?.() ?? null,
        queue: env?.infrastructure?.p2p?.getQueueState?.() ?? null,
        reconnect: env?.infrastructure?.p2p?.getReconnectState?.() ?? null,
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
  return await page.evaluate(() => {
    const env = (window as typeof window & { isolatedEnv?: { runtimeId?: unknown } }).isolatedEnv;
    return Boolean(env && typeof env === 'object' && String(env.runtimeId || '').trim());
  });
}

async function hasExportedRuntimeP2P(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        infrastructure?: {
          p2p?: unknown;
        };
      };
    }).isolatedEnv;
    return Boolean(env?.infrastructure?.p2p);
  }).catch(() => false);
}

async function hasRenderedCommittedAccountCard(page: Page, hubId: string): Promise<boolean> {
  return page.evaluate((targetHubId) => {
    const target = String(targetHubId || '').trim().toLowerCase();
    const card = Array.from(document.querySelectorAll('[data-testid="wallet-account-row"]'))
      .find(entry => String(entry.getAttribute('data-counterparty-id') || '').trim().toLowerCase() === target);
    if (!card) return false;
    const text = String(card.textContent || '');
    return !/pending/i.test(text) && /A[1-9][0-9]*/.test(text);
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
    await connectHubThroughUi(page, identity.entityId, hubId);
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
      await connectHubThroughUi(page, identity.entityId, hubId);
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
            await connectHubThroughUi(page, identity.entityId, hubId);
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
