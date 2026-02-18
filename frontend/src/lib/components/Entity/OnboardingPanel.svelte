<!--
  OnboardingPanel.svelte — Post-BrainVault setup (step 2)

  Shown once after first runtime creation. User must:
  1. Accept terms & conditions
  2. Set a public display name (gossip-visible, searchable)
  3. Configure autopilot policy + optional auto-join hubs

  After completion, profile is broadcast via gossip and onboarding completion
  is persisted per-entity in localStorage.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { enqueueEntityInputs, getEnv } from '../../stores/xlnStore';
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

  export let entityId: string = '';
  export let signerId: string = '';

  const dispatch = createEventDispatcher();

  // ── State ────────────────────────────────────────
  let step = 1; // 1=terms, 2=profile, 3=policy
  let termsAccepted = false;
  let displayName = '';
  let softLimitUsd = 500;
  let hardLimitUsd = 10_000;
  let maxFeeUsd = 15;
  let defaultSoftLimitUsd = 500;
  let defaultHardLimitUsd = 10_000;
  let defaultMaxFeeUsd = 15;
  let autoJoinHubs: HubJoinPreference = 'manual';
  let submitting = false;
  let error = '';
  let hasPersistedPolicy = false;

  const HUB_JOIN_OPTIONS: Array<{ value: HubJoinPreference; label: string }> = [
    { value: 'manual', label: 'Join hubs manually' },
    { value: '1', label: 'Auto-join 1 random hub' },
    { value: '2', label: 'Auto-join 2 random hubs' },
    { value: '3', label: 'Auto-join 3 random hubs' },
  ];

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

  // ── Validation ───────────────────────────────────
  $: canProceedStep1 = termsAccepted;
  $: canProceedStep2 = displayName.trim().length >= 2;
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
    autoJoinHubs = readHubJoinPreference();
  }

  onMount(async () => {
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
      // Keep static fallback defaults if jurisdictions.json isn't available.
    }
  });

  function hasAccountEntry(currentEnv: any, ownerEntityId: string, counterpartyEntityId: string): boolean {
    if (!currentEnv?.eReplicas || !(currentEnv.eReplicas instanceof Map)) return false;
    const owner = String(ownerEntityId).toLowerCase();
    const counterparty = String(counterpartyEntityId).toLowerCase();
    for (const [key, replica] of currentEnv.eReplicas.entries()) {
      const [entityKey] = String(key).split(':');
      if (String(entityKey || '').toLowerCase() !== owner) continue;
      const accounts = replica?.state?.accounts;
      if (!(accounts instanceof Map)) return false;
      for (const accountKey of accounts.keys()) {
        if (String(accountKey).toLowerCase() === counterparty) return true;
      }
      return false;
    }
    return false;
  }

  function getHubEntityIds(currentEnv: any): string[] {
    const discovered: string[] = [];
    const add = (value: unknown) => {
      const id = String(value || '').trim();
      if (!id) return;
      if (id.toLowerCase() === entityId.toLowerCase()) return;
      if (!discovered.some(existing => existing.toLowerCase() === id.toLowerCase())) {
        discovered.push(id);
      }
    };

    if (currentEnv?.gossip?.getHubs) {
      const hubs = currentEnv.gossip.getHubs();
      for (const profile of hubs || []) add(profile?.entityId);
    } else if (currentEnv?.gossip?.getProfiles) {
      const profiles = currentEnv.gossip.getProfiles();
      for (const profile of profiles || []) {
        const isHub = profile?.metadata?.isHub === true ||
          (Array.isArray(profile?.capabilities) &&
            (profile.capabilities.includes('hub') || profile.capabilities.includes('routing')));
        if (isHub) add(profile?.entityId);
      }
    }

    return discovered;
  }

  async function queueAutoHubJoins(joinCount: number): Promise<number> {
    if (joinCount <= 0 || !entityId || !signerId) return 0;
    const env = getEnv();
    if (!env) return 0;
    const rebalancePolicy = getOpenAccountRebalancePolicyData();
    if (!rebalancePolicy) return 0;

    const candidates = shuffle(getHubEntityIds(env))
      .filter(hubId => !hasAccountEntry(env, entityId, hubId))
      .slice(0, joinCount);
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

    await enqueueEntityInputs(env as any, [{
      entityId,
      signerId,
      entityTxs,
    }]);

    return candidates.length;
  }

  // ── Actions ──────────────────────────────────────
  function nextStep() {
    if (step === 1 && canProceedStep1) step = 2;
    else if (step === 2 && canProceedStep2) step = 3;
  }

  function prevStep() {
    if (step > 1) step--;
  }

  async function finish() {
    if (!canFinish || submitting) return;
    submitting = true;
    error = '';

    try {
      // Persist onboarding flag for this entity only.
      writeOnboardingComplete(entityId, true);

      // Persist display name
      localStorage.setItem('xln-display-name', displayName.trim());

      // Persist autopilot + hub-join preferences
      const policyData = writeSavedCollateralPolicy({
        mode: 'autopilot',
        softLimitUsd: toUsdInt(softLimitUsd, defaultSoftLimitUsd),
        hardLimitUsd: toUsdInt(hardLimitUsd, defaultHardLimitUsd),
        maxFeeUsd: toUsdInt(maxFeeUsd, defaultMaxFeeUsd),
      });
      const savedJoinPreference = writeHubJoinPreference(autoJoinHubs);

      // Submit profile update via REA (valid EntityTx path)
      if (entityId && signerId) {
        const env = getEnv();
        if (env) {
          await enqueueEntityInputs(env as any, [{
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
      error = (err as Error).message || 'Setup failed';
      submitting = false;
    }
  }

  // ── Helpers ──────────────────────────────────────
  function formatEntityShort(id: string): string {
    if (!id || id.length < 12) return id || '?';
    return `${id.slice(0, 8)}...${id.slice(-4)}`;
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
  <!-- Progress bar -->
  <div class="progress">
    <div class="progress-track">
      <div class="progress-fill" style="width: {(step / 3) * 100}%"></div>
    </div>
    <div class="progress-steps">
      <span class="progress-step" class:active={step >= 1} class:done={step > 1}>1</span>
      <span class="progress-step" class:active={step >= 2} class:done={step > 2}>2</span>
      <span class="progress-step" class:active={step >= 3}>3</span>
    </div>
  </div>

  <!-- Step 1: Terms -->
  {#if step === 1}
    <div class="step">
      <h2>Welcome to xln</h2>
      <p class="subtitle">Peer-to-peer payment network with on-chain settlement</p>

      <div class="terms-box">
        <h4>Before you continue</h4>
        <ul>
          <li>Your keys are derived from your BrainVault seed — <strong>never share it</strong></li>
          <li>Bilateral accounts use cryptographic consensus — both sides sign every state change</li>
          <li>Collateral is secured on-chain via smart contracts</li>
          <li>Unsecured credit carries counterparty risk — manage your limits</li>
          <li>This is testnet software — use at your own risk</li>
        </ul>
      </div>

      <label class="checkbox-row">
        <input type="checkbox" bind:checked={termsAccepted} />
        <span>I understand and accept the risks of using this software</span>
      </label>

      <div class="actions">
        <div></div>
        <button class="btn-primary" disabled={!canProceedStep1} on:click={nextStep}>
          Continue →
        </button>
      </div>
    </div>

  <!-- Step 2: Profile -->
  {:else if step === 2}
    <div class="step">
      <h2>Your Public Profile</h2>
      <p class="subtitle">This name is visible to everyone on the network</p>

      <div class="form-group">
        <label class="form-label">Display Name</label>
        <input
          type="text"
          class="form-input"
          placeholder="e.g. Alice, CryptoShop, MyExchange"
          bind:value={displayName}
          maxlength="32"
          autofocus
        />
        <span class="form-hint">
          {displayName.trim().length}/32 — searchable in gossip, shown in accounts
        </span>
      </div>

      <div class="identity-preview">
        <div class="identity-avatar">
          {displayName.trim().slice(0, 2).toUpperCase() || '??'}
        </div>
        <div class="identity-info">
          <span class="identity-name">{displayName.trim() || 'Your Name'}</span>
          <span class="identity-id">{formatEntityShort(entityId)}</span>
        </div>
      </div>

      <div class="actions">
        <button class="btn-ghost" on:click={prevStep}>← Back</button>
        <button class="btn-primary" disabled={!canProceedStep2} on:click={nextStep}>
          Continue →
        </button>
      </div>
    </div>

  <!-- Step 3: Autopilot + Hub Join -->
  {:else if step === 3}
    <div class="step">
      <h2>Autopilot Settings</h2>
      <p class="subtitle">Set your default collateral thresholds and initial hub connectivity.</p>

      <div class="autopilot-config">
        <div class="policy-grid">
          <label class="policy-field">
            <span class="form-label">Soft Limit (USD)</span>
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
            <span class="form-label">Hard Limit (USD)</span>
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
            <span class="form-label">Max Fee (USD)</span>
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
          Default for this jurisdiction: soft=<strong>{defaultSoftLimitUsd.toLocaleString()}</strong>,
          hard=<strong>{defaultHardLimitUsd.toLocaleString()}</strong>,
          fee=<strong>{defaultMaxFeeUsd.toLocaleString()}</strong>.
          These values are used when new hub accounts are opened.
        </p>
      </div>

      <div class="manual-info">
        <label class="form-label">Initial Hub Join</label>
        <select class="hub-join-select" bind:value={autoJoinHubs}>
          {#each HUB_JOIN_OPTIONS as option}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
        <p class="form-hint">
          Auto-join uses random discovered hubs and immediately opens bilateral accounts.
        </p>
      </div>

      <div class="summary">
        <h4>Summary</h4>
        <div class="summary-row">
          <span>Name</span>
          <span class="summary-value">{displayName.trim()}</span>
        </div>
        <div class="summary-row">
          <span>Autopilot</span>
          <span class="summary-value">soft ${softLimitUsd.toLocaleString()} / hard ${hardLimitUsd.toLocaleString()} / fee ${maxFeeUsd.toLocaleString()}</span>
        </div>
        <div class="summary-row">
          <span>Hub Join</span>
          <span class="summary-value">{HUB_JOIN_OPTIONS.find(option => option.value === autoJoinHubs)?.label || 'Join hubs manually'}</span>
        </div>
        <div class="summary-row">
          <span>Entity</span>
          <span class="summary-value mono">{formatEntityShort(entityId)}</span>
        </div>
      </div>

      {#if error}
        <div class="error-msg">{error}</div>
      {/if}

      <div class="actions">
        <button class="btn-ghost" on:click={prevStep}>← Back</button>
        <button class="btn-primary" disabled={!canFinish || submitting} on:click={finish}>
          {submitting ? 'Setting up...' : 'Start Using xln →'}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .onboarding {
    max-width: 520px;
    margin: 0 auto;
    padding: 32px 24px;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: var(--theme-text-primary, #e4e4e7);
  }

  /* ── Progress ──────────────────────────── */
  .progress {
    margin-bottom: 32px;
  }
  .progress-track {
    height: 3px;
    background: var(--theme-bar-bg, #27272a);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 12px;
  }
  .progress-fill {
    height: 100%;
    background: var(--theme-accent, #fbbf24);
    border-radius: 2px;
    transition: width 0.3s ease;
  }
  .progress-steps {
    display: flex;
    justify-content: space-between;
    padding: 0 10%;
  }
  .progress-step {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    background: var(--theme-surface, #18181b);
    border: 2px solid var(--theme-surface-border, #27272a);
    color: var(--theme-text-muted, #71717a);
    transition: all 0.2s;
  }
  .progress-step.active {
    border-color: var(--theme-accent, #fbbf24);
    color: var(--theme-accent, #fbbf24);
  }
  .progress-step.done {
    background: var(--theme-accent, #fbbf24);
    border-color: var(--theme-accent, #fbbf24);
    color: #000;
  }

  /* ── Step container ────────────────────── */
  .step {
    animation: fadeIn 0.2s ease;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  h2 {
    font-size: 24px;
    font-weight: 700;
    margin: 0 0 6px 0;
    letter-spacing: -0.02em;
  }
  .subtitle {
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 14px;
    margin: 0 0 24px 0;
    line-height: 1.5;
  }

  /* ── Terms ──────────────────────────────── */
  .terms-box {
    background: var(--theme-surface, #18181b);
    border: 1px solid var(--theme-surface-border, #27272a);
    border-radius: 10px;
    padding: 16px 20px;
    margin-bottom: 20px;
  }
  .terms-box h4 {
    margin: 0 0 10px 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--theme-text-primary, #e4e4e7);
  }
  .terms-box ul {
    margin: 0;
    padding: 0 0 0 18px;
    font-size: 12px;
    color: var(--theme-text-secondary, #a1a1aa);
    line-height: 1.8;
  }
  .terms-box li {
    margin-bottom: 2px;
  }
  .terms-box strong {
    color: var(--theme-text-primary, #e4e4e7);
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-size: 13px;
    color: var(--theme-text-secondary, #a1a1aa);
    padding: 12px 0;
  }
  .checkbox-row input[type="checkbox"] {
    width: 18px;
    height: 18px;
    accent-color: var(--theme-accent, #fbbf24);
    cursor: pointer;
    flex-shrink: 0;
  }

  /* ── Form ───────────────────────────────── */
  .form-group {
    margin-bottom: 20px;
  }
  .form-label {
    display: block;
    font-size: 11px;
    font-weight: 600;
    color: var(--theme-text-muted, #71717a);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .form-input {
    width: 100%;
    padding: 12px 14px;
    background: var(--theme-input-bg, #09090b);
    border: 1px solid var(--theme-input-border, #27272a);
    border-radius: 8px;
    color: var(--theme-text-primary, #e4e4e7);
    font-size: 15px;
    transition: border-color 0.15s;
    box-sizing: border-box;
  }
  .form-input:focus {
    outline: none;
    border-color: var(--theme-input-focus, #fbbf24);
    box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.1);
  }
  .form-input::placeholder {
    color: var(--theme-text-muted, #52525b);
  }
  .form-hint {
    font-size: 11px;
    color: var(--theme-text-muted, #71717a);
    margin-top: 6px;
    line-height: 1.5;
  }
  .form-hint strong {
    color: var(--theme-accent, #fbbf24);
  }

  /* ── Identity preview ──────────────────── */
  .identity-preview {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px;
    background: var(--theme-surface, #18181b);
    border: 1px solid var(--theme-surface-border, #27272a);
    border-radius: 10px;
    margin-bottom: 20px;
  }
  .identity-avatar {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: linear-gradient(135deg, var(--theme-accent, #fbbf24), #f59e0b);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'JetBrains Mono', monospace;
    font-size: 15px;
    font-weight: 700;
    color: #000;
    flex-shrink: 0;
  }
  .identity-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .identity-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--theme-text-primary, #fafaf9);
  }
  .identity-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--theme-text-muted, #71717a);
  }

  /* ── Autopilot config ──────────────────── */
  .autopilot-config {
    padding: 16px;
    background: var(--theme-surface, #18181b);
    border: 1px solid var(--theme-surface-border, #27272a);
    border-radius: 10px;
    margin-bottom: 20px;
  }
  .policy-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 10px;
  }
  .policy-field {
    min-width: 0;
  }
  .policy-input {
    margin-top: 4px;
    font-size: 14px;
    padding: 10px 12px;
  }
  .hub-join-select {
    width: 100%;
    margin-top: 6px;
    background: var(--theme-input-bg, #09090b);
    border: 1px solid var(--theme-input-border, #27272a);
    border-radius: 8px;
    color: var(--theme-text-primary, #e4e4e7);
    font-size: 14px;
    padding: 10px 12px;
  }

  .manual-info {
    padding: 16px;
    background: var(--theme-surface, #18181b);
    border: 1px solid var(--theme-surface-border, #27272a);
    border-radius: 10px;
    margin-bottom: 20px;
  }
  @media (max-width: 720px) {
    .policy-grid {
      grid-template-columns: 1fr;
    }
  }

  /* ── Summary ───────────────────────────── */
  .summary {
    padding: 16px;
    background: var(--theme-surface, #18181b);
    border: 1px solid var(--theme-surface-border, #27272a);
    border-radius: 10px;
    margin-bottom: 20px;
  }
  .summary h4 {
    margin: 0 0 10px 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--theme-text-muted, #71717a);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .summary-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
    font-size: 13px;
    border-bottom: 1px solid var(--theme-surface-border, #1f1f23);
  }
  .summary-row:last-child {
    border-bottom: none;
  }
  .summary-row span:first-child {
    color: var(--theme-text-secondary, #a1a1aa);
  }
  .summary-value {
    color: var(--theme-text-primary, #e4e4e7);
    font-weight: 500;
  }
  .summary-value.mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
  }

  /* ── Error ──────────────────────────────── */
  .error-msg {
    padding: 10px 14px;
    background: rgba(244, 63, 94, 0.08);
    border: 1px solid rgba(244, 63, 94, 0.2);
    border-radius: 8px;
    color: #f43f5e;
    font-size: 12px;
    margin-bottom: 16px;
  }

  /* ── Actions ────────────────────────────── */
  .actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 8px;
  }
  .btn-primary {
    padding: 12px 28px;
    background: linear-gradient(135deg, var(--theme-accent, #fbbf24), #f59e0b);
    border: none;
    border-radius: 10px;
    color: #000;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    letter-spacing: -0.01em;
  }
  .btn-primary:hover:not(:disabled) {
    box-shadow: 0 4px 12px rgba(251, 191, 36, 0.3);
    transform: translateY(-1px);
  }
  .btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .btn-ghost {
    padding: 10px 18px;
    background: transparent;
    border: 1px solid var(--theme-surface-border, #27272a);
    border-radius: 8px;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-ghost:hover {
    border-color: var(--theme-card-hover-border, #3f3f46);
    color: var(--theme-text-primary, #e4e4e7);
  }
</style>
