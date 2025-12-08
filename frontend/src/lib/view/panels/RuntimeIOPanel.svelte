<script lang="ts">
  /**
   * Runtime I/O Panel - Shows frame-by-frame input/output data
   * + FULL DATA DUMP for time machine debugging
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

  import type { LogLevel, LogCategory, FrameLogEntry } from '$lib/types/ui';

  // Expandable sections
  let expandedReplicas: Set<string> = new Set();
  let expandedXlnomies: Set<string> = new Set();
  let showFullJson = false;
  let showInputJson = false;
  let showOutputJson = false;
  let showLogs = true;

  // Log filtering
  const ALL_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];
  const ALL_CATEGORIES: LogCategory[] = ['consensus', 'account', 'jurisdiction', 'evm', 'network', 'ui', 'system'];
  let activeLevels: Set<LogLevel> = new Set(['info', 'warn', 'error']);
  let activeCategories: Set<LogCategory> = new Set(ALL_CATEGORIES);
  let logSearchText = '';

  // Toggle log level filter
  function toggleLevel(level: LogLevel) {
    if (activeLevels.has(level)) {
      activeLevels.delete(level);
    } else {
      activeLevels.add(level);
    }
    activeLevels = activeLevels;
  }

  // Toggle category filter
  function toggleCategory(cat: LogCategory) {
    if (activeCategories.has(cat)) {
      activeCategories.delete(cat);
    } else {
      activeCategories.add(cat);
    }
    activeCategories = activeCategories;
  }

  // Get filtered logs
  $: frameLogs = (currentFrame?.logs || []) as FrameLogEntry[];
  $: filteredLogs = frameLogs.filter(log => {
    if (!activeLevels.has(log.level)) return false;
    if (!activeCategories.has(log.category)) return false;
    if (logSearchText && !log.message.toLowerCase().includes(logSearchText.toLowerCase())) return false;
    return true;
  });

  // Log level colors
  const levelColors: Record<LogLevel, string> = {
    trace: '#6e7681',
    debug: '#8b949e',
    info: '#58a6ff',
    warn: '#d29922',
    error: '#f85149'
  };

  // Category icons
  const categoryIcons: Record<LogCategory, string> = {
    consensus: '🔗',
    account: '🤝',
    jurisdiction: '⚖️',
    evm: '⛓️',
    network: '📡',
    ui: '🖥️',
    system: '⚙️'
  };

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

  // Safe JSON stringify that handles BigInt and Map
  function safeStringify(obj: any, indent = 2): string {
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'bigint') return value.toString() + 'n';
      if (value instanceof Map) return Object.fromEntries(value);
      return value;
    }, indent);
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

  // Toggle replica expansion
  function toggleReplica(entityId: string) {
    if (expandedReplicas.has(entityId)) {
      expandedReplicas.delete(entityId);
    } else {
      expandedReplicas.add(entityId);
    }
    expandedReplicas = expandedReplicas; // trigger reactivity
  }

  // Convert Map to array for display
  function mapToArray(map: Map<any, any> | undefined): Array<[string, any]> {
    if (!map) return [];
    if (map instanceof Map) return Array.from(map.entries());
    if (typeof map === 'object') return Object.entries(map);
    return [];
  }

  // Format bigint for display
  function formatBigInt(val: any): string {
    if (typeof val === 'bigint') return val.toString() + 'n';
    if (typeof val === 'number') return val.toString();
    return String(val);
  }

  // Get replica count
  $: replicaCount = currentFrame?.eReplicas?.size || 0;

  // Get replicas as array
  $: replicasArray = currentFrame?.eReplicas ? mapToArray(currentFrame.eReplicas) : [];

  // Get xlnomies (J-Machine state) as array
  $: xlnomiesArray = currentFrame?.xlnomies || [];

  // Toggle xlnomy expansion
  function toggleXlnomy(name: string) {
    if (expandedXlnomies.has(name)) {
      expandedXlnomies.delete(name);
    } else {
      expandedXlnomies.add(name);
    }
    expandedXlnomies = expandedXlnomies;
  }
</script>

<div class="runtime-io-panel">
  <div class="header">
    <h3>Runtime State</h3>
    <span class="subtitle">Frame {currentFrame?.height || 0} | {replicaCount} E-replicas | {xlnomiesArray.length} J-machines</span>
  </div>

  <div class="content">
    {#if !currentFrame}
      <div class="empty-state">
        <p>⏳ No frame data</p>
      </div>
    {:else}
      <div class="full-view">
        <!-- J-Machines (Jurisdiction State) -->
        <div class="section">
          <h4>⚖️ J-Machines ({xlnomiesArray.length})</h4>
          {#if xlnomiesArray.length > 0}
            {#each xlnomiesArray as xlnomy}
              <div class="replica-card">
                <button class="replica-header" on:click={() => toggleXlnomy(xlnomy.name)}>
                  <span class="expand-icon">{expandedXlnomies.has(xlnomy.name) ? '▼' : '▶'}</span>
                  <span class="entity-id">{xlnomy.name}</span>
                  <span class="replica-summary">
                    block:{xlnomy.jMachine?.blockNumber || 0} |
                    entities:{xlnomy.jMachine?.entities?.length || 0}
                  </span>
                </button>
                {#if expandedXlnomies.has(xlnomy.name)}
                  <div class="replica-body">
                    <pre class="json-block-small">{safeStringify(xlnomy.jMachine)}</pre>
                  </div>
                {/if}
              </div>
            {/each}
          {:else}
            <div class="empty-data">No J-machines</div>
          {/if}
        </div>

        <!-- Frame Logs (Structured Logging) -->
        <div class="section">
          <button class="section-header" on:click={() => showLogs = !showLogs}>
            <span class="expand-icon">{showLogs ? '▼' : '▶'}</span>
            <h4>📋 Frame Logs ({frameLogs.length})</h4>
            {#if filteredLogs.length !== frameLogs.length}
              <span class="filter-badge">{filteredLogs.length} shown</span>
            {/if}
          </button>
          {#if showLogs}
            <div class="logs-section">
              <!-- Filter controls -->
              <div class="log-filters">
                <div class="filter-group">
                  <span class="filter-label">Level:</span>
                  {#each ALL_LEVELS as level}
                    <button
                      class="filter-chip"
                      class:active={activeLevels.has(level)}
                      style="--level-color: {levelColors[level]}"
                      on:click={() => toggleLevel(level)}
                    >
                      {level}
                    </button>
                  {/each}
                </div>
                <div class="filter-group">
                  <span class="filter-label">Category:</span>
                  {#each ALL_CATEGORIES as cat}
                    <button
                      class="filter-chip category"
                      class:active={activeCategories.has(cat)}
                      on:click={() => toggleCategory(cat)}
                    >
                      {categoryIcons[cat]} {cat}
                    </button>
                  {/each}
                </div>
                <div class="filter-group search">
                  <input
                    type="text"
                    placeholder="Search logs..."
                    bind:value={logSearchText}
                    class="log-search"
                  />
                </div>
              </div>

              <!-- Log entries -->
              <div class="log-list">
                {#if filteredLogs.length > 0}
                  {#each filteredLogs as log}
                    <div class="log-entry" style="--level-color: {levelColors[log.level]}">
                      <span class="log-level" style="color: {levelColors[log.level]}">{log.level.toUpperCase()}</span>
                      <span class="log-category">{categoryIcons[log.category]} {log.category}</span>
                      <span class="log-message">{log.message}</span>
                      {#if log.entityId}
                        <span class="log-entity">{shortAddress(log.entityId)}</span>
                      {/if}
                      {#if log.data}
                        <details class="log-data">
                          <summary>data</summary>
                          <pre>{safeStringify(log.data)}</pre>
                        </details>
                      {/if}
                    </div>
                  {/each}
                {:else if frameLogs.length > 0}
                  <div class="empty-data">No logs match filters</div>
                {:else}
                  <div class="empty-data">No logs in this frame</div>
                {/if}
              </div>
            </div>
          {/if}
        </div>

        <!-- E-Replicas (Entity State) -->
        <div class="section">
          <h4>🏛️ E-Replicas ({replicaCount})</h4>
            {#if replicasArray.length > 0}
              {#each replicasArray as [entityId, replica]}
                <div class="replica-card">
                  <button class="replica-header" on:click={() => toggleReplica(entityId)}>
                    <span class="expand-icon">{expandedReplicas.has(entityId) ? '▼' : '▶'}</span>
                    <span class="entity-id mono">{shortAddress(entityId)}</span>
                    <span class="replica-summary">
                      h:{replica.state?.height || 0} |
                      reserves:{mapToArray(replica.state?.reserves).length} |
                      accounts:{mapToArray(replica.state?.accounts).length}
                    </span>
                  </button>

                  {#if expandedReplicas.has(entityId)}
                    <div class="replica-body">
                      <!-- Basic Info -->
                      <div class="replica-section">
                        <h5>📌 Basic</h5>
                        <div class="data-row"><span>Entity ID:</span> <code>{entityId}</code></div>
                        <div class="data-row"><span>Signer:</span> <code>{replica.signerId}</code></div>
                        <div class="data-row"><span>Is Proposer:</span> {replica.isProposer}</div>
                        <div class="data-row"><span>State Height:</span> {replica.state?.height}</div>
                        <div class="data-row"><span>J-Block:</span> {replica.state?.jBlock || 0}</div>
                      </div>

                      <!-- Reserves -->
                      <div class="replica-section">
                        <h5>💰 Reserves</h5>
                        {#if mapToArray(replica.state?.reserves).length > 0}
                          <div class="data-table">
                            {#each mapToArray(replica.state?.reserves) as [tokenId, amount]}
                              <div class="data-row">
                                <span>Token {tokenId}:</span>
                                <code>{formatBigInt(amount)}</code>
                              </div>
                            {/each}
                          </div>
                        {:else}
                          <div class="empty-data">No reserves</div>
                        {/if}
                      </div>

                      <!-- Accounts (Bilateral) -->
                      <div class="replica-section">
                        <h5>🤝 Accounts (Bilateral)</h5>
                        {#if mapToArray(replica.state?.accounts).length > 0}
                          {#each mapToArray(replica.state?.accounts) as [counterparty, account]}
                            <div class="account-card">
                              <div class="account-header">↔ {shortAddress(counterparty)}</div>
                              <pre class="json-mini">{safeStringify(account)}</pre>
                            </div>
                          {/each}
                        {:else}
                          <div class="empty-data">No bilateral accounts</div>
                        {/if}
                      </div>

                      <!-- Insurance Lines -->
                      {#if replica.state?.insuranceLines?.length > 0}
                        <div class="replica-section">
                          <h5>🛡️ Insurance Lines</h5>
                          <pre class="json-mini">{safeStringify(replica.state.insuranceLines)}</pre>
                        </div>
                      {/if}

                      <!-- Debts -->
                      {#if replica.state?.debts?.length > 0}
                        <div class="replica-section">
                          <h5>💳 Debts</h5>
                          <pre class="json-mini">{safeStringify(replica.state.debts)}</pre>
                        </div>
                      {/if}

                      <!-- Mempool -->
                      {#if replica.mempool?.length > 0}
                        <div class="replica-section">
                          <h5>📦 Mempool ({replica.mempool.length} txs)</h5>
                          <pre class="json-mini">{safeStringify(replica.mempool)}</pre>
                        </div>
                      {/if}

                      <!-- Full State JSON -->
                      <div class="replica-section">
                        <h5>📝 Full State JSON</h5>
                        <pre class="json-block-small">{safeStringify(replica.state)}</pre>
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
            {:else}
              <div class="empty-data">No replicas in this frame</div>
            {/if}
          </div>

          <!-- Gossip Profiles -->
          {#if currentFrame.gossip?.profiles?.length > 0}
            <div class="section">
              <h4>📡 Gossip Profiles ({currentFrame.gossip.profiles.length})</h4>
              <pre class="json-block">{safeStringify(currentFrame.gossip.profiles)}</pre>
            </div>
          {/if}

          <!-- Runtime Input (collapsible) -->
          <div class="section">
            <button class="section-header" on:click={() => showInputJson = !showInputJson}>
              <span class="expand-icon">{showInputJson ? '▼' : '▶'}</span>
              <h4>📥 Runtime Input</h4>
            </button>
            {#if showInputJson}
              <pre class="json-block">{safeStringify(currentFrame.runtimeInput)}</pre>
            {/if}
          </div>

          <!-- Runtime Output (collapsible) -->
          <div class="section">
            <button class="section-header" on:click={() => showOutputJson = !showOutputJson}>
              <span class="expand-icon">{showOutputJson ? '▼' : '▶'}</span>
              <h4>📤 Runtime Outputs</h4>
            </button>
            {#if showOutputJson}
              <pre class="json-block">{safeStringify(currentFrame.runtimeOutputs)}</pre>
            {/if}
          </div>

          <!-- Full Frame JSON (collapsible) -->
          <div class="section">
            <button class="section-header" on:click={() => showFullJson = !showFullJson}>
              <span class="expand-icon">{showFullJson ? '▼' : '▶'}</span>
              <h4>🔬 Full Frame JSON</h4>
            </button>
            {#if showFullJson}
              <pre class="json-block">{safeStringify(currentFrame)}</pre>
            {/if}
          </div>
        </div>
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
    font-size: 13px;
    font-weight: 600;
    color: #fff;
  }

  .section-header {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    background: #2d2d30;
    border: none;
    border-bottom: 1px solid #3e3e3e;
    cursor: pointer;
    text-align: left;
  }

  .section-header:hover {
    background: #37373d;
  }

  .section-header .expand-icon {
    color: #8b949e;
    font-size: 10px;
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

  /* Full Data View Styles */
  .full-view {
    padding: 12px;
  }

  .metadata-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    background: #252526;
    padding: 12px;
    border-radius: 4px;
  }

  .meta-item {
    font-size: 12px;
  }

  .meta-item .label {
    color: #8b949e;
    margin-right: 8px;
  }

  .replica-card {
    background: #252526;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    margin-bottom: 8px;
    overflow: hidden;
  }

  .replica-header {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: #2d2d30;
    border: none;
    color: #ccc;
    cursor: pointer;
    text-align: left;
    font-size: 12px;
  }

  .replica-header:hover {
    background: #3e3e3e;
  }

  .expand-icon {
    color: #007acc;
    font-size: 10px;
  }

  .replica-summary {
    color: #6e7681;
    font-size: 11px;
    margin-left: auto;
  }

  .replica-body {
    padding: 12px;
    border-top: 1px solid #3e3e3e;
  }

  .replica-section {
    margin-bottom: 16px;
  }

  .replica-section:last-child {
    margin-bottom: 0;
  }

  .replica-section h5 {
    margin: 0 0 8px 0;
    font-size: 11px;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .data-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    font-size: 12px;
    border-bottom: 1px solid #3e3e3e;
  }

  .data-row:last-child {
    border-bottom: none;
  }

  .data-row span {
    color: #8b949e;
  }

  .data-row code {
    color: #79c0ff;
    font-family: 'Consolas', monospace;
  }

  .account-card {
    background: #1e1e1e;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    margin-bottom: 8px;
    overflow: hidden;
  }

  .account-header {
    padding: 6px 10px;
    background: #2d2d30;
    font-size: 11px;
    color: #d4d4d4;
    font-family: 'Consolas', monospace;
  }

  .json-mini {
    margin: 0;
    padding: 8px;
    font-size: 10px;
    color: #9cdcfe;
    background: #1e1e1e;
    overflow-x: auto;
    max-height: 150px;
    overflow-y: auto;
  }

  .json-block-small {
    margin: 0;
    padding: 8px;
    font-size: 10px;
    color: #9cdcfe;
    background: #1e1e1e;
    border-radius: 4px;
    overflow-x: auto;
    max-height: 200px;
    overflow-y: auto;
  }

  .empty-data {
    padding: 12px;
    text-align: center;
    color: #6e7681;
    font-size: 11px;
    font-style: italic;
  }

  .data-table {
    background: #1e1e1e;
    border-radius: 4px;
    padding: 8px;
  }

  /* Log Viewer Styles */
  .logs-section {
    padding: 12px;
  }

  .log-filters {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
    padding: 8px;
    background: #1e1e1e;
    border-radius: 4px;
  }

  .filter-group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }

  .filter-group.search {
    margin-top: 4px;
  }

  .filter-label {
    font-size: 10px;
    color: #6e7681;
    text-transform: uppercase;
    margin-right: 4px;
    min-width: 60px;
  }

  .filter-chip {
    padding: 2px 8px;
    font-size: 10px;
    background: #252526;
    border: 1px solid #3e3e3e;
    border-radius: 3px;
    color: #8b949e;
    cursor: pointer;
    transition: all 0.15s;
  }

  .filter-chip:hover {
    background: #37373d;
    border-color: #4e4e4e;
  }

  .filter-chip.active {
    background: var(--level-color, #0e639c);
    border-color: var(--level-color, #1177bb);
    color: #fff;
  }

  .filter-chip.category.active {
    background: #0e639c;
    border-color: #1177bb;
  }

  .log-search {
    flex: 1;
    min-width: 150px;
    padding: 4px 8px;
    font-size: 11px;
    background: #252526;
    border: 1px solid #3e3e3e;
    border-radius: 3px;
    color: #ccc;
  }

  .log-search:focus {
    outline: none;
    border-color: #007acc;
  }

  .filter-badge {
    margin-left: auto;
    padding: 2px 6px;
    font-size: 10px;
    background: #3e3e3e;
    color: #8b949e;
    border-radius: 3px;
  }

  .log-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 300px;
    overflow-y: auto;
  }

  .log-entry {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: #1e1e1e;
    border-left: 2px solid var(--level-color, #3e3e3e);
    border-radius: 2px;
    font-size: 11px;
  }

  .log-level {
    font-size: 9px;
    font-weight: 600;
    min-width: 40px;
    text-transform: uppercase;
  }

  .log-category {
    font-size: 10px;
    color: #8b949e;
    padding: 1px 4px;
    background: #252526;
    border-radius: 2px;
  }

  .log-message {
    flex: 1;
    color: #d4d4d4;
    word-break: break-word;
  }

  .log-entity {
    font-size: 10px;
    color: #79c0ff;
    font-family: 'Consolas', monospace;
    padding: 1px 4px;
    background: #252526;
    border-radius: 2px;
  }

  .log-data {
    width: 100%;
    margin-top: 4px;
  }

  .log-data summary {
    font-size: 10px;
    color: #6e7681;
    cursor: pointer;
  }

  .log-data pre {
    margin: 4px 0 0 0;
    padding: 6px;
    font-size: 10px;
    background: #252526;
    border-radius: 3px;
    color: #9cdcfe;
    overflow-x: auto;
  }
</style>
