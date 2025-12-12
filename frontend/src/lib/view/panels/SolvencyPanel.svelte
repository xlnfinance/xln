<script lang="ts">
  /**
   * Solvency Panel - Basel-style Capital Adequacy Monitor
   *
   * Displays XLN's conservation law: Σ(reserves) = Σ(collateral)
   * Uses Basel Committee terminology for institutional credibility
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { getEntityEnv, hasEntityEnvContext } from '../components/entity/shared/EntityEnvContext';
  import type { Writable } from 'svelte/store';

  // Props (Svelte 5 runes mode)
  let { isolatedEnv = null }: { isolatedEnv?: Writable<any> | null } = $props();

  // Get environment from context (isolated stores for /view) or props
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const envStore = isolatedEnv || entityEnv?.env;

  // Real-time solvency calculation
  let solvencyData = $derived.by(() => {
    const currentEnv = envStore ? $envStore : null;
    if (!currentEnv) return null;

    // M1: Total reserves (on-chain, immediately available)
    let totalReserves = 0n;
    if (currentEnv.eReplicas) {
      for (const [_, replica] of currentEnv.eReplicas.entries()) {
        if (replica.state?.reserves) {
          for (const [_, amount] of replica.state.reserves.entries()) {
            totalReserves += amount;
          }
        }
      }
    }

    // M2: Confirmed collateral (current committed state)
    // M3: Pending collateral (in pendingFrame, awaiting finalization)
    let confirmedCollateral = 0n;
    let pendingCollateral = 0n;

    if (currentEnv.eReplicas) {
      for (const [_, replica] of currentEnv.eReplicas.entries()) {
        if (replica.state?.accounts) {
          for (const [_, account] of replica.state.accounts.entries()) {
            // Sum confirmed collateral from committed deltas
            if (account.deltas) {
              for (const [_, delta] of account.deltas.entries()) {
                confirmedCollateral += delta.collateral || 0n;
              }
            }

            // Sum pending collateral from pendingFrame (if exists)
            if (account.pendingFrame?.fullDeltaStates) {
              for (const delta of account.pendingFrame.fullDeltaStates) {
                pendingCollateral += delta.collateral || 0n;
              }
            }
          }
        }
      }
    }

    // Divide by 2 (each account counted from both entity perspectives)
    confirmedCollateral = confirmedCollateral / 2n;
    pendingCollateral = pendingCollateral / 2n;

    const totalCollateral = confirmedCollateral + pendingCollateral;
    const delta = totalReserves - totalCollateral;
    const isValid = delta === 0n;

    return {
      m1: totalReserves,        // Reserves (Basel M1 - most liquid)
      m2: confirmedCollateral,  // Confirmed collateral (Basel M2 - finalized)
      m3: pendingCollateral,    // Pending collateral (Basel M3 - in consensus)
      total: totalCollateral,
      delta,
      isValid,
      timestamp: Date.now()
    };
  });

  function formatAmount(amount: bigint): string {
    const num = Number(amount) / 1e18;
    if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
    return `$${num.toFixed(0)}`;
  }
</script>

<div class="solvency-panel glass-panel">
  <!-- Hero status -->
  <div class="hero-status" class:valid={solvencyData?.isValid}>
    <div class="status-icon">
      {solvencyData?.isValid ? '✓' : '⚠'}
    </div>
    <div class="status-text text-tiny">
      {solvencyData?.isValid ? 'SYSTEM SOLVENT' : 'IMBALANCE DETECTED'}
    </div>
  </div>

  {#if solvencyData}
    <!-- Big beautiful reserves -->
    <div class="hero-metric animate-fade-in">
      <div class="metric-label">TOTAL RESERVES</div>
      <div class="metric-value accent animate-glow">
        {formatAmount(solvencyData.m1)}
      </div>
      <div class="metric-sublabel text-small">
        M1 • On-chain liquidity
      </div>
    </div>

    <!-- Collateral breakdown -->
    <div class="collateral-grid">
      <div class="glass-card metric-card">
        <div class="metric-label">CONFIRMED</div>
        <div class="metric-value">
          {formatAmount(solvencyData.m2)}
        </div>
        <div class="text-tiny" style="color: var(--text-tertiary);">M2 • Finalized</div>
      </div>

      {#if solvencyData.m3 > 0n}
        <div class="glass-card metric-card">
          <div class="metric-label">PENDING</div>
          <div class="metric-value" style="color: var(--accent-orange);">
            {formatAmount(solvencyData.m3)}
          </div>
          <div class="text-tiny" style="color: var(--text-tertiary);">M3 • In consensus</div>
        </div>
      {/if}
    </div>

    <!-- Conservation law -->
    <div class="conservation-law glass-card">
      <div class="equation text-heading">
        M1 = M2 {#if solvencyData.m3 > 0n}+ M3{/if}
      </div>
      <div class="law-description text-small">
        Conservation law • Reserves equal total collateral
      </div>

      {#if solvencyData.delta !== 0n}
        <div class="delta-warning">
          <span class="metric-change" class:up={solvencyData.delta > 0n} class:down={solvencyData.delta < 0n}>
            {solvencyData.delta > 0n ? '+' : ''}{formatAmount(solvencyData.delta)} imbalance
          </span>
        </div>
      {/if}
    </div>

  {:else}
    <div class="empty-state text-small">
      <div style="opacity: 0.4; font-size: 2rem;">∅</div>
      <div>No solvency data</div>
    </div>
  {/if}
</div>

<style>
  .solvency-panel {
    padding: var(--space-4);
    height: 100%;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  /* Hero status indicator */
  .hero-status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--glass-highlight);
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
  }

  .hero-status.valid {
    border-color: rgba(48, 209, 88, 0.3);
  }

  .status-icon {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--font-size-xl);
    color: var(--accent-green);
  }

  .status-text {
    color: var(--text-secondary);
  }

  /* Hero metric */
  .hero-metric {
    text-align: center;
    padding: var(--space-5) var(--space-4);
  }

  .metric-sublabel {
    color: var(--text-tertiary);
    margin-top: var(--space-1);
  }

  /* Collateral grid */
  .collateral-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
  }

  .metric-card {
    padding: var(--space-3);
    text-align: center;
  }

  /* Conservation law */
  .conservation-law {
    padding: var(--space-4);
    text-align: center;
  }

  .equation {
    font-size: var(--font-size-2xl);
    font-weight: 700;
    color: var(--accent-gold);
    margin-bottom: var(--space-2);
    font-family: 'Times New Roman', serif;
    font-style: italic;
  }

  .law-description {
    color: var(--text-tertiary);
    margin-bottom: var(--space-3);
  }

  .delta-warning {
    margin-top: var(--space-3);
    display: flex;
    justify-content: center;
  }

  /* Empty state */
  .empty-state {
    padding: var(--space-8) var(--space-4);
    text-align: center;
    color: var(--text-tertiary);
  }

  /* OLD STYLES BELOW - TODO: Remove when ready */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  h3 {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 600;
    color: #fff;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .status {
    padding: 4px 12px;
    border-radius: 3px;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.5px;
  }

  .status.valid {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .status.invalid {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .metrics {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .metric-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.02);
  }

  .metric-row.m1 {
    border-left: 3px solid #3b82f6;
  }

  .metric-row.m2 {
    border-left: 3px solid #10b981;
  }

  .metric-row.m3 {
    border-left: 3px solid #f59e0b;
  }

  .metric-row.total {
    background: rgba(255, 255, 255, 0.05);
    font-weight: 600;
    border-left: 3px solid #8b5cf6;
  }

  .metric-row.delta {
    border-left: 3px solid;
  }

  .metric-row.delta.positive {
    border-left-color: #22c55e;
  }

  .metric-row.delta.negative {
    border-left-color: #ef4444;
  }

  .label {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.6);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .value {
    font-size: 0.9rem;
    font-weight: 600;
    color: #fff;
    font-variant-numeric: tabular-nums;
  }

  .value.pending {
    color: #f59e0b;
  }

  .separator {
    height: 1px;
    background: rgba(255, 255, 255, 0.1);
    margin: 4px 0;
  }

  .formula {
    margin-top: 20px;
    padding: 12px;
    background: rgba(139, 92, 246, 0.05);
    border: 1px solid rgba(139, 92, 246, 0.2);
    border-radius: 4px;
  }

  .equation {
    font-size: 0.85rem;
    font-weight: 700;
    color: #a78bfa;
    text-align: center;
    margin-bottom: 8px;
    font-family: 'Times New Roman', serif;
    font-style: italic;
  }

  .description {
    font-size: 0.65rem;
    color: rgba(255, 255, 255, 0.5);
    text-align: center;
    line-height: 1.4;
  }

  .empty {
    padding: 40px 20px;
    text-align: center;
    color: rgba(255, 255, 255, 0.3);
    font-size: 0.8rem;
  }
</style>
