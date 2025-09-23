<script lang="ts">
  import { getXLN, xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
  import { timeState } from '../../stores/timeStore';

  let isCollapsed = false;

  function toggleCollapse() {
    isCollapsed = !isCollapsed;
  }

  // Reactive data for server I/O
  $: currentSnapshot = $timeState.isLive ? null : $xlnEnvironment?.history?.[$timeState.currentTimeIndex];
  $: serverInput = currentSnapshot?.serverInput || { serverTxs: [], entityInputs: [] };
  $: serverOutputs = currentSnapshot?.serverOutputs || [];

  // Enhanced JSON stringify function with proper formatting
  function elaborateStringify(obj: any, maxDepth: number = 10): string {
    try {
      return JSON.stringify(obj, (key, value) => {
        // Handle BigInt
        if (typeof value === 'bigint') {
          return `BigInt(${value.toString()})`;
        }
        // Handle Map objects
        if (value instanceof Map) {
          return Object.fromEntries(value);
        }
        // Handle Set objects
        if (value instanceof Set) {
          return Array.from(value);
        }
        // Handle Buffer objects
        if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
          return `Buffer(${value.data.length} bytes)`;
        }
        // Handle Functions
        if (typeof value === 'function') {
          return `[Function: ${value.name || 'anonymous'}]`;
        }
        return value;
      }, 2);
    } catch (err) {
      return `[Error stringifying: ${err.message}]`;
    }
  }

  let showJsonDetails = {
    serverTxs: false,
    entityInputs: false,
    entityOutputs: false
  };

  function toggleJsonDetails(section: keyof typeof showJsonDetails) {
    showJsonDetails[section] = !showJsonDetails[section];
  }
</script>

<div class="history-io-section">
  <div class="history-header">
    <h3>📊 Transaction History & I/O</h3>
    <button class="collapse-btn" on:click={toggleCollapse} class:collapsed={isCollapsed}>
      {isCollapsed ? '▶' : '▼'}
    </button>
  </div>
  
  {#if !isCollapsed}
    <div class="history-content">
      <div class="server-io-container">
        <div class="server-column">
          <div class="server-column-header">
            📨 Server Input (What's happening this tick)
            <span class="status-indicator">
              {$timeState.isLive ? '⚡ Current' : '🕰️ Historical'}
            </span>
          </div>
          
          <div class="server-section">
            <div class="section-header">
              <h4>🖥️ Server Transactions</h4>
              <button class="json-toggle-btn" on:click={() => toggleJsonDetails('serverTxs')}>
                {showJsonDetails.serverTxs ? '📋 Hide JSON' : '🔍 Show JSON'}
              </button>
            </div>
            <div class="server-txs-list">
              {#if serverInput.serverTxs.length > 0}
                {#each serverInput.serverTxs as tx, index}
                  <div class="input-item">
                    <div class="summary-line">
                      <strong>🖥️ {tx.type}</strong>: {tx.entityId}:{tx.signerId}
                      {tx.data.isProposer ? ' (👑 Proposer)' : ' (✅ Validator)'}
                    </div>
                    {#if showJsonDetails.serverTxs}
                      <div class="json-details">
                        <div class="json-header">Full ServerTx #{index + 1} JSON:</div>
                        <pre class="json-content">{elaborateStringify(tx)}</pre>
                      </div>
                    {/if}
                  </div>
                {/each}
              {:else}
                <div class="no-inputs">No server transactions</div>
              {/if}
            </div>
          </div>
          
          <div class="server-section">
            <div class="section-header">
              <h4>🔄 Entity Inputs</h4>
              <button class="json-toggle-btn" on:click={() => toggleJsonDetails('entityInputs')}>
                {showJsonDetails.entityInputs ? '📋 Hide JSON' : '🔍 Show JSON'}
              </button>
            </div>
            <div class="entity-inputs-list">
              {#if serverInput.entityInputs.length > 0}
                {#each serverInput.entityInputs as input, index}
                  <div class="input-item">
                    <div class="summary-line">
                      <strong>Entity #{$xlnFunctions?.getEntityNumber(input.entityId) || '?'}:{input.signerId}</strong>
                      {#if input.entityTxs && input.entityTxs.length > 0}
                        <br>📝 <strong>{input.entityTxs.length} transactions:</strong>
                        {#each input.entityTxs as tx, i}
                          <br>  {i+1}. {tx.type === 'chat' ? `💬 Chat: "${tx.data.message}"` :
                                       tx.type === 'propose' ? `📝 Propose: "${tx.data.action.data.message}"` :
                                       tx.type === 'vote' ? `🗳️ Vote: ${tx.data.choice}` : `⚙️ ${tx.type}`}
                        {/each}
                      {/if}
                    </div>
                    {#if showJsonDetails.entityInputs}
                      <div class="json-details">
                        <div class="json-header">Full EntityInput #{index + 1} JSON:</div>
                        <pre class="json-content">{elaborateStringify(input)}</pre>
                      </div>
                    {/if}
                  </div>
                {/each}
              {:else}
                <div class="no-inputs">No entity inputs</div>
              {/if}
            </div>
          </div>
        </div>
        
        <div class="server-column">
          <div class="server-column-header">
            📤 Server Output (What's being sent and where)
            <span class="status-indicator">
              {$timeState.isLive ? '⚡ Current' : '🕰️ Historical'}
            </span>
          </div>
          
          <div class="server-section">
            <div class="section-header">
              <h4>🚀 Entity Outputs</h4>
              <button class="json-toggle-btn" on:click={() => toggleJsonDetails('entityOutputs')}>
                {showJsonDetails.entityOutputs ? '📋 Hide JSON' : '🔍 Show JSON'}
              </button>
            </div>
            <div class="entity-outputs-list">
              {#if serverOutputs.length > 0}
                {#each serverOutputs as output, index}
                  <div class="input-item">
                    <div class="summary-line">
                      <strong>📤 {index + 1}. → Entity #{$xlnFunctions?.getEntityNumber(output.entityId) || '?'}:{output.signerId}</strong>
                      {#if output.entityTxs && output.entityTxs.length > 0}
                        <br>📝 <strong>{output.entityTxs.length} transactions:</strong>
                        {#each output.entityTxs as tx, i}
                          <br>  {i+1}. {tx.type === 'chat' ? `💬 Chat: "${tx.data.message}"` :
                                       tx.type === 'propose' ? `📝 Propose: "${tx.data.action.data.message}"` :
                                       tx.type === 'vote' ? `🗳️ Vote: ${tx.data.choice}` :
                                       tx.type === 'accountInput' ? `💳 AccountInput: ${tx.data.accountTx?.type || 'unknown'}` :
                                       `⚙️ ${tx.type}`}
                        {/each}
                      {/if}
                    </div>
                    {#if showJsonDetails.entityOutputs}
                      <div class="json-details">
                        <div class="json-header">Full EntityOutput #{index + 1} JSON:</div>
                        <pre class="json-content">{elaborateStringify(output)}</pre>
                      </div>
                    {/if}
                  </div>
                {/each}
              {:else}
                <div class="no-inputs">No entity outputs</div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .history-io-section {
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 8px;
    margin: 20px;
    overflow: hidden;
  }

  .history-header {
    background: #252526;
    padding: 12px 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #3e3e3e;
  }

  .history-header h3 {
    margin: 0;
    color: #d4d4d4;
    font-size: 1em;
    font-weight: 500;
  }

  .collapse-btn {
    background: none;
    border: none;
    color: #9d9d9d;
    cursor: pointer;
    font-size: 0.9em;
    transition: transform 0.2s ease;
  }

  .collapse-btn:hover {
    color: #007acc;
  }

  .collapse-btn.collapsed {
    transform: rotate(-90deg);
  }

  .history-content {
    display: block;
    transition: all 0.3s ease;
  }

  .server-io-container {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    padding: 20px;
  }

  .server-column {
    background: #1e1e1e;
    border: 1px solid #007acc;
    border-radius: 8px;
    padding: 15px;
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
    font-size: 0.85em;
    color: #d4d4d4;
  }

  .server-column-header {
    font-weight: bold;
    color: #007acc;
    margin-bottom: 15px;
    padding-bottom: 8px;
    border-bottom: 1px solid #3e3e3e;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .status-indicator {
    font-weight: normal;
    color: #9d9d9d;
    font-size: 0.85em;
  }

  .server-section {
    margin-bottom: 20px;
  }

  .server-section:last-child {
    margin-bottom: 0;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }

  .server-section h4 {
    margin: 0;
    color: #d4d4d4;
    font-size: 0.9em;
    font-weight: bold;
  }

  .json-toggle-btn {
    background: #1a1a1a;
    border: 1px solid #007acc;
    color: #007acc;
    padding: 4px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.7em;
    transition: all 0.2s ease;
  }

  .json-toggle-btn:hover {
    background: #007acc;
    color: white;
  }

  .summary-line {
    margin-bottom: 5px;
  }

  .json-details {
    margin-top: 10px;
    border-top: 1px solid #444;
    padding-top: 8px;
  }

  .json-header {
    color: #9d9d9d;
    font-size: 0.75em;
    margin-bottom: 5px;
    font-weight: bold;
  }

  .json-content {
    background: #1a1a1a;
    border: 1px solid #444;
    border-radius: 3px;
    padding: 8px;
    font-size: 0.7em;
    line-height: 1.3;
    color: #e1e1e1;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
    max-height: 300px;
    overflow-y: auto;
  }

  .input-item {
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    padding: 8px;
    margin-bottom: 8px;
    font-size: 0.8em;
    line-height: 1.4;
  }

  .input-item:last-child {
    margin-bottom: 0;
  }

  .no-inputs {
    color: #6c757d;
    font-style: italic;
    font-size: 0.85em;
    padding: 8px;
    text-align: center;
  }
</style>
