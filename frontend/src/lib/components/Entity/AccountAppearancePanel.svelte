<script lang="ts">
  import { settings, settingsOperations } from '../../stores/settingsStore';

  const ACCOUNT_BAR_USD_PER_100PX_MIN = 10;
  const ACCOUNT_BAR_USD_PER_100PX_MAX = 10_000;

  function clampAccountBarUsdPer100Px(raw: unknown): number {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return 250;
    return Math.min(ACCOUNT_BAR_USD_PER_100PX_MAX, Math.max(ACCOUNT_BAR_USD_PER_100PX_MIN, Math.round(numeric)));
  }

  function setAccountBarScale(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    settingsOperations.setAccountBarUsdPer100Px(clampAccountBarUsdPer100Px(target.value));
  }

  $: accountBarUsdPer100Px = clampAccountBarUsdPer100Px(($settings.accountBarUsdPerPx ?? 100) * 100);
</script>

<section class="account-appearance-panel">
  <div class="appearance-card">
    <div class="appearance-head">
      <div>
        <h4 class="section-head">Account Bars</h4>
        <p class="muted">Layout and scale for capacity bars.</p>
      </div>
    </div>

    <div class="appearance-block">
      <span class="appearance-label">Layout</span>
      <div class="appearance-pill-group" role="tablist" aria-label="Account bar layout">
        <button
          class="appearance-pill"
          class:active={$settings.barLayout === 'center'}
          on:click={() => settingsOperations.setBarLayout('center')}
        >
          <span class="pill-icon">&#9646;&#9646;</span> Center
        </button>
        <button
          class="appearance-pill"
          class:active={$settings.barLayout === 'sides'}
          on:click={() => settingsOperations.setBarLayout('sides')}
        >
          <span class="pill-icon">&#9664;&#9654;</span> Sides
        </button>
      </div>
    </div>

    <div class="appearance-block">
      <span class="appearance-label">Skin (A/B)</span>
      <div class="appearance-pill-group" role="tablist" aria-label="Account skin">
        <button
          class="appearance-pill"
          class:active={$settings.accountSkin === 'classic'}
          on:click={() => settingsOperations.setAccountSkin('classic')}
        >
          <span class="pill-icon">&#9776;</span> Classic
        </button>
        <button
          class="appearance-pill"
          class:active={$settings.accountSkin === 'apple'}
          on:click={() => settingsOperations.setAccountSkin('apple')}
        >
          <span class="pill-icon">&#9679;</span> Apple
        </button>
      </div>
    </div>

    {#if $settings.accountSkin === 'apple'}
      <div class="appearance-block">
        <span class="appearance-label">Bar style</span>
        <select
          class="appearance-select"
          value={$settings.accountBarStyle}
          on:change={(event) => settingsOperations.setAccountBarStyle(event.currentTarget.value as 'hairline' | 'pips' | 'twin' | 'capsule' | 'thread')}
        >
          <option value="hairline">Hairline · line + dot</option>
          <option value="pips">Pips · signal dots</option>
          <option value="twin">Twin · out / in lines</option>
          <option value="capsule">Capsule · iOS fill</option>
          <option value="thread">Thread · fine + diamond</option>
        </select>
      </div>
    {/if}

    <div class="appearance-block">
      <div class="appearance-scale-row">
        <span class="appearance-label">Scale</span>
        <div class="appearance-scale-meta">
          <span class="appearance-scale-bound">$10</span>
          <strong class="appearance-scale-value">100px = ${accountBarUsdPer100Px.toLocaleString('en-US')}</strong>
          <span class="appearance-scale-bound">$10k</span>
        </div>
      </div>
      <div class="slider-container">
        <input
          class="appearance-slider"
          type="range"
          min={ACCOUNT_BAR_USD_PER_100PX_MIN}
          max={ACCOUNT_BAR_USD_PER_100PX_MAX}
          step="10"
          value={accountBarUsdPer100Px}
          on:input={setAccountBarScale}
        />
      </div>
    </div>
  </div>

  <div class="appearance-card">
    <div class="appearance-head">
      <div>
        <h4 class="section-head">Bar Effects</h4>
        <p class="muted">Toggle visual effects on capacity bars.</p>
      </div>
    </div>

    <label class="appearance-switch-row">
      <span class="appearance-label">Credit Gradient</span>
      <span class="appearance-hint">Cap credit segments with fade-out</span>
      <input
        type="checkbox"
        class="appearance-checkbox"
        checked={$settings.barCreditGradient}
        on:change={(event) => settingsOperations.update({ barCreditGradient: event.currentTarget.checked })}
      />
    </label>

    <label class="appearance-switch-row">
      <span class="appearance-label">Smooth Resize</span>
      <span class="appearance-hint">Animate bar width changes</span>
      <input
        type="checkbox"
        class="appearance-checkbox"
        checked={$settings.barAnimTransition}
        on:change={(event) => settingsOperations.update({ barAnimTransition: event.currentTarget.checked })}
      />
    </label>

    <label class="appearance-switch-row">
      <span class="appearance-label">Sweep</span>
      <span class="appearance-hint">Light beam sweeps right-to-left on update</span>
      <input
        type="checkbox"
        class="appearance-checkbox"
        checked={$settings.barAnimSweep}
        on:change={(event) => settingsOperations.update({ barAnimSweep: event.currentTarget.checked })}
      />
    </label>

    <label class="appearance-switch-row">
      <span class="appearance-label">Glow</span>
      <span class="appearance-hint">Brightness pulse on bar change</span>
      <input
        type="checkbox"
        class="appearance-checkbox"
        checked={$settings.barAnimGlow}
        on:change={(event) => settingsOperations.update({ barAnimGlow: event.currentTarget.checked })}
      />
    </label>

    <label class="appearance-switch-row">
      <span class="appearance-label">Delta Flash</span>
      <span class="appearance-hint">Show +/- amount text overlay</span>
      <input
        type="checkbox"
        class="appearance-checkbox"
        checked={$settings.barAnimDeltaFlash}
        on:change={(event) => settingsOperations.update({ barAnimDeltaFlash: event.currentTarget.checked })}
      />
    </label>

    <label class="appearance-switch-row">
      <span class="appearance-label">Ripple</span>
      <span class="appearance-hint">Expanding ring from bar center</span>
      <input
        type="checkbox"
        class="appearance-checkbox"
        checked={$settings.barAnimRipple}
        on:change={(event) => settingsOperations.update({ barAnimRipple: event.currentTarget.checked })}
      />
    </label>
  </div>
</section>

<style>
  .account-appearance-panel {
    border: 1px solid #27272a;
    border-radius: 10px;
    background: #101114;
    padding: 14px;
  }

  .appearance-card {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .appearance-card + .appearance-card {
    margin-top: 18px;
  }

  .appearance-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
  }

  .appearance-block {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 2px;
  }

  .appearance-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #a1a1aa;
  }

  .appearance-pill-group {
    display: inline-flex;
    align-items: center;
    gap: 0;
    padding: 3px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.03);
    width: fit-content;
  }

  .appearance-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 100px;
    padding: 7px 14px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: #71717a;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .pill-icon {
    font-size: 10px;
    letter-spacing: -2px;
    opacity: 0.6;
  }

  .appearance-pill:hover {
    color: #d4d4d8;
    background: rgba(255, 255, 255, 0.04);
  }

  .appearance-pill.active {
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.12);
    box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.2) inset;
  }

  .appearance-pill.active .pill-icon {
    opacity: 1;
  }

  .appearance-select {
    margin-top: 6px;
    width: 100%;
    background: #11151a;
    color: #e5e7eb;
    border: 1px solid #2c333d;
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 12px;
  }

  .appearance-scale-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }

  .appearance-scale-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: flex-end;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }

  .appearance-scale-value {
    color: #f3f4f6;
    font-size: 13px;
    font-weight: 600;
  }

  .appearance-scale-bound {
    color: #71717a;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
  }

  .slider-container {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    padding: 0;
    box-sizing: border-box;
  }

  .appearance-slider {
    width: 100%;
  }

  .appearance-switch-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    cursor: pointer;
    user-select: none;
  }

  .appearance-switch-row .appearance-label {
    flex: 0 0 auto;
    min-width: 110px;
  }

  .appearance-hint {
    flex: 1;
    font-size: 11px;
    color: #71717a;
  }

  .appearance-checkbox {
    flex: 0 0 auto;
    cursor: pointer;
  }

  .section-head {
    margin: 0 0 12px;
    color: #f5f5f5;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.01em;
  }

  .muted {
    color: #52525b;
    line-height: 1.5;
    margin: 0 0 12px;
  }
</style>
