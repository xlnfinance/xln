<!--
  OnboardingPanel.svelte

  Single-pass post-wallet setup.
  Public profile, default policy, and initial hub join live on one screen so
  the user can create a usable entity in one pass.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import type { Env } from '@xln/runtime/xln-api';
  import { enqueueEntityInputs, getEnv, resolveConfiguredApiBase, xlnFunctions } from '../../stores/xlnStore';
  import { activeRuntime } from '../../stores/vaultStore';
  import { entityAvatar } from '../../utils/avatar';
  import {
    type HubJoinPreference,
    hydrateJurisdictionPolicyDefaults,
    readHubJoinPreference,
    readSavedCollateralPolicy,
    writeHubJoinPreference,
    writeSavedCollateralPolicy,
    getOpenAccountRebalancePolicyData,
  } from '../../utils/onboardingPreferences';
  import { readOnboardingComplete, writeOnboardingComplete } from '../../utils/onboardingState';
  import { normalizeEntityId, hasCounterpartyAccount } from '../../utils/entityReplica';

  export let entityId: string = '';
  export let signerId: string = '';

  const dispatch = createEventDispatcher();

  let termsAccepted = true;
  let displayName = '';
  let softLimitUsd = 500;
  let hardLimitUsd = 10_000;
  let maxFeeUsd = 15;
  let defaultSoftLimitUsd = 500;
  let defaultHardLimitUsd = 10_000;
  let defaultMaxFeeUsd = 15;
  let autoJoinHubs: HubJoinPreference = '1';
  let submitting = false;
  let error = '';
  let hasPersistedPolicy = false;
  let avatar = '';
  let revealBrainVaultSeed = false;
  let copiedBrainVaultField = '';

  const HUB_JOIN_OPTIONS: Array<{ value: HubJoinPreference; label: string }> = [
    { value: 'manual', label: 'Join hubs manually' },
    { value: '1', label: 'Auto-join 1 hub' },
    { value: '2', label: 'Auto-join 2 hubs' },
    { value: '3', label: 'Auto-join 3 hubs' },
  ];

  const HUB_JOIN_STORAGE_KEY = 'xln-hub-join-preference';

  const toUsdInt = (value: number, fallback: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.floor(parsed));
  };

  const parseJoinCount = (pref: HubJoinPreference): number =>
    pref === 'manual' ? 0 : Number(pref);

  const shuffle = <T,>(items: T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = out[i];
      const b = out[j];
      out[i] = b as T;
      out[j] = a as T;
    }
    return out;
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  type PublicHubResponse = {
    ok: boolean;
    hubs?: Array<{
      entityId?: string;
      metadata?: {
        isHub?: boolean;
        jurisdiction?: { name?: string; chainId?: number | string; depositoryAddress?: string };
      };
    }>;
  };

  type JurisdictionLike = {
    name?: unknown;
    chainId?: unknown;
    depositoryAddress?: unknown;
  };

  const normalizeJurisdiction = (value: unknown): string => String(value || '').trim().toLowerCase();
  const jurisdictionKey = (value: unknown): string => {
    if (value && typeof value === 'object') {
      const jurisdiction = value as JurisdictionLike;
      const chainId = String(jurisdiction.chainId ?? '').trim();
      const depository = String(jurisdiction.depositoryAddress ?? '').trim().toLowerCase();
      if (chainId && depository) return `dep:${chainId}:${depository}`;
      if (chainId) return '';
      return normalizeJurisdiction(jurisdiction.name);
    }
    return normalizeJurisdiction(value);
  };

  function getEntityJurisdictionKey(currentEnv: Env | undefined, targetEntityId: string): string {
    const normalizedEntityId = normalizeEntityId(targetEntityId);
    if (!normalizedEntityId || !currentEnv?.eReplicas) return '';
    for (const [key, replica] of currentEnv.eReplicas.entries()) {
      const [replicaEntityId] = String(key || '').split(':');
      if (normalizeEntityId(replicaEntityId) !== normalizedEntityId) continue;
      return jurisdictionKey(replica?.state?.config?.jurisdiction)
        || jurisdictionKey(replica?.position?.jurisdiction);
    }
    return '';
  }

  const hasSavedHubJoinPreference = (): boolean =>
    typeof localStorage !== 'undefined' && localStorage.getItem(HUB_JOIN_STORAGE_KEY) !== null;

  const getRuntimeSuggestedName = (): string => {
    const currentEnv = getEnv();
    const replica = currentEnv?.eReplicas?.get(entityId);
    const replicaName = String(replica?.state?.profile?.name || '').trim();
    if (replicaName) return replicaName;
    const vaultLabel = String($activeRuntime?.label || '').trim();
    if (vaultLabel) return vaultLabel;
    if (typeof localStorage !== 'undefined') {
      const savedName = String(localStorage.getItem('xln-display-name') || '').trim();
      if (savedName) return savedName;
    }
    return '';
  };

  $: avatar = entityAvatar($xlnFunctions, entityId);
  $: brainVaultSeed = String($activeRuntime?.seed || '').trim();
  $: brainVaultMnemonic12 = String($activeRuntime?.mnemonic12 || '').trim();
  $: brainVaultSigner = $activeRuntime?.signers?.[0] ?? null;
  $: brainVaultSignerAddress = String(brainVaultSigner?.address || '').trim();
  $: brainVaultWordCount = brainVaultSeed ? brainVaultSeed.split(/\s+/).filter(Boolean).length : 0;
  $: brainVaultRuntimeLabel = String($activeRuntime?.label || 'BrainVault').trim();
  $: hasBrainVaultRecovery = Boolean(brainVaultSeed || brainVaultMnemonic12);

  const shortValue = (value: string): string => {
    const text = String(value || '').trim();
    if (text.length <= 18) return text || '-';
    return `${text.slice(0, 10)}...${text.slice(-6)}`;
  };

  async function copyBrainVaultValue(value: string, field: string): Promise<void> {
    const text = String(value || '').trim();
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return;
    await navigator.clipboard.writeText(text);
    copiedBrainVaultField = field;
    setTimeout(() => {
      if (copiedBrainVaultField === field) copiedBrainVaultField = '';
    }, 1200);
  }

  function downloadBrainVaultSheet(): void {
    if (typeof window === 'undefined') return;
    const lines = [
      'XLN BrainVault recovery sheet',
      '',
      `Wallet: ${brainVaultRuntimeLabel || '-'}`,
      `Runtime ID: ${$activeRuntime?.id || '-'}`,
      `Entity ID: ${entityId || '-'}`,
      `Signer: ${brainVaultSignerAddress || '-'}`,
      `Seed words: ${brainVaultWordCount || '-'}`,
      '',
      '24-word recovery phrase:',
      brainVaultSeed || '-',
      '',
      ...(brainVaultMnemonic12 ? ['12-word compatibility phrase:', brainVaultMnemonic12, ''] : []),
      'Store offline. Anyone with these words can control this wallet.',
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'xln-brainvault-recovery.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  $: canFinish =
    termsAccepted &&
    displayName.trim().length >= 2 &&
    softLimitUsd > 0 &&
    hardLimitUsd >= softLimitUsd &&
    maxFeeUsd >= 0;

  {
    const savedPolicy = readSavedCollateralPolicy();
    softLimitUsd = savedPolicy.softLimitUsd;
    hardLimitUsd = savedPolicy.hardLimitUsd;
    maxFeeUsd = savedPolicy.maxFeeUsd;
    hasPersistedPolicy = savedPolicy.timestamp > 0;
    autoJoinHubs = hasSavedHubJoinPreference() ? readHubJoinPreference() : '1';
  }

  onMount(async () => {
    const suggestedName = getRuntimeSuggestedName();
    if (!displayName.trim() && suggestedName) {
      displayName = suggestedName.slice(0, 32);
    }

    try {
      const env = getEnv();
      const activeJurisdiction = String(env?.activeJurisdiction || '').trim().toLowerCase();
      const defaults = await hydrateJurisdictionPolicyDefaults(activeJurisdiction);
      defaultSoftLimitUsd = defaults.softLimitUsd;
      defaultHardLimitUsd = defaults.hardLimitUsd;
      defaultMaxFeeUsd = defaults.maxFeeUsd;

      if (!hasPersistedPolicy) {
        softLimitUsd = defaults.softLimitUsd;
        hardLimitUsd = defaults.hardLimitUsd;
        maxFeeUsd = defaults.maxFeeUsd;
      }
    } catch {
      // Keep local defaults if /api/jurisdictions isn't available yet.
    }
  });

  function getHubEntityIds(currentEnv: Env): string[] {
    const discovered: string[] = [];
    const entityJurisdiction = getEntityJurisdictionKey(currentEnv, entityId);
    if (!entityJurisdiction) return discovered;
    const add = (value: unknown) => {
      const id = String(value || '').trim();
      if (!id) return;
      if (normalizeEntityId(id) === normalizeEntityId(entityId)) return;
      if (!discovered.some(existing => normalizeEntityId(existing) === normalizeEntityId(id))) {
        discovered.push(id);
      }
    };

    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    for (const profile of profiles) {
      if (profile.metadata.isHub !== true) continue;
      if (entityJurisdiction && jurisdictionKey(profile.metadata?.jurisdiction) !== entityJurisdiction) continue;
      add(profile.entityId);
    }

    return discovered;
  }

  async function fetchPublicHubEntityIds(currentEnv: Env): Promise<string[]> {
    if (typeof window === 'undefined') return [];
    const entityJurisdiction = getEntityJurisdictionKey(currentEnv, entityId);
    if (!entityJurisdiction) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const apiBase = resolveConfiguredApiBase(window.location.origin);
      const url = new URL('/api/hubs', apiBase);
      url.searchParams.set('ts', String(Date.now()));
      const response = await fetch(url.toString(), { cache: 'no-store', signal: controller.signal });
      if (!response.ok) return [];
      const payload = await response.json() as PublicHubResponse;
      const out: string[] = [];
      for (const hub of payload.hubs || []) {
        if (!hub?.entityId || hub.metadata?.isHub !== true) continue;
        if (jurisdictionKey(hub.metadata?.jurisdiction) !== entityJurisdiction) continue;
        const normalized = normalizeEntityId(hub.entityId);
        if (!normalized || normalized === normalizeEntityId(entityId)) continue;
        if (!out.some(existing => normalizeEntityId(existing) === normalized)) out.push(hub.entityId);
      }
      return out;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async function queueAutoHubJoins(joinCount: number): Promise<number> {
    if (joinCount <= 0 || !entityId || !signerId) return 0;

    const waitForCandidates = async (): Promise<string[]> => {
      const timeoutMs = 12_000;
      const pollMs = 300;
      const startedAt = Date.now();
      let best: string[] = [];

      while (Date.now() - startedAt < timeoutMs) {
        const currentEnv = getEnv();
        if (currentEnv) {
          const ids = [
            ...getHubEntityIds(currentEnv),
            ...await fetchPublicHubEntityIds(currentEnv),
          ];
          const uniqueIds = Array.from(new Map(ids.map(id => [normalizeEntityId(id), id])).values());
          const currentCandidates = shuffle(uniqueIds)
            .filter((hubId) => !hasCounterpartyAccount(currentEnv, entityId, hubId));
          if (currentCandidates.length > best.length) best = currentCandidates;
          if (currentCandidates.length >= joinCount) return currentCandidates.slice(0, joinCount);
        }
        await sleep(pollMs);
      }

      return best.slice(0, joinCount);
    };

    const env = getEnv();
    if (!env) return 0;
    const rebalancePolicy = getOpenAccountRebalancePolicyData();
    if (!rebalancePolicy) return 0;

    const candidates = await waitForCandidates();
    if (candidates.length === 0) return 0;

    const creditAmount = 10_000n * 10n ** 18n;
    const entityTxs = candidates.map((hubId) => ({
      type: 'openAccount' as const,
      data: {
        targetEntityId: hubId,
        creditAmount,
        tokenId: 1,
        rebalancePolicy,
      },
    }));

    await enqueueEntityInputs(env, [{
      entityId,
      signerId,
      entityTxs,
    }]);

    return candidates.length;
  }

  async function finish() {
    if (!canFinish || submitting) return;
    submitting = true;
    error = '';

    try {
      writeOnboardingComplete(entityId, true);
      localStorage.setItem('xln-display-name', displayName.trim());

      const policyData = writeSavedCollateralPolicy({
        mode: 'autopilot',
        softLimitUsd: toUsdInt(softLimitUsd, defaultSoftLimitUsd),
        hardLimitUsd: toUsdInt(hardLimitUsd, defaultHardLimitUsd),
        maxFeeUsd: toUsdInt(maxFeeUsd, defaultMaxFeeUsd),
      });
      const savedJoinPreference = writeHubJoinPreference(autoJoinHubs);

      if (entityId && signerId) {
        const env = getEnv();
        if (env) {
          await enqueueEntityInputs(env, [{
            entityId,
            signerId,
            entityTxs: [{
              type: 'profile-update' as const,
              data: {
                profile: {
                  entityId,
                  name: displayName.trim(),
                  bio: '',
                  website: '',
                },
              },
            }],
          }]);
        }
      }

      const autoJoinCount = parseJoinCount(savedJoinPreference);
      const autoJoinedCount = await queueAutoHubJoins(autoJoinCount);

      dispatch('complete', {
        displayName: displayName.trim(),
        softLimitUsd: policyData.softLimitUsd,
        hardLimitUsd: policyData.hardLimitUsd,
        maxFeeUsd: policyData.maxFeeUsd,
        autoJoinHubs: savedJoinPreference,
        autoJoinedCount,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : 'Setup failed';
      submitting = false;
    }
  }

  export function isOnboardingComplete(checkEntityId: string): boolean {
    return readOnboardingComplete(checkEntityId);
  }

  export function getSavedPolicy(): {
    mode: string;
    softLimitUsd: number;
    hardLimitUsd: number;
    maxFeeUsd: number;
  } | null {
    return readSavedCollateralPolicy();
  }

  export function getSavedDisplayName(): string {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem('xln-display-name') || '';
  }
</script>

<div class="onboarding">
  <div class="setup-card">
    {#if hasBrainVaultRecovery}
      <section class="setup-section brainvault-section">
        <details class="brainvault-details" data-testid="brainvault-onboarding-recovery">
          <summary data-testid="brainvault-onboarding-recovery-toggle">
            <span class="brainvault-summary-copy">
              <strong>BrainVault recovery</strong>
              <small>Download the seed sheet, then continue with account setup.</small>
            </span>
            <span class="brainvault-summary-meta">
              <span>{brainVaultWordCount ? `${brainVaultWordCount} words` : 'Seed ready'}</span>
              {#if brainVaultSignerAddress}
                <code title={brainVaultSignerAddress}>{shortValue(brainVaultSignerAddress)}</code>
              {/if}
            </span>
            <span class="brainvault-chevron" aria-hidden="true">⌄</span>
          </summary>

          <div class="brainvault-panel">
            <div class="brainvault-actions">
              <button type="button" class="mini-action" on:click={downloadBrainVaultSheet}>
                Download sheet
              </button>
              <a class="mini-action" href="/docs-static/faq.md" target="_blank" rel="noreferrer">
                Read safety notes
              </a>
              <button
                type="button"
                class="mini-action"
                disabled={!brainVaultSeed}
                on:click={() => revealBrainVaultSeed = !revealBrainVaultSeed}
              >
                {revealBrainVaultSeed ? 'Hide seed' : 'Show seed'}
              </button>
              <button
                type="button"
                class="mini-action"
                disabled={!brainVaultSeed}
                on:click={() => copyBrainVaultValue(brainVaultSeed, 'seed')}
              >
                {copiedBrainVaultField === 'seed' ? 'Copied' : 'Copy seed'}
              </button>
            </div>
            <div class="brainvault-row">
              <span>Wallet</span>
              <code>{brainVaultRuntimeLabel || '-'}</code>
            </div>
            <div class="brainvault-row">
              <span>Signer</span>
              <code>{brainVaultSignerAddress || '-'}</code>
            </div>
            {#if revealBrainVaultSeed}
              <div class="seed-box">
                {#each brainVaultSeed.split(/\s+/) as word, index}
                  {#if word}
                    <span><b>{index + 1}</b>{word}</span>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        </details>
        <p class="brainvault-continue" data-testid="brainvault-continue-copy">
          Or continue creating the XLN account with these data.
        </p>
      </section>
    {/if}

    <section class="setup-section">
      <label class="form-label" for="display-name">Display name</label>
      <input
        id="display-name"
        type="text"
        class="form-input"
        placeholder="e.g. Alice, CryptoShop, MyExchange"
        bind:value={displayName}
        maxlength="32"
      />
      <p class="form-hint compact">Visible in gossip, account lists, and routing flows.</p>
      <div class="profile-preview-card">
        {#if avatar}
          <img src={avatar} alt="Entity avatar" class="profile-preview-avatar" />
        {:else}
          <div class="profile-preview-avatar placeholder">?</div>
        {/if}
        <div class="profile-preview-copy">
          <strong>{displayName.trim() || 'Your public name'}</strong>
          <code>{entityId}</code>
        </div>
      </div>
    </section>

    <section class="setup-section">
      <div class="section-headline">
        <h3>Default limits</h3>
        <p>These values are used when new hub accounts are opened.</p>
      </div>
      <div class="policy-grid">
        <label class="policy-field">
          <span class="form-label">Soft limit (USD)</span>
          <input
            type="number"
            min="1"
            step="1"
            class="form-input policy-input"
            bind:value={softLimitUsd}
            on:input={() => softLimitUsd = toUsdInt(softLimitUsd, defaultSoftLimitUsd)}
          />
        </label>

        <label class="policy-field">
          <span class="form-label">Hard limit (USD)</span>
          <input
            type="number"
            min="1"
            step="1"
            class="form-input policy-input"
            bind:value={hardLimitUsd}
            on:input={() => hardLimitUsd = toUsdInt(hardLimitUsd, defaultHardLimitUsd)}
          />
        </label>

        <label class="policy-field">
          <span class="form-label">Max fee (USD)</span>
          <input
            type="number"
            min="0"
            step="1"
            class="form-input policy-input"
            bind:value={maxFeeUsd}
            on:input={() => maxFeeUsd = toUsdInt(maxFeeUsd, defaultMaxFeeUsd)}
          />
        </label>
      </div>
      <p class="form-hint">
        Default for this jurisdiction: soft <strong>{defaultSoftLimitUsd.toLocaleString()}</strong>,
        hard <strong>{defaultHardLimitUsd.toLocaleString()}</strong>,
        fee <strong>{defaultMaxFeeUsd.toLocaleString()}</strong>.
      </p>
      <div class="hub-join-inline">
        <label class="form-label" for="hub-join-select">Initial hub join</label>
        <select id="hub-join-select" class="hub-join-select" bind:value={autoJoinHubs}>
          {#each HUB_JOIN_OPTIONS as option}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
        <p class="form-hint compact">Open your first bilateral account automatically right after setup.</p>
      </div>
    </section>

    <section class="setup-section confirm-section">
      <div class="confirm-row">
        <label class="checkbox-row">
          <input type="checkbox" bind:checked={termsAccepted} />
          <span>I understand this is testnet software and I accept the associated risks.</span>
        </label>
        <button class="btn-primary" disabled={!canFinish || submitting} on:click={finish}>
          {submitting ? 'Starting...' : 'Start'}
        </button>
      </div>
      {#if error}
        <div class="error-msg">{error}</div>
      {/if}
    </section>
  </div>
</div>

<style>
  .onboarding {
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    padding: 8px 16px 24px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    color: #e7e5e4;
  }

  .setup-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .setup-section {
    background: linear-gradient(180deg, #16120f 0%, #100d0b 100%);
    border: 1px solid #2f2620;
    border-radius: 14px;
    padding: 16px;
  }

  .brainvault-section {
    padding: 0;
    overflow: hidden;
    background: linear-gradient(180deg, #18130f 0%, #100d0b 100%);
  }

  .brainvault-details summary {
    min-height: 58px;
    padding: 14px 16px 12px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(120px, auto) auto;
    align-items: center;
    gap: 12px;
    cursor: pointer;
    list-style: none;
  }

  .brainvault-details summary::-webkit-details-marker {
    display: none;
  }

  .brainvault-summary-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .brainvault-details summary strong {
    color: #f5f5f4;
    font-size: 15px;
    line-height: 1.2;
  }

  .brainvault-details summary small {
    color: #a8a29e;
    font-size: 12px;
    line-height: 1.35;
  }

  .brainvault-summary-meta {
    min-width: 0;
    color: #78716c;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    text-align: right;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  .brainvault-summary-meta span,
  .brainvault-summary-meta code {
    min-width: 0;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .brainvault-chevron {
    color: #a8a29e;
    transition: transform 0.15s ease;
  }

  .brainvault-details[open] .brainvault-chevron {
    transform: rotate(180deg);
  }

  .brainvault-panel {
    padding: 14px 16px 16px;
    border-top: 1px solid #27211c;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: rgba(0, 0, 0, 0.16);
  }

  .brainvault-row {
    display: grid;
    grid-template-columns: 92px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    color: #78716c;
    font-size: 12px;
  }

  .brainvault-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .mini-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 34px;
    padding: 0 12px;
    border-radius: 9px;
    border: 1px solid #322821;
    background: #0f0b09;
    color: #e7e5e4;
    font-size: 12px;
    font-weight: 700;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
    line-height: 1.25;
  }

  .mini-action:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .seed-box {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    padding: 10px;
    border-radius: 10px;
    background: #0f0b09;
    border: 1px solid #322821;
  }

  .seed-box span {
    min-width: 0;
    display: flex;
    gap: 5px;
    align-items: baseline;
    color: #f5f5f4;
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .seed-box b {
    color: #78716c;
    font-size: 10px;
  }

  .brainvault-continue {
    margin: 0;
    padding: 11px 16px 14px;
    border-top: 1px solid #27211c;
    color: #a8a29e;
    font-size: 13px;
    line-height: 1.45;
  }

  .profile-preview-avatar {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .profile-preview-avatar.placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #fbbf24, #f59e0b);
    color: #09090b;
    font-weight: 700;
  }

  h3 {
    margin: 0;
  }

  .section-headline p {
    margin: 0;
    color: #a8a29e;
    font-size: 14px;
    line-height: 1.55;
  }

  code {
    display: inline-block;
    max-width: 100%;
    overflow-wrap: anywhere;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #f5f5f4;
  }

  .form-label {
    display: block;
    margin-bottom: 6px;
    font-size: 11px;
    font-weight: 600;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .form-input,
  .hub-join-select {
    width: 100%;
    box-sizing: border-box;
    min-height: 48px;
    padding: 12px 14px;
    background: #0f0b09;
    border: 1px solid #322821;
    border-radius: 10px;
    color: #e7e5e4;
    font-size: 15px;
    color-scheme: dark;
  }

  .hub-join-select option {
    background: #0f0b09;
    color: #e7e5e4;
  }

  .form-input:focus,
  .hub-join-select:focus {
    outline: none;
    border-color: #fbbf24;
    box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.08);
  }

  .profile-preview-card {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px;
    border-radius: 12px;
    background: #11100f;
    border: 1px solid #27272a;
  }

  .profile-preview-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .profile-preview-copy strong {
    font-size: 17px;
    color: #fafaf9;
  }

  .policy-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  @media (max-width: 640px) {
    .brainvault-details summary {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .brainvault-summary-meta {
      grid-column: 1 / -1;
      justify-content: flex-start;
      text-align: left;
    }

    .brainvault-actions,
    .policy-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .brainvault-row {
      grid-template-columns: minmax(0, 1fr);
      gap: 4px;
    }
  }

  .policy-field {
    min-width: 0;
  }

  .policy-input {
    margin-top: 4px;
  }

  .form-hint {
    margin: 10px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: #78716c;
  }

  .form-hint strong {
    color: #fbbf24;
  }

  .form-hint.compact {
    margin-top: 8px;
  }

  .hub-join-inline {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid #27211c;
  }

  .checkbox-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    cursor: pointer;
    font-size: 14px;
    line-height: 1.5;
    color: #a8a29e;
  }

  .checkbox-row input[type='checkbox'] {
    margin-top: 2px;
    flex-shrink: 0;
  }

  .confirm-section {
    gap: 14px;
  }

  .confirm-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }

  .error-msg {
    padding: 10px 14px;
    background: rgba(244, 63, 94, 0.08);
    border: 1px solid rgba(244, 63, 94, 0.2);
    border-radius: 10px;
    color: #f43f5e;
    font-size: 12px;
  }

  .btn-primary {
    padding: 13px 24px;
    background: linear-gradient(135deg, #fbbf24, #f59e0b);
    border: none;
    border-radius: 10px;
    color: #09090b;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
  }

  .btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  @media (max-width: 720px) {
    .onboarding {
      padding-top: 0;
      padding-left: 12px;
      padding-right: 12px;
    }

    .setup-section {
      padding: 14px;
      border-radius: 12px;
    }

    .profile-preview-card {
      align-items: flex-start;
    }

    .policy-grid {
      grid-template-columns: 1fr;
    }

    .brainvault-row {
      grid-template-columns: 1fr;
      gap: 4px;
    }

    .brainvault-details summary {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .brainvault-summary-meta {
      grid-column: 1 / -1;
      max-width: none;
      text-align: left;
    }

    .brainvault-actions {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .seed-box {
      grid-template-columns: 1fr;
    }

    .btn-primary {
      width: 100%;
    }

    .confirm-row {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
