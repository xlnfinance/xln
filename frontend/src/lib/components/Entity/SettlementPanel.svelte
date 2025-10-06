<script lang="ts">
  import { getXLN, xlnEnvironment, replicas } from '../../stores/xlnStore';

  export let entityId: string;

  // Form state
  let counterpartyEntityId = '';
  let tokenId = 1; // Default to token 1 (USDC)
  let mode: 'simple' | 'advanced' = 'simple';

  // Simple mode
  let simpleAction: 'fund' | 'withdraw' = 'fund';
  let simpleAmount = '';

  // Advanced mode (manual 4-diffs)
  let leftDiff = '0';
  let rightDiff = '0';
  let collateralDiff = '0';
  let ondeltaDiff = '0';

  let description = '';
  let sending = false;

  // Computed invariant validation
  $: invariantSum = BigInt(leftDiff || 0) + BigInt(rightDiff || 0) + BigInt(collateralDiff || 0);
  $: invariantValid = invariantSum === 0n;

  // Determine if we're left or right
  $: isLeft = entityId < counterpartyEntityId;
  $: ourSide = isLeft ? 'LEFT' : 'RIGHT';

  // Get all entities for dropdown
  $: allEntities = $replicas ? Array.from($replicas.keys() as IterableIterator<string>)
    .map(key => key.split(':')[0]!)
    .filter((id, index, self) => self.indexOf(id) === index && id !== entityId)
    .sort() : [];

  // Get jBatch state for this entity
  $: jBatchState = (() => {
    if (!$replicas || !entityId) return null;
    const keys = Array.from($replicas.keys()) as string[];
    const replicaKey = keys.find((k) => k.startsWith(entityId + ':'));
    if (!replicaKey) return null;
    const replica = $replicas.get(replicaKey);
    return (replica?.state as any)?.jBatchState || null;
  })();

  $: batchSize = jBatchState ? (
    (jBatchState.batch.reserveToCollateral?.length || 0) +
    (jBatchState.batch.settlements?.length || 0) +
    (jBatchState.batch.reserveToReserve?.length || 0)
  ) : 0;

  // Update diffs when simple mode changes
  $: if (mode === 'simple' && counterpartyEntityId && simpleAmount) {
    updateSimpleDiffs();
  }

  function updateSimpleDiffs() {
    if (!simpleAmount || !counterpartyEntityId) return;

    const amount = BigInt(simpleAmount);

    if (simpleAction === 'fund') {
      // Fund from our reserve to collateral
      if (isLeft) {
        leftDiff = (-amount).toString();
        rightDiff = '0';
      } else {
        leftDiff = '0';
        rightDiff = (-amount).toString();
      }
      collateralDiff = amount.toString();
      ondeltaDiff = '0';
      description = `Fund ${simpleAmount} from reserve to collateral`;
    } else {
      // Withdraw from collateral to our reserve
      if (isLeft) {
        leftDiff = amount.toString();
        rightDiff = '0';
      } else {
        leftDiff = '0';
        rightDiff = amount.toString();
      }
      collateralDiff = (-amount).toString();
      ondeltaDiff = '0';
      description = `Withdraw ${simpleAmount} from collateral to reserve`;
    }
  }

  function presetFund(amount: string) {
    simpleAction = 'fund';
    simpleAmount = amount;
    updateSimpleDiffs();
  }

  function presetWithdraw(amount: string) {
    simpleAction = 'withdraw';
    simpleAmount = amount;
    updateSimpleDiffs();
  }

  async function sendSettlement() {
    sending = true;
    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('Environment not ready');

      // Find signer ID
      let signerId = 's1';
      for (const key of env.replicas.keys()) {
        if (key.startsWith(entityId + ':')) {
          signerId = key.split(':')[1]!;
          break;
        }
      }

      let entityTx: any;

      // SIMPLE MODE: Use new deposit_collateral or request_withdrawal
      if (mode === 'simple') {
        if (simpleAction === 'fund') {
          // R→C: Unilateral deposit (adds to jBatch, broadcasts via crontab)
          entityTx = {
            type: 'deposit_collateral' as const,
            data: {
              counterpartyId: counterpartyEntityId,
              tokenId,
              amount: BigInt(simpleAmount),
            },
          };
          console.log('📤 Sending R→C deposit_collateral');
        } else {
          // C→R: Withdrawal request (requires counterparty approval)
          // TODO: Implement withdrawal request flow via bilateral account consensus
          // For now, user can use Advanced mode with manual settleDiffs
          alert('Withdrawal requires bilateral approval flow - not yet wired to UI.\n\nUse Advanced mode with manual settleDiffs for now, or wait for bilateral withdrawal UI.');
          sending = false;
          return;
        }
      } else {
        // ADVANCED MODE: Manual settleDiffs (requires invariant)
        if (!invariantValid) {
          const error = 'Invariant violation: leftDiff + rightDiff + collateralDiff must equal 0';
          console.error('❌ Settlement validation failed:', error);
          alert(error);
          sending = false;
          return;
        }

        entityTx = {
          type: 'settleDiffs' as const,
          data: {
            counterpartyEntityId,
            diffs: [{
              tokenId,
              leftDiff: BigInt(leftDiff),
              rightDiff: BigInt(rightDiff),
              collateralDiff: BigInt(collateralDiff),
              ondeltaDiff: BigInt(ondeltaDiff),
            }],
            description: description || undefined,
          },
        };
        console.log('📤 Sending manual settleDiffs');
      }

      const settlementInput = {
        entityId,
        signerId,
        entityTxs: [entityTx],
      };

      await xln.processUntilEmpty(env, [settlementInput]);
      console.log(`✅ Settlement sent`);

      // Reset simple mode
      if (mode === 'simple') {
        simpleAmount = '';
      }
    } catch (error) {
      console.error('Failed to send settlement:', error);
      alert(`Failed: ${(error as Error)?.message}`);
    } finally {
      sending = false;
    }
  }
</script>

<div class="settlement-panel">
  <h3>Settlement (Reserve ⇄ Collateral + Batch Rebalancing)</h3>
  <p class="panel-description">
    <strong>Fund (R→C):</strong> Deposits to jBatch, broadcasts every 5s via crontab<br>
    <strong>Withdraw (C→R):</strong> Requires bilateral approval (use Advanced mode for now)<br>
    <strong>Advanced:</strong> Manual settleDiffs with full control over all 4 diffs
  </p>

  <!-- jBatch Status -->
  {#if jBatchState}
    <div class="jbatch-status">
      <h4>📦 Pending Batch ({batchSize} operations)</h4>
      {#if batchSize > 0}
        <div class="batch-contents">
          {#if jBatchState.batch.reserveToCollateral?.length > 0}
            <div class="batch-section">
              <strong>R→C Deposits ({jBatchState.batch.reserveToCollateral.length}):</strong>
              {#each jBatchState.batch.reserveToCollateral as r2c}
                {#each r2c.pairs as pair}
                  <div class="batch-item">
                    • Entity {r2c.receivingEntity.slice(-4)} → {pair.entity.slice(-4)}: {Number(pair.amount) / 1e18} token {r2c.tokenId}
                  </div>
                {/each}
              {/each}
            </div>
          {/if}
          {#if jBatchState.batch.settlements?.length > 0}
            <div class="batch-section">
              <strong>Settlements ({jBatchState.batch.settlements.length}):</strong>
              {#each jBatchState.batch.settlements as settle}
                <div class="batch-item">
                  • {settle.leftEntity.slice(-4)}↔{settle.rightEntity.slice(-4)}: {settle.diffs.length} tokens
                </div>
              {/each}
            </div>
          {/if}
          {#if jBatchState.batch.reserveToReserve?.length > 0}
            <div class="batch-section">
              <strong>R→R Transfers ({jBatchState.batch.reserveToReserve.length}):</strong>
              {#each jBatchState.batch.reserveToReserve as r2r}
                <div class="batch-item">
                  • → {r2r.receivingEntity.slice(-4)}: {Number(r2r.amount) / 1e18} token {r2r.tokenId}
                </div>
              {/each}
            </div>
          {/if}
          <div class="batch-broadcast-info">
            Next broadcast in ~{Math.ceil((5000 - (Date.now() - (jBatchState.lastBroadcast || 0))) / 1000)}s
          </div>
        </div>
      {:else}
        <p class="batch-empty">No pending operations</p>
      {/if}
    </div>
  {/if}

  <div class="form-group">
    <label>Counterparty</label>
    <select bind:value={counterpartyEntityId} disabled={sending}>
      <option value="">Select entity...</option>
      {#each allEntities as id}
        <option value={id}>Entity #{id.slice(0, 10)}...</option>
      {/each}
    </select>
  </div>

  <div class="form-group">
    <label>Token</label>
    <select bind:value={tokenId} disabled={sending}>
      <option value={1}>USDC</option>
      <option value={2}>ETH</option>
    </select>
  </div>

  <!-- Mode Toggle -->
  <div class="mode-toggle">
    <button
      class:active={mode === 'simple'}
      on:click={() => mode = 'simple'}
      disabled={sending}
    >
      Simple
    </button>
    <button
      class:active={mode === 'advanced'}
      on:click={() => mode = 'advanced'}
      disabled={sending}
    >
      Advanced
    </button>
  </div>

  {#if mode === 'simple'}
    <!-- Simple Mode -->
    <div class="simple-mode">
      <div class="action-selector">
        <label>
          <input
            type="radio"
            bind:group={simpleAction}
            value="fund"
            on:change={updateSimpleDiffs}
            disabled={sending}
          />
          <span>Fund from Reserve → Collateral</span>
        </label>
        <label>
          <input
            type="radio"
            bind:group={simpleAction}
            value="withdraw"
            on:change={updateSimpleDiffs}
            disabled={sending}
          />
          <span>Withdraw Collateral → Reserve</span>
        </label>
      </div>

      <div class="form-group">
        <label>Amount</label>
        <input
          type="text"
          bind:value={simpleAmount}
          on:input={updateSimpleDiffs}
          placeholder="1000000"
          disabled={sending}
        />
      </div>

      <!-- Preset Buttons -->
      <div class="presets">
        <button on:click={() => presetFund('100000')} disabled={!counterpartyEntityId || sending}>
          Fund 100k
        </button>
        <button on:click={() => presetFund('1000000')} disabled={!counterpartyEntityId || sending}>
          Fund 1M
        </button>
        <button on:click={() => presetWithdraw('100000')} disabled={!counterpartyEntityId || sending}>
          Withdraw 100k
        </button>
      </div>
    </div>
  {:else}
    <!-- Advanced Mode -->
    <div class="advanced-mode">
      <div class="diffs-section">
        <div class="form-group">
          <label>Left Diff</label>
          <input type="text" bind:value={leftDiff} disabled={sending} />
        </div>

        <div class="form-group">
          <label>Right Diff</label>
          <input type="text" bind:value={rightDiff} disabled={sending} />
        </div>

        <div class="form-group">
          <label>Collateral Diff</label>
          <input type="text" bind:value={collateralDiff} disabled={sending} />
        </div>

        <div class="form-group">
          <label>Ondelta Diff</label>
          <input type="text" bind:value={ondeltaDiff} disabled={sending} />
        </div>
      </div>
    </div>
  {/if}

  <!-- Show computed diffs in both modes -->
  <div class="computed-diffs">
    <div class="diff-display">
      <strong>Computed Diffs:</strong>
      {#if counterpartyEntityId}
        <div class="side-indicator">You are: <span class="badge">{ourSide}</span></div>
      {/if}
      <div class="diff-row">
        <span class="label">Left:</span>
        <span class="value">{leftDiff}</span>
      </div>
      <div class="diff-row">
        <span class="label">Right:</span>
        <span class="value">{rightDiff}</span>
      </div>
      <div class="diff-row">
        <span class="label">Collateral:</span>
        <span class="value">{collateralDiff}</span>
      </div>
      <div class="diff-row">
        <span class="label">Ondelta:</span>
        <span class="value">{ondeltaDiff}</span>
      </div>
    </div>

    <!-- Invariant Validation Display -->
    <div class="invariant-check" class:valid={invariantValid} class:invalid={!invariantValid}>
      <strong>Invariant:</strong>
      {leftDiff} + {rightDiff} + {collateralDiff} = {invariantSum.toString()}
      {#if invariantValid}
        <span class="badge valid">✅ Valid</span>
      {:else}
        <span class="badge invalid">❌ Must = 0</span>
      {/if}
    </div>
  </div>

  <div class="form-group">
    <label>Description (optional)</label>
    <input type="text" bind:value={description} placeholder="Settlement note..." disabled={sending} />
  </div>

  <button
    class="btn-send"
    on:click={sendSettlement}
    disabled={!counterpartyEntityId || !invariantValid || sending}
  >
    {#if sending}
      Sending Settlement...
    {:else}
      Send Settlement
    {/if}
  </button>
</div>

<style>
  .settlement-panel {
    padding: 16px;
    background: #1e1e1e;
    border-radius: 4px;
    max-width: 500px;
  }

  h3 {
    margin: 0 0 16px 0;
    color: #007acc;
    font-size: 1.1em;
  }

  .form-group {
    margin-bottom: 12px;
  }

  label {
    display: block;
    margin-bottom: 4px;
    color: #9d9d9d;
    font-size: 0.85em;
  }

  input[type="text"], select {
    width: 100%;
    padding: 6px;
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    color: #d4d4d4;
    font-size: 0.9em;
    box-sizing: border-box;
  }

  input:focus, select:focus {
    outline: none;
    border-color: #007acc;
  }

  input:disabled, select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .mode-toggle {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }

  .mode-toggle button {
    flex: 1;
    padding: 8px;
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    color: #9d9d9d;
    cursor: pointer;
    transition: all 0.2s;
  }

  .mode-toggle button.active {
    background: #007acc;
    border-color: #007acc;
    color: white;
  }

  .mode-toggle button:hover:not(:disabled):not(.active) {
    background: #333;
    border-color: #007acc;
  }

  .simple-mode .action-selector {
    margin-bottom: 12px;
  }

  .action-selector label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    margin-bottom: 8px;
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .action-selector label:hover {
    background: #333;
    border-color: #007acc;
  }

  .action-selector input[type="radio"] {
    width: auto;
    margin: 0;
  }

  .diffs-section {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 12px;
  }

  .computed-diffs {
    margin-bottom: 12px;
    padding: 12px;
    background: #252525;
    border-radius: 4px;
  }

  .diff-display {
    margin-bottom: 12px;
    font-size: 0.85em;
  }

  .diff-display strong {
    display: block;
    margin-bottom: 8px;
    color: #9d9d9d;
  }

  .side-indicator {
    margin-bottom: 8px;
    color: #9d9d9d;
    font-size: 0.9em;
  }

  .diff-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    font-family: monospace;
  }

  .diff-row .label {
    color: #9d9d9d;
  }

  .diff-row .value {
    color: #d4d4d4;
  }

  .invariant-check {
    padding: 8px;
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.85em;
  }

  .invariant-check.valid {
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.3);
    color: #10b981;
  }

  .invariant-check.invalid {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #ef4444;
  }

  .badge {
    margin-left: 8px;
    padding: 2px 6px;
    border-radius: 2px;
    font-size: 0.85em;
    font-weight: bold;
  }

  .badge.valid {
    background: rgba(16, 185, 129, 0.2);
  }

  .badge.invalid {
    background: rgba(239, 68, 68, 0.2);
  }

  .presets {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }

  .presets button {
    flex: 1;
    padding: 6px;
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    color: #9d9d9d;
    font-size: 0.85em;
    cursor: pointer;
    transition: all 0.2s;
  }

  .presets button:hover:not(:disabled) {
    background: #333;
    border-color: #007acc;
  }

  .presets button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-send {
    width: 100%;
    padding: 8px;
    background: #10b981;
    border: none;
    border-radius: 4px;
    color: white;
    font-size: 0.9em;
    cursor: pointer;
    transition: background 0.2s;
  }

  .btn-send:hover:not(:disabled) {
    background: #059669;
  }

  .btn-send:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* jBatch Status */
  .jbatch-status {
    margin: 16px 0;
    padding: 12px;
    background: rgba(0, 217, 255, 0.05);
    border: 1px solid rgba(0, 217, 255, 0.2);
    border-radius: 6px;
  }

  .jbatch-status h4 {
    margin: 0 0 8px 0;
    font-size: 14px;
    color: #00d9ff;
  }

  .batch-contents {
    font-size: 12px;
    font-family: 'Courier New', monospace;
  }

  .batch-section {
    margin: 8px 0;
    color: rgba(255, 255, 255, 0.8);
  }

  .batch-section strong {
    display: block;
    margin-bottom: 4px;
    color: rgba(255, 255, 255, 0.9);
  }

  .batch-item {
    margin-left: 8px;
    color: rgba(255, 255, 255, 0.7);
    line-height: 1.6;
  }

  .batch-broadcast-info {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 11px;
    color: rgba(255, 255, 255, 0.6);
    font-style: italic;
  }

  .batch-empty {
    margin: 8px 0 0 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
    font-style: italic;
  }
</style>
