<script lang="ts">
  /**
   * RuntimeTab - Simplified runtime state viewer
   *
   * Shows frame info, solvency summary, and event log.
   * Lighter than full RuntimeIOPanel for XLNInspector use.
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import type { Writable } from 'svelte/store';
  import { shortAddress } from '$lib/utils/format';
  import type { LogLevel, LogCategory, FrameLogEntry } from '$lib/types/ui';

  interface Props {
    isolatedEnv: Writable<any>;
    isolatedHistory?: Writable<any[]> | undefined;
    isolatedTimeIndex?: Writable<number> | undefined;
  }

  let {
    isolatedEnv,
    isolatedHistory = undefined,
    isolatedTimeIndex = undefined
  }: Props = $props();

  // Log filtering state
  let activeLevels = $state(new Set<LogLevel>(['info', 'warn', 'error']));
  let showLogs = $state(true);

  // Level colors
  const levelColors: Record<LogLevel, string> = {
    trace: '#6e7681',
    debug: '#8b949e',
    info: '#58a6ff',
    warn: '#d29922',
    error: '#f85149'
  };

  // Category icons
  const categoryIcons: Record<LogCategory, string> = {
    consensus: '\u{1F517}',
    account: '\u{1F91D}',
    jurisdiction: '\u{2696}\u{FE0F}',
    evm: '\u{26D3}\u{FE0F}',
    network: '\u{1F4E1}',
    ui: '\u{1F5A5}\u{FE0F}',
    system: '\u{2699}\u{FE0F}'
  };

  // Get current frame based on time machine index
  const currentFrame = $derived.by(() => {
    const timeIdx = isolatedTimeIndex ? $isolatedTimeIndex : -1;
    const hist = isolatedHistory ? $isolatedHistory : [];
    const env = $isolatedEnv;

    if (timeIdx != null && timeIdx >= 0 && hist && hist.length > 0) {
      const idx = Math.min(timeIdx, hist.length - 1);
      return hist[idx];
    }
    // Fallback to live state
    if (env?.history && env.history.length > 0) {
      return env.history[env.history.length - 1];
    }
    return null;
  });

  // Frame logs
  const frameLogs = $derived((currentFrame?.logs || []) as FrameLogEntry[]);
  const filteredLogs = $derived(
    frameLogs.filter((log: FrameLogEntry) => activeLevels.has(log.level))
  );

  // Entity/replica counts
  const replicaCount = $derived(currentFrame?.eReplicas?.size || 0);
  const jCount = $derived(
    currentFrame?.jReplicas instanceof Map
      ? currentFrame.jReplicas.size
      : (currentFrame?.jReplicas ? Object.keys(currentFrame.jReplicas).length : 0)
  );

  // Solvency calculation
  const solvency = $derived.by(() => {
    if (!currentFrame?.eReplicas) return { reserves: 0n, collateral: 0n, total: 0n };

    let reserves = 0n;
    let collateral = 0n;

    const replicas = currentFrame.eReplicas instanceof Map
      ? Array.from(currentFrame.eReplicas.values())
      : Object.values(currentFrame.eReplicas || {});

    for (const replica of replicas) {
      // Sum reserves
      const res = (replica as any).state?.reserves;
      if (res instanceof Map) {
        for (const amt of res.values()) {
          reserves += BigInt(amt || 0);
        }
      }
      // Sum collateral from accounts
      const accts = (replica as any).state?.accounts;
      if (accts instanceof Map) {
        for (const acct of accts.values()) {
          const deltas = (acct as any).deltas;
          if (deltas instanceof Map) {
            for (const delta of deltas.values()) {
              collateral += BigInt((delta as any).collateral || 0);
            }
          }
        }
      }
    }

    return { reserves, collateral, total: reserves + collateral };
  });

  // Format for display
  function formatM(val: bigint): string {
    const num = Number(val) / 1e24;
    return num < 1 ? num.toFixed(2) : num.toFixed(1);
  }

  // Toggle log level
  function toggleLevel(level: LogLevel) {
    if (activeLevels.has(level)) {
      activeLevels.delete(level);
    } else {
      activeLevels.add(level);
    }
    activeLevels = new Set(activeLevels);
  }

  // Safe stringify
  function safeStringify(obj: any): string {
    return JSON.stringify(obj, (_, value) => {
      if (typeof value === 'bigint') return value.toString() + 'n';
      if (value instanceof Map) return Object.fromEntries(value);
      return value;
    }, 2);
  }
</script>

<div class="runtime-tab">
  <!-- Frame Info -->
  <div class="section frame-info">
    <div class="section-header">
      <h4>Frame {currentFrame?.height || 0}</h4>
      <span class="meta">
        {replicaCount} entities | {jCount} jurisdictions
      </span>
    </div>
    {#if currentFrame?.timestamp}
      <div class="timestamp">
        {new Date(currentFrame.timestamp).toLocaleTimeString()}
      </div>
    {/if}
  </div>

  <!-- Solvency Summary -->
  <div class="section solvency">
    <div class="section-header">
      <h4>Solvency</h4>
      <span class="status" class:ok={solvency.total > 0n}>
        {solvency.total > 0n ? 'OK' : 'Empty'}
      </span>
    </div>
    <div class="solvency-grid">
      <div class="solvency-item">
        <span class="label">Reserves</span>
        <span class="value">${formatM(solvency.reserves)}M</span>
      </div>
      <div class="solvency-item">
        <span class="label">Collateral</span>
        <span class="value">${formatM(solvency.collateral)}M</span>
      </div>
      <div class="solvency-item total">
        <span class="label">Total</span>
        <span class="value">${formatM(solvency.total)}M</span>
      </div>
    </div>
  </div>

  <!-- Event Log -->
  <div class="section logs">
    <div class="section-header">
      <h4>Events ({filteredLogs.length})</h4>
      <div class="log-filters">
        {#each ['info', 'warn', 'error'] as level}
          <button
            class="filter-btn"
            class:active={activeLevels.has(level as LogLevel)}
            style="--level-color: {levelColors[level as LogLevel]}"
            onclick={() => toggleLevel(level as LogLevel)}
          >
            {level}
          </button>
        {/each}
      </div>
    </div>

    <div class="log-list">
      {#if filteredLogs.length === 0}
        <div class="empty">No events matching filters</div>
      {:else}
        {#each filteredLogs.slice(0, 50) as log}
          <details class="log-item">
            <summary style="--level-color: {levelColors[log.level]}">
              <span class="log-id">#{log.id}</span>
              <span class="log-cat">{categoryIcons[log.category]}</span>
              <span class="log-msg">{log.message}</span>
            </summary>
            {#if log.data}
              <pre class="log-data">{safeStringify(log.data)}</pre>
            {/if}
          </details>
        {/each}
        {#if filteredLogs.length > 50}
          <div class="more">+{filteredLogs.length - 50} more events</div>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .runtime-tab {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .section {
    background: var(--bg-secondary, #161b22);
    border: 1px solid var(--border-primary, #30363d);
    border-radius: 8px;
    padding: 12px;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .section-header h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary, #e6edf3);
  }

  .meta {
    font-size: 12px;
    color: var(--text-secondary, #8b949e);
  }

  .timestamp {
    font-size: 12px;
    color: var(--text-secondary, #8b949e);
  }

  .status {
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    background: var(--bg-tertiary, #21262d);
    color: var(--text-secondary, #8b949e);
  }

  .status.ok {
    background: rgba(63, 185, 80, 0.15);
    color: #3fb950;
  }

  .solvency-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }

  .solvency-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8px;
    background: var(--bg-tertiary, #21262d);
    border-radius: 6px;
  }

  .solvency-item .label {
    font-size: 11px;
    color: var(--text-secondary, #8b949e);
    margin-bottom: 2px;
  }

  .solvency-item .value {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary, #e6edf3);
  }

  .solvency-item.total {
    background: rgba(31, 111, 235, 0.15);
  }

  .solvency-item.total .value {
    color: var(--accent-blue, #58a6ff);
  }

  .log-filters {
    display: flex;
    gap: 4px;
  }

  .filter-btn {
    padding: 2px 8px;
    border: 1px solid var(--border-primary, #30363d);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary, #8b949e);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .filter-btn.active {
    background: var(--level-color);
    color: white;
    border-color: var(--level-color);
  }

  .log-list {
    max-height: 300px;
    overflow-y: auto;
  }

  .log-item {
    margin-bottom: 2px;
  }

  .log-item summary {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: var(--bg-tertiary, #21262d);
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    border-left: 3px solid var(--level-color);
  }

  .log-item summary:hover {
    background: var(--bg-hover, #30363d);
  }

  .log-id {
    color: var(--text-secondary, #8b949e);
    font-family: monospace;
  }

  .log-cat {
    font-size: 11px;
  }

  .log-msg {
    flex: 1;
    color: var(--text-primary, #e6edf3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .log-data {
    margin: 4px 0 0 12px;
    padding: 8px;
    background: var(--bg-primary, #0d1117);
    border-radius: 4px;
    font-size: 11px;
    font-family: 'SF Mono', Consolas, monospace;
    overflow-x: auto;
    max-height: 150px;
  }

  .empty, .more {
    padding: 12px;
    text-align: center;
    color: var(--text-secondary, #8b949e);
    font-size: 12px;
  }
</style>
