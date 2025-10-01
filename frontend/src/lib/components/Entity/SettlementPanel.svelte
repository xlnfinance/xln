<script lang="ts">
  import { getXLN, xlnEnvironment, replicas } from '../../stores/xlnStore';

  export let entityId: string;

  // Form state
  let counterpartyEntityId = '';
  let tokenId = 2; // Default USDC
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
    if (!invariantValid) {
      const error = 'Invariant violation: leftDiff + rightDiff + collateralDiff must equal 0';
      console.error('❌ Settlement validation failed:', error);
      alert(error);
      return;
    }

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

      const settlementInput = {
        entityId,
        signerId,
        entityTxs: [{
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
        }],
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
  <h3>Settlement (Reserve ⇄ Collateral)</h3>

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
      <option value={1}>ETH</option>
      <option value={2}>USDC</option>
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
</style>
