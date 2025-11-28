<script lang="ts">
  // @ts-nocheck - TODO: Add proper types
  /**
   * EntityOperationsPanel - Full operations panel for an entity
   * Credit extensions, R2R, R2C, C2R, settlements, disputes
   */
  import { createEventDispatcher } from 'svelte';
  import type { Writable } from 'svelte/store';
  import { browserVMProvider } from '../utils/browserVMProvider';

  export let entityId: string;
  export let entityName: string = '';
  export let isolatedEnv: Writable<any>;
  export let isolatedHistory: Writable<any[]>;

  const dispatch = createEventDispatcher();

  let env: any;
  $: env = $isolatedEnv;

  // Find replica
  $: replica = env?.replicas ?
    Array.from(env.replicas.entries()).find(([key]: [string, any]) => key.startsWith(entityId + ':'))?.[1]
    : null;

  $: reserves = replica?.state?.reserves?.get('1') || 0n;
  $: accounts = replica?.state?.accounts ? Array.from(replica.state.accounts.entries()) : [];

  // Get all entities for dropdowns
  $: allEntities = env?.replicas ? Array.from(env.replicas.entries()) : [];

  // Form state
  let activeTab: 'overview' | 'r2r' | 'r2c' | 'credit' | 'settle' | 'dispute' = 'overview';

  // R2R form
  let r2rTarget = '';
  let r2rAmount = '';

  // R2C form
  let r2cCounterparty = '';
  let r2cAmount = '';

  // Credit form
  let creditCounterparty = '';
  let creditLimit = '';

  // Operations
  let isProcessing = false;
  let lastResult = '';

  function formatAmount(amount: bigint): string {
    const num = Number(amount) / 1e18;
    return num.toFixed(2);
  }

  function parseAmount(str: string): bigint {
    const num = parseFloat(str) || 0;
    return BigInt(Math.floor(num * 1e18));
  }

  async function executeR2R() {
    if (!r2rTarget || !r2rAmount) return;
    isProcessing = true;
    lastResult = '';

    try {
      const amount = parseAmount(r2rAmount);
      await browserVMProvider.reserveToReserve(entityId, r2rTarget, 1, amount);
      lastResult = `✅ Transferred ${r2rAmount} USDC to ${r2rTarget.slice(0, 10)}...`;

      // Update local state
      dispatch('stateChange', { type: 'r2r', from: entityId, to: r2rTarget, amount });
    } catch (err: any) {
      lastResult = `❌ ${err.message}`;
    } finally {
      isProcessing = false;
    }
  }

  async function executeR2C() {
    if (!r2cCounterparty || !r2cAmount) return;
    isProcessing = true;
    lastResult = '';

    try {
      const amount = parseAmount(r2cAmount);
      await browserVMProvider.prefundAccount(entityId, r2cCounterparty, 1, amount);
      lastResult = `✅ Prefunded ${r2cAmount} USDC to account with ${r2cCounterparty.slice(0, 10)}...`;

      dispatch('stateChange', { type: 'r2c', entity: entityId, counterparty: r2cCounterparty, amount });
    } catch (err: any) {
      lastResult = `❌ ${err.message}`;
    } finally {
      isProcessing = false;
    }
  }

  async function setCreditLimit() {
    if (!creditCounterparty || !creditLimit) return;
    isProcessing = true;
    lastResult = '';

    try {
      // Credit limits are off-chain (runtime state)
      const limit = parseAmount(creditLimit);
      const acc = replica?.state?.accounts?.get(creditCounterparty);
      if (acc) {
        acc.globalCreditLimits = acc.globalCreditLimits || { ownLimit: 0n, peerLimit: 0n };
        acc.globalCreditLimits.ownLimit = limit;
        lastResult = `✅ Credit limit set to ${creditLimit} USDC for ${creditCounterparty.slice(0, 10)}...`;
        dispatch('stateChange', { type: 'credit', entity: entityId, counterparty: creditCounterparty, limit });
      } else {
        lastResult = `❌ No account found with ${creditCounterparty.slice(0, 10)}...`;
      }
    } catch (err: any) {
      lastResult = `❌ ${err.message}`;
    } finally {
      isProcessing = false;
    }
  }

  function close() {
    dispatch('close');
  }
</script>

<div class="operations-panel">
  <div class="header">
    <h2>{entityName || entityId.slice(0, 12) + '...'}</h2>
    <button class="close-btn" on:click={close}>×</button>
  </div>

  <div class="tabs">
    <button class:active={activeTab === 'overview'} on:click={() => activeTab = 'overview'}>Overview</button>
    <button class:active={activeTab === 'r2r'} on:click={() => activeTab = 'r2r'}>R2R</button>
    <button class:active={activeTab === 'r2c'} on:click={() => activeTab = 'r2c'}>R2C</button>
    <button class:active={activeTab === 'credit'} on:click={() => activeTab = 'credit'}>Credit</button>
    <button class:active={activeTab === 'settle'} on:click={() => activeTab = 'settle'}>Settle</button>
    <button class:active={activeTab === 'dispute'} on:click={() => activeTab = 'dispute'}>Dispute</button>
  </div>

  <div class="content">
    {#if activeTab === 'overview'}
      <div class="overview">
        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-label">Reserve Balance</div>
            <div class="stat-value">{formatAmount(reserves)} USDC</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Open Accounts</div>
            <div class="stat-value">{accounts.length}</div>
          </div>
        </div>

        <div class="accounts-section">
          <h3>Bilateral Accounts</h3>
          {#if accounts.length === 0}
            <p class="empty">No accounts open</p>
          {:else}
            {#each accounts as [counterpartyId, acc]}
              {@const delta = acc.deltas?.get(1)}
              <div class="account-card">
                <div class="account-peer">{counterpartyId.slice(0, 12)}...</div>
                <div class="account-stats">
                  <span class="collateral">Collat: {formatAmount(delta?.collateral || 0n)}</span>
                  <span class="ondelta" class:positive={delta?.ondelta > 0n} class:negative={delta?.ondelta < 0n}>
                    Δ: {delta?.ondelta > 0n ? '+' : ''}{formatAmount(delta?.ondelta || 0n)}
                  </span>
                  <span class="credit">Credit: {formatAmount(acc.globalCreditLimits?.ownLimit || 0n)}</span>
                </div>
              </div>
            {/each}
          {/if}
        </div>
      </div>

    {:else if activeTab === 'r2r'}
      <div class="form-section">
        <h3>Reserve to Reserve Transfer</h3>
        <p class="description">Transfer funds directly between entity reserves (on-chain)</p>

        <div class="form-group">
          <label>Target Entity</label>
          <select bind:value={r2rTarget}>
            <option value="">Select entity...</option>
            {#each allEntities as [key, rep]}
              {#if !key.startsWith(entityId)}
                <option value={rep.state.entityId}>{rep.state.entityId.slice(0, 12)}...</option>
              {/if}
            {/each}
          </select>
        </div>

        <div class="form-group">
          <label>Amount (USDC)</label>
          <input type="number" bind:value={r2rAmount} placeholder="0.00" step="0.01" />
        </div>

        <button class="execute-btn" on:click={executeR2R} disabled={isProcessing || !r2rTarget || !r2rAmount}>
          {isProcessing ? 'Processing...' : 'Execute R2R'}
        </button>
      </div>

    {:else if activeTab === 'r2c'}
      <div class="form-section">
        <h3>Reserve to Collateral (Prefund)</h3>
        <p class="description">Move funds from reserve to bilateral account collateral</p>

        <div class="form-group">
          <label>Counterparty</label>
          <select bind:value={r2cCounterparty}>
            <option value="">Select counterparty...</option>
            {#each accounts as [counterpartyId]}
              <option value={counterpartyId}>{counterpartyId.slice(0, 12)}...</option>
            {/each}
          </select>
        </div>

        <div class="form-group">
          <label>Amount (USDC)</label>
          <input type="number" bind:value={r2cAmount} placeholder="0.00" step="0.01" />
        </div>

        <button class="execute-btn" on:click={executeR2C} disabled={isProcessing || !r2cCounterparty || !r2cAmount}>
          {isProcessing ? 'Processing...' : 'Execute R2C'}
        </button>
      </div>

    {:else if activeTab === 'credit'}
      <div class="form-section">
        <h3>Credit Extension</h3>
        <p class="description">Set credit limit for a counterparty (allows ondelta beyond collateral)</p>

        <div class="form-group">
          <label>Counterparty</label>
          <select bind:value={creditCounterparty}>
            <option value="">Select counterparty...</option>
            {#each accounts as [counterpartyId]}
              <option value={counterpartyId}>{counterpartyId.slice(0, 12)}...</option>
            {/each}
          </select>
        </div>

        <div class="form-group">
          <label>Credit Limit (USDC)</label>
          <input type="number" bind:value={creditLimit} placeholder="0.00" step="0.01" />
        </div>

        <div class="info-box">
          <strong>How it works:</strong>
          Credit allows ondelta to exceed collateral. If peer defaults, you lose at most the collateral amount.
        </div>

        <button class="execute-btn" on:click={setCreditLimit} disabled={isProcessing || !creditCounterparty || !creditLimit}>
          {isProcessing ? 'Processing...' : 'Set Credit Limit'}
        </button>
      </div>

    {:else if activeTab === 'settle'}
      <div class="form-section">
        <h3>Cooperative Settlement</h3>
        <p class="description">Close bilateral account cooperatively (both parties sign)</p>
        <div class="info-box warning">
          Settlement requires counterparty signature. This will trigger C2R flow.
        </div>
        <p class="coming-soon">Full settlement UI coming soon...</p>
      </div>

    {:else if activeTab === 'dispute'}
      <div class="form-section">
        <h3>Dispute Resolution</h3>
        <p class="description">Unilateral close with proof (20 block challenge period)</p>
        <div class="info-box warning">
          Disputes are adversarial. Only use if cooperative settlement fails.
        </div>
        <p class="coming-soon">Full dispute UI coming soon...</p>
      </div>
    {/if}

    {#if lastResult}
      <div class="result" class:error={lastResult.startsWith('❌')}>
        {lastResult}
      </div>
    {/if}
  </div>
</div>

<style>
  .operations-panel {
    background: #1e1e1e;
    border: 1px solid #007acc;
    border-radius: 8px;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: #252526;
    border-bottom: 1px solid #333;
  }

  .header h2 {
    margin: 0;
    font-size: 16px;
    color: #fff;
  }

  .close-btn {
    background: none;
    border: none;
    color: #888;
    font-size: 20px;
    cursor: pointer;
  }

  .close-btn:hover {
    color: #ff5555;
  }

  .tabs {
    display: flex;
    background: #252526;
    border-bottom: 1px solid #333;
    overflow-x: auto;
  }

  .tabs button {
    flex: 1;
    padding: 8px 12px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: #888;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }

  .tabs button:hover {
    color: #ccc;
  }

  .tabs button.active {
    color: #007acc;
    border-bottom-color: #007acc;
  }

  .content {
    flex: 1;
    padding: 16px;
    overflow-y: auto;
  }

  .stat-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-bottom: 20px;
  }

  .stat-card {
    background: #2d2d30;
    padding: 12px;
    border-radius: 6px;
    text-align: center;
  }

  .stat-label {
    font-size: 11px;
    color: #888;
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .stat-value {
    font-size: 18px;
    color: #4ec9b0;
    font-weight: 600;
  }

  .accounts-section h3 {
    font-size: 13px;
    color: #ccc;
    margin: 0 0 10px;
  }

  .empty {
    color: #666;
    font-size: 12px;
    font-style: italic;
  }

  .account-card {
    background: #2d2d30;
    padding: 10px;
    border-radius: 4px;
    margin-bottom: 8px;
  }

  .account-peer {
    font-size: 12px;
    color: #9cdcfe;
    margin-bottom: 6px;
  }

  .account-stats {
    display: flex;
    gap: 12px;
    font-size: 11px;
  }

  .collateral { color: #dcdcaa; }
  .ondelta { color: #888; }
  .ondelta.positive { color: #4ec9b0; }
  .ondelta.negative { color: #f14c4c; }
  .credit { color: #c586c0; }

  .form-section h3 {
    margin: 0 0 8px;
    font-size: 14px;
    color: #fff;
  }

  .description {
    font-size: 12px;
    color: #888;
    margin: 0 0 16px;
  }

  .form-group {
    margin-bottom: 12px;
  }

  .form-group label {
    display: block;
    font-size: 11px;
    color: #888;
    margin-bottom: 4px;
    text-transform: uppercase;
  }

  .form-group input,
  .form-group select {
    width: 100%;
    padding: 8px 10px;
    background: #2d2d30;
    border: 1px solid #444;
    border-radius: 4px;
    color: #fff;
    font-size: 13px;
  }

  .form-group input:focus,
  .form-group select:focus {
    outline: none;
    border-color: #007acc;
  }

  .info-box {
    background: #2d2d30;
    border-left: 3px solid #007acc;
    padding: 10px;
    font-size: 12px;
    color: #ccc;
    margin-bottom: 16px;
  }

  .info-box.warning {
    border-left-color: #dcdcaa;
  }

  .execute-btn {
    width: 100%;
    padding: 10px;
    background: #007acc;
    border: none;
    border-radius: 4px;
    color: #fff;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .execute-btn:hover:not(:disabled) {
    background: #0098ff;
  }

  .execute-btn:disabled {
    background: #444;
    cursor: not-allowed;
  }

  .result {
    margin-top: 12px;
    padding: 10px;
    background: #2d4a2d;
    border-radius: 4px;
    font-size: 12px;
    color: #4ec9b0;
  }

  .result.error {
    background: #4a2d2d;
    color: #f14c4c;
  }

  .coming-soon {
    color: #666;
    font-style: italic;
    font-size: 12px;
  }
</style>
