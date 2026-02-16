<!--
  OnboardingPanel.svelte — Post-BrainVault setup (step 2)

  Shown once after first runtime creation. User must:
  1. Accept terms & conditions
  2. Set a public display name (gossip-visible, searchable)
  3. Choose collateral policy: Autopilot (default) or Manual

  After completion, profile is broadcast via gossip and the flag
  `onboardingComplete` is persisted in localStorage.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { settings, settingsOperations } from '../../stores/settingsStore';
  import { xlnFunctions } from '../../stores/xlnStore';

  export let entityId: string = '';
  export let signerId: string = '';

  const dispatch = createEventDispatcher();

  // ── State ────────────────────────────────────────
  let step = 1; // 1=terms, 2=profile, 3=policy
  let termsAccepted = false;
  let displayName = '';
  let policyMode: 'autopilot' | 'manual' = 'autopilot';
  let softLimitUsd = 500;
  let submitting = false;
  let error = '';

  const SOFT_LIMIT_OPTIONS = [
    { label: '$100', value: 100 },
    { label: '$500', value: 500 },
    { label: '$1,000', value: 1000 },
    { label: '$5,000', value: 5000 },
    { label: '$10,000', value: 10000 },
  ];

  // ── Validation ───────────────────────────────────
  $: canProceedStep1 = termsAccepted;
  $: canProceedStep2 = displayName.trim().length >= 2;
  $: canFinish = termsAccepted && displayName.trim().length >= 2;

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
      // Persist onboarding flag
      localStorage.setItem('xln-onboarding-complete', 'true');

      // Persist display name
      localStorage.setItem('xln-display-name', displayName.trim());

      // Persist policy preference
      const policyData = {
        mode: policyMode,
        softLimitUsd: policyMode === 'autopilot' ? softLimitUsd : 0,
        softLimitWei: policyMode === 'autopilot' ? String(BigInt(softLimitUsd) * 10n ** 18n) : '0',
        timestamp: Date.now(),
      };
      localStorage.setItem('xln-collateral-policy', JSON.stringify(policyData));

      // Broadcast profile via gossip (name update)
      if ($xlnFunctions?.isReady && entityId && signerId) {
        try {
          const xln = $xlnFunctions;
          if (xln.enqueueRuntimeInput) {
            // Queue governance profile update
            const env = xln.getEnv?.();
            if (env) {
              xln.enqueueRuntimeInput(env, {
                runtimeTxs: [],
                entityInputs: [{
                  entityId,
                  signerId,
                  entityTxs: [{
                    type: 'governance_profile_update',
                    data: {
                      profile: {
                        entityId,
                        name: displayName.trim(),
                        bio: '',
                        website: '',
                      },
                    },
                  }],
                }],
              });
            }
          }
        } catch (err) {
          console.warn('[Onboarding] Profile broadcast failed (non-fatal):', err);
        }
      }

      dispatch('complete', {
        displayName: displayName.trim(),
        policyMode,
        softLimitUsd,
        softLimitWei: policyMode === 'autopilot' ? BigInt(softLimitUsd) * 10n ** 18n : 0n,
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

  export function isOnboardingComplete(): boolean {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('xln-onboarding-complete') === 'true';
  }

  export function getSavedPolicy(): { mode: string; softLimitUsd: number; softLimitWei: string } | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem('xln-collateral-policy');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
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

  <!-- Step 3: Collateral Policy -->
  {:else if step === 3}
    <div class="step">
      <h2>Collateral Policy</h2>
      <p class="subtitle">How should hubs secure your funds?</p>

      <div class="policy-cards">
        <button
          class="policy-card"
          class:selected={policyMode === 'autopilot'}
          on:click={() => policyMode = 'autopilot'}
        >
          <div class="policy-icon">🤖</div>
          <div class="policy-body">
            <h4>Autopilot</h4>
            <p>Hub automatically secures funds on-chain when your unsecured balance exceeds a threshold</p>
          </div>
          <div class="policy-check" class:checked={policyMode === 'autopilot'}>✓</div>
        </button>

        <button
          class="policy-card"
          class:selected={policyMode === 'manual'}
          on:click={() => policyMode = 'manual'}
        >
          <div class="policy-icon">🎛️</div>
          <div class="policy-body">
            <h4>Manual</h4>
            <p>You decide when to request collateral. Full control, requires more attention.</p>
          </div>
          <div class="policy-check" class:checked={policyMode === 'manual'}>✓</div>
        </button>
      </div>

      {#if policyMode === 'autopilot'}
        <div class="autopilot-config">
          <label class="form-label">Risk tolerance (max unsecured per hub)</label>
          <div class="limit-options">
            {#each SOFT_LIMIT_OPTIONS as opt}
              <button
                class="limit-btn"
                class:active={softLimitUsd === opt.value}
                on:click={() => softLimitUsd = opt.value}
              >
                {opt.label}
              </button>
            {/each}
          </div>
          <p class="form-hint">
            When unsecured balance exceeds <strong>${softLimitUsd.toLocaleString()}</strong>,
            the hub will automatically move funds to on-chain collateral.
            A small fee applies per rebalance (paid from your custody balance).
          </p>
        </div>
      {:else}
        <div class="manual-info">
          <p class="form-hint">
            In manual mode, you'll see a <strong>"Request Collateral"</strong> button
            in each account. Use it whenever you want to secure funds on-chain.
          </p>
        </div>
      {/if}

      <div class="summary">
        <h4>Summary</h4>
        <div class="summary-row">
          <span>Name</span>
          <span class="summary-value">{displayName.trim()}</span>
        </div>
        <div class="summary-row">
          <span>Policy</span>
          <span class="summary-value">{policyMode === 'autopilot' ? `Autopilot ($${softLimitUsd.toLocaleString()} limit)` : 'Manual'}</span>
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

  /* ── Policy cards ──────────────────────── */
  .policy-cards {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 20px;
  }
  .policy-card {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 16px;
    background: var(--theme-surface, #18181b);
    border: 2px solid var(--theme-surface-border, #27272a);
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
    color: var(--theme-text-primary, #e4e4e7);
  }
  .policy-card:hover {
    border-color: var(--theme-card-hover-border, #3f3f46);
  }
  .policy-card.selected {
    border-color: var(--theme-accent, #fbbf24);
    background: linear-gradient(135deg, rgba(251, 191, 36, 0.05) 0%, transparent 100%);
  }
  .policy-icon {
    font-size: 24px;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .policy-body {
    flex: 1;
    min-width: 0;
  }
  .policy-body h4 {
    margin: 0 0 4px 0;
    font-size: 14px;
    font-weight: 600;
  }
  .policy-body p {
    margin: 0;
    font-size: 12px;
    color: var(--theme-text-secondary, #a1a1aa);
    line-height: 1.5;
  }
  .policy-check {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid var(--theme-surface-border, #27272a);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: transparent;
    flex-shrink: 0;
    transition: all 0.15s;
    margin-top: 2px;
  }
  .policy-check.checked {
    background: var(--theme-accent, #fbbf24);
    border-color: var(--theme-accent, #fbbf24);
    color: #000;
  }

  /* ── Autopilot config ──────────────────── */
  .autopilot-config {
    padding: 16px;
    background: var(--theme-surface, #18181b);
    border: 1px solid var(--theme-surface-border, #27272a);
    border-radius: 10px;
    margin-bottom: 20px;
  }
  .limit-options {
    display: flex;
    gap: 8px;
    margin: 8px 0 12px;
    flex-wrap: wrap;
  }
  .limit-btn {
    padding: 8px 16px;
    background: var(--theme-input-bg, #09090b);
    border: 1px solid var(--theme-input-border, #27272a);
    border-radius: 8px;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }
  .limit-btn:hover {
    border-color: var(--theme-card-hover-border, #3f3f46);
    color: var(--theme-text-primary, #e4e4e7);
  }
  .limit-btn.active {
    border-color: var(--theme-accent, #fbbf24);
    color: var(--theme-accent, #fbbf24);
    background: rgba(251, 191, 36, 0.06);
  }

  .manual-info {
    padding: 16px;
    background: var(--theme-surface, #18181b);
    border: 1px solid var(--theme-surface-border, #27272a);
    border-radius: 10px;
    margin-bottom: 20px;
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
