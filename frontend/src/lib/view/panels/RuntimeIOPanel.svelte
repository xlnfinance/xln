<script lang="ts">
  /**
   * Runtime I/O Panel - Shows frame-by-frame input/output data
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import type { Writable } from 'svelte/store';
  import { shortAddress } from '$lib/utils/format';

  // Receive isolated env as prop (passed from View.svelte)
  export let isolatedEnv: Writable<any>;
  export let isolatedHistory: Writable<any[]> | null = null;
  export let isolatedTimeIndex: Writable<number> | null = null;

  type ViewMode = 'json' | 'structured';
  let viewMode: ViewMode = 'structured';

  // Get current frame data based on time machine index
  $: currentFrame = (() => {
    if (isolatedTimeIndex && isolatedHistory) {
      const timeIdx = $isolatedTimeIndex;
      const hist = $isolatedHistory;
      if (timeIdx != null && timeIdx >= 0 && hist && hist.length > 0) {
        const idx = Math.min(timeIdx, hist.length - 1);
        return hist[idx];
      }
    }
    // Fallback to live state
    if ($isolatedEnv && $isolatedEnv.history && $isolatedEnv.history.length > 0) {
      return $isolatedEnv.history[$isolatedEnv.history.length - 1];
    }
    return null;
  })();

  // Safe JSON stringify for BigInt values
  function safeStringify(obj: any, indent = 2): string {
    return JSON.stringify(obj, (key, value) =>
      typeof value === 'bigint' ? value.toString() + 'n' : value,
    indent);
  }

  // Extract entity transaction type display name
  function getTxTypeName(tx: any): string {
    return tx.type || 'unknown';
  }

  // Get transaction summary for structured view
  function getTxSummary(tx: any): string {
    if (!tx.data) return '';

    switch (tx.type) {
      case 'chat':
        return `"${tx.data.message}"`;
      case 'directPayment':
        return `${tx.data.amount}n tokens → ${shortAddress(tx.data.targetEntityId)}`;
      case 'openAccount':
        return `with ${shortAddress(tx.data.targetEntityId)}`;
      case 'payFromReserve':
        return `${tx.data.amount}n tokens → ${shortAddress(tx.data.targetEntityId)}`;
      case 'payToReserve':
        return `${tx.data.amount}n tokens`;
      case 'accountInput':
        return `height ${tx.data.height || '?'}`;
      default:
        return JSON.stringify(tx.data).slice(0, 60) + '...';
    }
  }
</script>

<div class="runtime-io-panel">
  <div class="header">
    <h3>🔄 Runtime I/O</h3>
    <div class="controls">
      <button
        class="view-toggle"
        class:active={viewMode === 'structured'}
        on:click={() => viewMode = 'structured'}
      >
        📊 Structured
      </button>
      <button
        class="view-toggle"
        class:active={viewMode === 'json'}
        on:click={() => viewMode = 'json'}
      >
        📝 JSON
      </button>
    </div>
  </div>

  <div class="content">
    {#if !currentFrame}
      <div class="empty-state">
        <p>⏳ No frame data available</p>
        <p class="hint">Run a scenario or create entities to see frame I/O</p>
      </div>
    {:else}
      <div class="frame-info">
        <span class="badge">Frame {currentFrame.height || 0}</span>
        <span class="timestamp">{new Date(currentFrame.timestamp).toLocaleTimeString()}</span>
        {#if currentFrame.title}
          <span class="title">{currentFrame.title}</span>
        {/if}
      </div>

      {#if viewMode === 'json'}
        <!-- JSON View -->
        <div class="json-view">
          <div class="section">
            <h4>📥 Runtime Input</h4>
            <pre class="json-block">{safeStringify(currentFrame.runtimeInput)}</pre>
          </div>

          <div class="section">
            <h4>📤 Runtime Outputs</h4>
            <pre class="json-block">{safeStringify(currentFrame.runtimeOutputs)}</pre>
          </div>
        </div>
      {:else}
        <!-- Structured View -->
        <div class="structured-view">
          <!-- INPUTS -->
          <div class="section">
            <h4>📥 Runtime Input</h4>

            {#if currentFrame.runtimeInput?.runtimeTxs?.length > 0}
              <div class="subsection">
                <h5>System Commands ({currentFrame.runtimeInput.runtimeTxs.length})</h5>
                {#each currentFrame.runtimeInput.runtimeTxs as rtx, i}
                  <div class="tx-card runtime-tx">
                    <div class="tx-header">
                      <span class="tx-index">#{i}</span>
                      <span class="tx-type">{rtx.type}</span>
                    </div>
                    <div class="tx-body">
                      <div class="tx-field">
                        <span class="label">Entity:</span>
                        <span class="value mono">{shortAddress(rtx.entityId)}</span>
                      </div>
                      <div class="tx-field">
                        <span class="label">Signer:</span>
                        <span class="value mono">{shortAddress(rtx.signerId)}</span>
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}

            {#if currentFrame.runtimeInput?.entityInputs?.length > 0}
              <div class="subsection">
                <h5>Entity Inputs ({currentFrame.runtimeInput.entityInputs.length})</h5>
                {#each currentFrame.runtimeInput.entityInputs as entityInput, i}
                  <div class="tx-card entity-input">
                    <div class="tx-header">
                      <span class="tx-index">#{i}</span>
                      <span class="entity-id mono">{shortAddress(entityInput.entityId)}</span>
                    </div>
                    <div class="tx-body">
                      <div class="tx-field">
                        <span class="label">Signer:</span>
                        <span class="value mono">{shortAddress(entityInput.signerId)}</span>
                      </div>

                      {#if entityInput.entityTxs && entityInput.entityTxs.length > 0}
                        <div class="tx-field">
                          <span class="label">Transactions:</span>
                          <span class="value">{entityInput.entityTxs.length} txs</span>
                        </div>
                        <div class="entity-txs">
                          {#each entityInput.entityTxs as etx, j}
                            <div class="entity-tx">
                              <span class="tx-type-small">{getTxTypeName(etx)}</span>
                              <span class="tx-summary">{getTxSummary(etx)}</span>
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}

            {#if (!currentFrame.runtimeInput?.runtimeTxs?.length && !currentFrame.runtimeInput?.entityInputs?.length)}
              <div class="empty-subsection">No inputs in this frame</div>
            {/if}
          </div>

          <!-- OUTPUTS -->
          <div class="section">
            <h4>📤 Runtime Outputs</h4>

            {#if currentFrame.runtimeOutputs?.length > 0}
              {#each currentFrame.runtimeOutputs as output, i}
                <div class="tx-card entity-output">
                  <div class="tx-header">
                    <span class="tx-index">#{i}</span>
                    <span class="entity-id mono">{shortAddress(output.entityId)}</span>
                    <span class="arrow">→</span>
                    <span class="output-label">Output</span>
                  </div>
                  <div class="tx-body">
                    <div class="tx-field">
                      <span class="label">Signer:</span>
                      <span class="value mono">{shortAddress(output.signerId)}</span>
                    </div>

                    {#if output.entityTxs && output.entityTxs.length > 0}
                      <div class="tx-field">
                        <span class="label">Transactions:</span>
                        <span class="value">{output.entityTxs.length} txs</span>
                      </div>
                      <div class="entity-txs">
                        {#each output.entityTxs as etx, j}
                          <div class="entity-tx">
                            <span class="tx-type-small">{getTxTypeName(etx)}</span>
                            <span class="tx-summary">{getTxSummary(etx)}</span>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              {/each}
            {:else}
              <div class="empty-subsection">No outputs in this frame</div>
            {/if}
          </div>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .runtime-io-panel {
    width: 100%;
    height: 100%;
    background: #1e1e1e;
    color: #ccc;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .header {
    padding: 12px;
    background: #2d2d30;
    border-bottom: 2px solid #007acc;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .header h3 {
    margin: 0;
    font-size: 14px;
    color: #fff;
  }

  .controls {
    display: flex;
    gap: 4px;
  }

  .view-toggle {
    padding: 4px 12px;
    background: #252526;
    border: 1px solid #3e3e3e;
    color: #ccc;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    transition: all 0.2s;
  }

  .view-toggle:hover {
    background: #37373d;
    border-color: #007acc;
  }

  .view-toggle.active {
    background: #0e639c;
    color: #fff;
    border-color: #1177bb;
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  .empty-state {
    text-align: center;
    padding: 48px 16px;
    color: #6e7681;
  }

  .empty-state p {
    margin: 8px 0;
    font-size: 14px;
  }

  .empty-state .hint {
    font-size: 12px;
    font-style: italic;
  }

  .frame-info {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 16px;
    padding: 8px 12px;
    background: #252526;
    border-left: 3px solid #007acc;
    border-radius: 4px;
  }

  .badge {
    padding: 2px 8px;
    background: #0e639c;
    color: #fff;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
  }

  .timestamp {
    font-size: 11px;
    color: #8b949e;
    font-family: monospace;
  }

  .title {
    font-size: 12px;
    color: #fff;
    font-weight: 500;
  }

  /* JSON View */
  .json-view {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .json-block {
    background: #252526;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    padding: 12px;
    margin: 0;
    font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
    font-size: 11px;
    line-height: 1.5;
    color: #d4d4d4;
    overflow-x: auto;
    white-space: pre;
  }

  /* Structured View */
  .structured-view {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .section {
    background: #252526;
    border: 1px solid #3e3e3e;
    border-radius: 6px;
    overflow: hidden;
  }

  .section h4 {
    margin: 0;
    padding: 12px;
    background: #2d2d30;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    border-bottom: 1px solid #3e3e3e;
  }

  .subsection {
    padding: 12px;
    border-bottom: 1px solid #3e3e3e;
  }

  .subsection:last-child {
    border-bottom: none;
  }

  .subsection h5 {
    margin: 0 0 12px 0;
    font-size: 12px;
    font-weight: 500;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .empty-subsection {
    padding: 24px;
    text-align: center;
    color: #6e7681;
    font-size: 12px;
    font-style: italic;
  }

  .tx-card {
    background: #1e1e1e;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    margin-bottom: 8px;
    overflow: hidden;
  }

  .tx-card:last-child {
    margin-bottom: 0;
  }

  .tx-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #2d2d30;
    border-bottom: 1px solid #3e3e3e;
  }

  .tx-index {
    padding: 2px 6px;
    background: #3e3e3e;
    color: #8b949e;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    font-family: monospace;
  }

  .tx-type {
    padding: 2px 8px;
    background: #0e639c;
    color: #fff;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 500;
  }

  .entity-id {
    color: #79c0ff;
    font-size: 11px;
  }

  .arrow {
    color: #6e7681;
    font-size: 12px;
  }

  .output-label {
    color: #8b949e;
    font-size: 11px;
  }

  .tx-body {
    padding: 12px;
  }

  .tx-field {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 11px;
  }

  .tx-field:last-child {
    margin-bottom: 0;
  }

  .tx-field .label {
    color: #8b949e;
    min-width: 80px;
  }

  .tx-field .value {
    color: #d4d4d4;
    flex: 1;
  }

  .mono {
    font-family: monospace;
  }

  .entity-txs {
    margin-top: 8px;
    padding-left: 88px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .entity-tx {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 8px;
    background: #252526;
    border-left: 2px solid #007acc;
    border-radius: 3px;
    font-size: 11px;
  }

  .tx-type-small {
    padding: 2px 6px;
    background: #3e3e3e;
    color: #79c0ff;
    border-radius: 2px;
    font-size: 10px;
    font-weight: 500;
    white-space: nowrap;
  }

  .tx-summary {
    color: #8b949e;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Custom scrollbar */
  .content::-webkit-scrollbar {
    width: 8px;
  }

  .content::-webkit-scrollbar-track {
    background: #1e1e1e;
  }

  .content::-webkit-scrollbar-thumb {
    background: #3e3e3e;
    border-radius: 4px;
  }

  .content::-webkit-scrollbar-thumb:hover {
    background: #4e4e4e;
  }
</style>
