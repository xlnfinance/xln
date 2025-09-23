<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  export let channels: Map<string, any> = new Map();
  export let entityId: string;

  interface ChannelState {
    channelId: string;
    counterparty: string;
    deltaA: bigint;
    deltaB: bigint;
    sum: bigint;
    isConserved: boolean;
    creditLimitA: bigint;
    creditLimitB: bigint;
    utilizationA: number;
    utilizationB: number;
  }

  let channelStates: ChannelState[] = [];
  let totalViolations: number = 0;
  let conservationStatus: 'valid' | 'violated' = 'valid';

  $: if (channels) {
    updateConservationView();
  }

  function updateConservationView() {
    channelStates = [];
    totalViolations = 0;

    channels.forEach((channel, channelId) => {
      // Extract deltas and limits
      const deltaA = channel.deltaA || 0n;
      const deltaB = channel.deltaB || 0n;
      const sum = deltaA + deltaB;

      const creditLimitA = channel.creditLimitA || 100000n;
      const creditLimitB = channel.creditLimitB || 100000n;

      // Calculate utilization
      const utilizationA = creditLimitA > 0n
        ? Number((BigInt(Math.abs(Number(deltaA))) * 100n) / creditLimitA)
        : 0;
      const utilizationB = creditLimitB > 0n
        ? Number((BigInt(Math.abs(Number(deltaB))) * 100n) / creditLimitB)
        : 0;

      const isConserved = sum === 0n;
      if (!isConserved) {
        totalViolations++;
      }

      channelStates.push({
        channelId,
        counterparty: channel.counterparty || 'Unknown',
        deltaA,
        deltaB,
        sum,
        isConserved,
        creditLimitA,
        creditLimitB,
        utilizationA,
        utilizationB
      });
    });

    conservationStatus = totalViolations === 0 ? 'valid' : 'violated';
  }

  function formatBigInt(value: bigint): string {
    const str = value.toString();
    const isNegative = str.startsWith('-');
    const absStr = isNegative ? str.slice(1) : str;
    const formatted = Number(absStr).toLocaleString();
    return isNegative ? `-${formatted}` : formatted;
  }

  function getUtilizationColor(utilization: number): string {
    if (utilization < 50) return '#4ade80';
    if (utilization < 75) return '#fbbf24';
    if (utilization < 90) return '#fb923c';
    return '#ef4444';
  }

  function getDeltaClass(delta: bigint): string {
    if (delta > 0n) return 'positive';
    if (delta < 0n) return 'negative';
    return 'zero';
  }
</script>

<div class="conservation-container">
  <div class="conservation-header">
    <h3>⚖️ Conservation Monitor</h3>
    <div class="conservation-status" class:valid={conservationStatus === 'valid'} class:violated={conservationStatus === 'violated'}>
      {#if conservationStatus === 'valid'}
        <span class="status-icon">✅</span>
        <span class="status-text">All Channels Conserved</span>
      {:else}
        <span class="status-icon">⚠️</span>
        <span class="status-text">{totalViolations} Violation{totalViolations !== 1 ? 's' : ''}</span>
      {/if}
    </div>
  </div>

  <div class="conservation-law">
    <div class="law-equation">
      <span class="law-symbol">Δ</span><sub>A</sub> + <span class="law-symbol">Δ</span><sub>B</sub> = 0
    </div>
    <div class="law-description">
      Conservation Law: Value cannot be created or destroyed
    </div>
  </div>

  <div class="channels-list">
    {#each channelStates as channel}
      <div class="channel-card" class:violated={!channel.isConserved}>
        <div class="channel-header">
          <span class="channel-label">Channel with {channel.counterparty.slice(0, 8)}...</span>
          <span class="conservation-indicator" class:conserved={channel.isConserved}>
            {channel.isConserved ? '⚖️' : '⚠️'}
          </span>
        </div>

        <div class="deltas-display">
          <div class="delta-item">
            <span class="delta-label">Δ<sub>A</sub></span>
            <span class="delta-value {getDeltaClass(channel.deltaA)}">
              {formatBigInt(channel.deltaA)}
            </span>
          </div>
          <div class="delta-operator">+</div>
          <div class="delta-item">
            <span class="delta-label">Δ<sub>B</sub></span>
            <span class="delta-value {getDeltaClass(channel.deltaB)}">
              {formatBigInt(channel.deltaB)}
            </span>
          </div>
          <div class="delta-operator">=</div>
          <div class="delta-item">
            <span class="delta-label">Σ</span>
            <span class="delta-value sum" class:zero={channel.sum === 0n} class:violation={channel.sum !== 0n}>
              {formatBigInt(channel.sum)}
            </span>
          </div>
        </div>

        <div class="credit-limits">
          <div class="limit-bar">
            <div class="limit-label">
              <span>Credit A:</span>
              <span>{utilizationA.toFixed(1)}%</span>
            </div>
            <div class="limit-progress">
              <div
                class="limit-fill"
                style="width: {Math.min(utilizationA, 100)}%; background: {getUtilizationColor(utilizationA)}"
              ></div>
            </div>
            <div class="limit-value">{formatBigInt(channel.creditLimitA)}</div>
          </div>

          <div class="limit-bar">
            <div class="limit-label">
              <span>Credit B:</span>
              <span>{utilizationB.toFixed(1)}%</span>
            </div>
            <div class="limit-progress">
              <div
                class="limit-fill"
                style="width: {Math.min(utilizationB, 100)}%; background: {getUtilizationColor(utilizationB)}"
              ></div>
            </div>
            <div class="limit-value">{formatBigInt(channel.creditLimitB)}</div>
          </div>
        </div>
      </div>
    {/each}

    {#if channelStates.length === 0}
      <div class="no-channels">
        No active bilateral channels
      </div>
    {/if}
  </div>

  <div class="conservation-footer">
    <span class="entity-label">Entity: {entityId.slice(0, 8)}...</span>
    <span class="physics-note">Physical conservation enforced</span>
  </div>
</div>

<style>
  .conservation-container {
    background: rgba(28, 28, 30, 0.95);
    border: 1px solid rgba(0, 122, 204, 0.3);
    border-radius: 8px;
    padding: 16px;
    margin: 16px 0;
  }

  .conservation-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .conservation-header h3 {
    margin: 0;
    color: #007acc;
    font-size: 16px;
  }

  .conservation-status {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 16px;
    font-size: 12px;
    font-weight: 500;
  }

  .conservation-status.valid {
    background: rgba(74, 222, 128, 0.1);
    color: #4ade80;
    border: 1px solid rgba(74, 222, 128, 0.3);
  }

  .conservation-status.violated {
    background: rgba(239, 68, 68, 0.1);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .conservation-law {
    background: linear-gradient(135deg, rgba(0, 122, 204, 0.1), rgba(0, 184, 217, 0.1));
    border: 1px solid rgba(0, 122, 204, 0.2);
    border-radius: 6px;
    padding: 12px;
    margin-bottom: 16px;
    text-align: center;
  }

  .law-equation {
    font-size: 18px;
    font-weight: 600;
    color: #60a5fa;
    margin-bottom: 4px;
    font-family: 'Courier New', monospace;
  }

  .law-symbol {
    font-size: 20px;
  }

  .law-description {
    font-size: 11px;
    color: #9d9d9d;
    font-style: italic;
  }

  .channels-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 400px;
    overflow-y: auto;
  }

  .channel-card {
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    padding: 12px;
    transition: all 0.2s ease;
  }

  .channel-card.violated {
    border-color: rgba(239, 68, 68, 0.3);
    background: rgba(239, 68, 68, 0.05);
  }

  .channel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .channel-label {
    font-size: 12px;
    color: #e5e7eb;
    font-weight: 500;
  }

  .conservation-indicator {
    font-size: 16px;
  }

  .conservation-indicator.conserved {
    color: #4ade80;
  }

  .deltas-display {
    display: flex;
    align-items: center;
    justify-content: space-around;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 4px;
    padding: 8px;
    margin-bottom: 12px;
    font-family: 'Courier New', monospace;
  }

  .delta-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .delta-label {
    font-size: 11px;
    color: #6b7280;
  }

  .delta-value {
    font-size: 14px;
    font-weight: 600;
  }

  .delta-value.positive {
    color: #4ade80;
  }

  .delta-value.negative {
    color: #f87171;
  }

  .delta-value.zero {
    color: #9d9d9d;
  }

  .delta-value.sum.zero {
    color: #4ade80;
  }

  .delta-value.sum.violation {
    color: #ef4444;
    animation: pulse 2s infinite;
  }

  .delta-operator {
    color: #6b7280;
    font-size: 16px;
  }

  .credit-limits {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .limit-bar {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .limit-label {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: #9d9d9d;
  }

  .limit-progress {
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }

  .limit-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .limit-value {
    font-size: 10px;
    color: #6b7280;
    text-align: right;
  }

  .no-channels {
    padding: 32px;
    text-align: center;
    color: #6b7280;
    font-size: 13px;
    font-style: italic;
  }

  .conservation-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 16px;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 11px;
  }

  .entity-label {
    color: #6b7280;
  }

  .physics-note {
    color: #60a5fa;
    font-style: italic;
  }

  @keyframes pulse {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
</style>