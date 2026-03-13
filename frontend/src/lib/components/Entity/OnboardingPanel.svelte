<!--
  OnboardingPanel.svelte

  Single-pass post-wallet setup.
  Public profile, default policy, and initial hub join live on one screen so
  the user can create a usable entity without walking a legacy wizard.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import type { Env } from '@xln/runtime/xln-api';
  import { enqueueEntityInputs, getEnv, xlnFunctions } from '../../stores/xlnStore';
  import { activeVault } from '../../stores/vaultStore';
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
  let avatarUrl = '';

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

  const hasSavedHubJoinPreference = (): boolean =>
    typeof localStorage !== 'undefined' && localStorage.getItem(HUB_JOIN_STORAGE_KEY) !== null;

  const getRuntimeSuggestedName = (): string => {
    const currentEnv = getEnv();
    const replica = currentEnv?.eReplicas?.get(entityId);
    const replicaName = String(replica?.state?.profile?.name || '').trim();
    if (replicaName) return replicaName;
    const vaultLabel = String($activeVault?.label || '').trim();
    if (vaultLabel) return vaultLabel;
    if (typeof localStorage !== 'undefined') {
      const savedName = String(localStorage.getItem('xln-display-name') || '').trim();
      if (savedName) return savedName;
    }
    return '';
  };

  $: avatarUrl = $xlnFunctions?.generateEntityAvatar?.(entityId) || '';

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
      if (profile.metadata.isHub === true) add(profile.entityId);
    }

    return discovered;
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
          const currentCandidates = shuffle(getHubEntityIds(currentEnv))
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
                  hankoSignature: '',
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
    <section class="setup-section">
      <label class="form-label" for="display-name">Display name</label>
      <input
        id="display-name"
        type="text"
        class="form-input"
        placeholder="e.g. Alice, CryptoShop, MyExchange"
        bind:value={displayName}
        maxlength="32"
        autofocus
      />
      <p class="form-hint compact">Visible in gossip, account lists, and routing flows.</p>
      <div class="profile-preview-card">
        {#if avatarUrl}
          <img src={avatarUrl} alt="Entity avatar" class="profile-preview-avatar" />
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

  .profile-preview-avatar {
    width: 56px;
    height: 56px;
    border-radius: 14px;
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

  h2, h3 {
    margin: 0;
    letter-spacing: -0.02em;
  }

  .section-headline p {
    margin: 0;
    color: #a8a29e;
    font-size: 14px;
    line-height: 1.55;
  }

  .meta-chip {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #78716c;
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
    padding: 12px 14px;
    background: #0f0b09;
    border: 1px solid #322821;
    border-radius: 10px;
    color: #e7e5e4;
    font-size: 15px;
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
    width: 18px;
    height: 18px;
    accent-color: #fbbf24;
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

    .setup-header,
    .setup-section {
      padding: 14px;
      border-radius: 12px;
    }

    .identity-block,
    .profile-preview-card {
      align-items: flex-start;
    }

    .policy-grid {
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
