<script lang="ts">
  import { onDestroy } from 'svelte';
  import { readable, type Readable } from 'svelte/store';
  import type { RuntimeReplica } from '@xln/core/api/public/runtime-module';
  import { createRuntimeQueryStore } from '$lib/stores/runtimeQueryClient';
  import { buildSolvencyProjection } from './solvency-panel-view';
  import {
    formatSolvencyAmount,
    getSolvencyStatusView,
    shortenSolvencyAddress,
  } from '../../../../../packages/runtime-client/src/solvency-panel-view';

  const emptyEnv = readable<RuntimeReplica | null>(null);

  let { runtimeFrameEnv = emptyEnv }: { runtimeFrameEnv?: Readable<RuntimeReplica | null> } = $props();

  const solvencyStore = createRuntimeQueryStore((client) => client.readSolvencySummary());
  onDestroy(() => solvencyStore.destroy());

  let solvencyData = $derived.by(() =>
    $solvencyStore.data ?? buildSolvencyProjection($runtimeFrameEnv));
  let solvencyError = $derived($solvencyStore.error);
  let solvencyStatus = $derived(getSolvencyStatusView(solvencyData?.isValid ?? null));
</script>

<div class="solvency-panel glass-panel" data-testid="solvency-panel">
  <div
    class="hero-status"
    class:valid={solvencyData?.isValid === true}
    class:unchecked={solvencyData?.isValid === null}
    data-testid="solvency-status"
  >
    <div class="status-icon">{solvencyStatus.icon}</div>
    <div class="status-text text-tiny">
      {solvencyStatus.label}
    </div>
  </div>

  {#if solvencyData?.assets.length}
    <div class="asset-list">
      {#each solvencyData.assets as asset (`${asset.stackId}:${asset.tokenId}`)}
        <section class="glass-card asset-card" class:invalid={asset.isValid === false} data-testid="solvency-asset">
          <header>
            <div class="metric-label">CHAIN {asset.chainId} · TOKEN #{asset.tokenId}</div>
            <div class="text-tiny address">{shortenSolvencyAddress(asset.depositoryAddress)}</div>
          </header>
          <div class="metric-grid">
            <div>
              <div class="metric-label">RESERVES</div>
              <div class="metric-value" data-testid="solvency-reserves">{formatSolvencyAmount(asset.reserves)}</div>
            </div>
            <div>
              <div class="metric-label">CONFIRMED COLLATERAL</div>
              <div class="metric-value" data-testid="solvency-collateral">{formatSolvencyAmount(asset.confirmedCollateral)}</div>
            </div>
          </div>
          {#if asset.isValid === false && asset.delta !== null}
            <div class="delta-warning">Raw-unit delta: {formatSolvencyAmount(asset.delta)}</div>
          {:else if asset.isValid === null}
            <div class="delta-unchecked">
              Not verified: needs the Depository total for this token
            </div>
          {/if}
        </section>
      {/each}
    </div>
  {:else if solvencyError}
    <div class="empty-state error text-small">
      <div>Solvency projection failed</div>
      <div class="error-text">{solvencyError}</div>
    </div>
  {:else}
    <div class="empty-state text-small">No asset conservation data</div>
  {/if}
</div>

<style>
  .delta-unchecked { color: var(--text-tertiary, #888); font-size: 0.85em; }
  .solvency-panel { padding: var(--space-4); height: 100%; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-4); }
  .hero-status { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); background: var(--glass-highlight); border-radius: var(--radius-md); border: 1px solid rgba(255, 69, 58, 0.4); }
  .hero-status.valid { border-color: rgba(48, 209, 88, 0.3); }
  .hero-status.unchecked { border-color: var(--glass-border); }
  .status-icon { width: 32px; height: 32px; display: grid; place-items: center; font-size: var(--font-size-xl); color: var(--accent-red); }
  .hero-status.valid .status-icon { color: var(--accent-green); }
  .hero-status.unchecked .status-icon { color: var(--text-tertiary, #888); }
  .status-text, .address, .empty-state { color: var(--text-secondary); }
  .asset-list { display: grid; gap: var(--space-3); }
  .asset-card { padding: var(--space-4); border: 1px solid var(--glass-border); }
  .asset-card.invalid { border-color: rgba(255, 69, 58, 0.45); }
  header { display: flex; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); }
  .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-3); }
  .metric-value { margin-top: var(--space-1); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .delta-warning, .empty-state.error { margin-top: var(--space-3); color: var(--accent-red); }
  .error-text { color: var(--text-secondary); overflow-wrap: anywhere; }
</style>
