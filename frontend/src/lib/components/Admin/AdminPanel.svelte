<script lang="ts">
  import { xlnEnvironment, getXLN, xlnFunctions } from '$lib/stores/xlnStore';

  let selectedEntityId: string = '';
  let isExecuting: boolean = false;
  let lastResult: string = '';
  let resultType: 'success' | 'error' | '' = '';

  // Get list of all entity IDs from environment
  $: entityIds = $xlnEnvironment?.eReplicas
    ? Array.from(new Set(
        Array.from($xlnEnvironment.eReplicas.keys())
          .map(key => (key as string).split(':')[0])
      )).sort()
    : [];

  // Set default selection
  $: if (entityIds.length > 0 && !selectedEntityId) {
    selectedEntityId = entityIds[0] || '';
  }

  async function triggerRebalance() {
    if (!selectedEntityId) {
      lastResult = 'Please select an entity';
      resultType = 'error';
      return;
    }

    isExecuting = true;
    lastResult = '';
    resultType = '';

    try {
      await getXLN(); // Ensure XLN is initialized
      const env = $xlnEnvironment;
      if (!env) throw new Error('Environment not ready');

      // Find signer ID for the selected entity
      let signerId = '1';
      for (const key of env.eReplicas.keys()) {
        if (key.startsWith(selectedEntityId + ':')) {
          signerId = key.split(':')[1]!;
          break;
        }
      }

      console.log(`🔄 Manual rebalance trigger for entity ${selectedEntityId} (signer: ${signerId})`);

      // Get entity state
      const replica = env.eReplicas.get(`${selectedEntityId}:${signerId}`);
      if (!replica) {
        throw new Error(`No replica found for ${selectedEntityId}:${signerId}`);
      }

      // Execute rebalance coordination logic (from entity-crontab.ts hubRebalanceHandler)
      // Calculate match amounts per token (keep as bigint for calculations)
      const tokenMatches = new Map<number, { totalDebt: bigint; totalRequested: bigint; rebalanceAmount: bigint }>();

      // Scan all accounts
      for (const [_counterpartyId, accountMachine] of replica.state.accounts.entries()) {
        for (const [tokenId, delta] of accountMachine.deltas.entries()) {
          // Net spender: has negative offdelta (owes money, has excess collateral)
          if (delta.offdelta < 0n) {
            if (!tokenMatches.has(tokenId)) {
              tokenMatches.set(tokenId, { totalDebt: 0n, totalRequested: 0n, rebalanceAmount: 0n });
            }
            const match = tokenMatches.get(tokenId)!;
            const debtAmount = BigInt(delta.offdelta.toString()) * -1n; // Make positive
            match.totalDebt += debtAmount;
          }

          // Net receiver: requested rebalance
          const requestedRebalance = accountMachine.requestedRebalance.get(tokenId);
          if (requestedRebalance && requestedRebalance > 0n) {
            if (!tokenMatches.has(tokenId)) {
              tokenMatches.set(tokenId, { totalDebt: 0n, totalRequested: 0n, rebalanceAmount: 0n });
            }
            const match = tokenMatches.get(tokenId)!;
            match.totalRequested += requestedRebalance;
          }
        }
      }

      // Calculate rebalance amounts
      for (const match of tokenMatches.values()) {
        match.rebalanceAmount = match.totalDebt < match.totalRequested ? match.totalDebt : match.totalRequested;
      }

      // Format result
      let resultLines: string[] = [];
      resultLines.push(`Rebalance Analysis for Entity ${selectedEntityId.slice(-8)}:\n`);

      if (tokenMatches.size === 0) {
        resultLines.push('✓ No rebalance needed');
        resultType = 'success';
      } else {
        for (const [tokenId, match] of tokenMatches.entries()) {
          if (match.rebalanceAmount > 0n) {
            resultLines.push(`\nToken ${tokenId}:`);
            resultLines.push(`  Net spenders owe: ${match.totalDebt.toString()}`);
            resultLines.push(`  Net receivers want: ${match.totalRequested.toString()}`);
            resultLines.push(`  ✓ Can rebalance: ${match.rebalanceAmount.toString()}`);
            resultLines.push(`  Coverage: ${Number(match.rebalanceAmount * 100n) / Number(match.totalRequested || 1n)}%`);
          }
        }
        resultLines.push(`\nℹ️  In production, hub would:`);
        resultLines.push(`  1. Request withdrawal sigs from net-spenders`);
        resultLines.push(`  2. Atomic batch: C→R withdrawals + R→C deposits`);
        resultLines.push(`  3. Broadcast to chain`);

        resultType = 'success';
      }

      lastResult = resultLines.join('\n');

    } catch (error) {
      console.error('Failed to trigger rebalance:', error);
      lastResult = `Error: ${(error as Error)?.message}`;
      resultType = 'error';
    } finally {
      isExecuting = false;
    }
  }
</script>

<div class="admin-panel">
  <h3>🔧 Admin Controls</h3>
  <p class="panel-description">
    Manual rebalance trigger (following 2019src.txt logic)
  </p>

  <div class="control-group">
    <label for="entity-select">Hub Entity:</label>
    <select id="entity-select" bind:value={selectedEntityId} disabled={isExecuting}>
      {#each entityIds as entityId}
        {#if entityId}
          <option value={entityId}>
            {entityId}
          </option>
        {/if}
      {/each}
    </select>
  </div>

  <div class="control-group">
    <button
      class="trigger-button"
      on:click={triggerRebalance}
      disabled={isExecuting || !selectedEntityId}
    >
      {isExecuting ? '⏳ Analyzing...' : '🔄 Analyze Rebalance'}
    </button>
  </div>

  {#if lastResult}
    <div class="result {resultType}">
      <pre>{lastResult}</pre>
    </div>
  {/if}
</div>

<style>
  .admin-panel {
    background: rgba(40, 40, 45, 0.95);
    border: 1px solid rgba(100, 100, 110, 0.3);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }

  h3 {
    margin: 0 0 8px 0;
    font-size: 16px;
    color: #e0e0e0;
  }

  .panel-description {
    font-size: 12px;
    color: #999;
    margin: 0 0 16px 0;
    line-height: 1.4;
  }

  .control-group {
    margin-bottom: 12px;
  }

  label {
    display: block;
    font-size: 12px;
    color: #ccc;
    margin-bottom: 4px;
  }

  select {
    width: 100%;
    padding: 8px;
    background: rgba(30, 30, 35, 0.8);
    border: 1px solid rgba(100, 100, 110, 0.4);
    border-radius: 4px;
    color: #e0e0e0;
    font-size: 12px;
    font-family: 'Courier New', monospace;
  }

  select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .trigger-button {
    width: 100%;
    padding: 10px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border: none;
    border-radius: 4px;
    color: white;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .trigger-button:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
  }

  .trigger-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .result {
    margin-top: 12px;
    padding: 12px;
    border-radius: 4px;
    font-size: 11px;
    line-height: 1.5;
  }

  .result.success {
    background: rgba(72, 187, 120, 0.1);
    border: 1px solid rgba(72, 187, 120, 0.3);
  }

  .result.error {
    background: rgba(245, 101, 101, 0.1);
    border: 1px solid rgba(245, 101, 101, 0.3);
  }

  .result pre {
    margin: 0;
    color: #e0e0e0;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-family: 'Courier New', monospace;
    font-size: 11px;
  }
</style>
