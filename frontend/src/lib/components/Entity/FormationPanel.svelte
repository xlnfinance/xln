<!--
  FormationPanel.svelte - Entity formation as proper panel

  Merged from legacy EntityFormation.svelte with new styling.
  Features: Jurisdiction, entity type (numbered/lazy/named), validators with weights, threshold.
-->
<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { xlnFunctions, getXLN, xlnEnvironment } from '../../stores/xlnStore';
  import { activeVault, vaultOperations } from '../../stores/vaultStore';
  import { tabOperations } from '../../stores/tabStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { Plus, X, Copy, Download, Upload, Users, User, Shield, Hash, Tag, Zap } from 'lucide-svelte';

  export let onCreated: ((entityId: string) => void) | undefined = undefined;

  const dispatch = createEventDispatcher();

  // Context
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextEnv = entityEnv?.env;
  const contextXlnFunctions = entityEnv?.xlnFunctions;

  // Reactive stores
  $: env = contextEnv ? $contextEnv : $xlnEnvironment;
  $: activeFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
  $: vault = $activeVault;

  // Form state
  type EntityType = 'numbered' | 'lazy' | 'named';
  let entityType: EntityType = 'numbered';
  let entityName = 'ACME';
  let selectedJurisdiction = '';
  let threshold = 1;
  let validators: Array<{ name: string; weight: number }> = [{ name: '1', weight: 1 }];
  let creating = false;
  let error = '';
  let success = '';
  let userModifiedThreshold = false;

  // Import/Export state
  let showImport = false;
  let importJson = '';

  // Available jurisdictions from env
  $: jurisdictions = (() => {
    if (!env?.jReplicas) return [];
    if (env.jReplicas instanceof Map) return Array.from(env.jReplicas.values());
    if (Array.isArray(env.jReplicas)) return env.jReplicas;
    return Object.values(env.jReplicas || {});
  })() as Array<{ name: string; chainId?: number; config?: any }>;

  // Auto-select first jurisdiction
  $: if (jurisdictions.length > 0 && !selectedJurisdiction) {
    selectedJurisdiction = jurisdictions[0]?.name || '';
  }

  // My signer address
  $: mySignerAddress = vault?.signers?.[0]?.address || '';

  // Total weight calculation
  $: totalWeight = validators.reduce((sum, v) => sum + v.weight, 0);

  // Auto-update threshold when validators change (if user hasn't manually changed it)
  $: {
    if (!userModifiedThreshold && totalWeight > 0) {
      if (validators.length === 1) {
        threshold = 1;
      } else {
        threshold = totalWeight; // Default to all validators required
      }
    }
  }

  // Quorum hash for lazy entities
  $: quorumHash = entityType === 'lazy' ? calculateQuorumHash(validators, threshold) : '';

  // Expected entity ID preview
  $: expectedEntityId = (() => {
    if (entityType === 'lazy') return `0x${quorumHash}`;
    if (entityType === 'numbered') return '#(next)';
    return entityName.toLowerCase().replace(/\s+/g, '-');
  })();

  function calculateQuorumHash(vals: Array<{name: string; weight: number}>, thresh: number): string {
    const validatorString = vals.map(v => `${v.name}:${v.weight}`).sort().join(',');
    const hashInput = `${validatorString}|${thresh}`;
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
      const char = hashInput.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  function addValidator() {
    const nextNum = validators.length + 1;
    validators = [...validators, { name: String(nextNum), weight: 1 }];
    if (!userModifiedThreshold) {
      threshold = validators.reduce((sum, v) => sum + v.weight, 0);
    }
  }

  function removeValidator(idx: number) {
    if (validators.length > 1) {
      validators = validators.filter((_, i) => i !== idx);
      const newTotal = validators.reduce((sum, v) => sum + v.weight, 0);
      if (threshold > newTotal) threshold = newTotal;
    }
  }

  function onThresholdChange() {
    userModifiedThreshold = true;
  }

  function formatShortId(id: string): string {
    if (!id) return '';
    if (activeFunctions?.getEntityShortId) {
      return '#' + activeFunctions.getEntityShortId(id);
    }
    return '#' + (id.startsWith('0x') ? id.slice(2, 6) : id.slice(0, 4)).toUpperCase();
  }

  async function createEntity() {
    if (!selectedJurisdiction) {
      error = 'Select a jurisdiction';
      return;
    }

    if (validators.some(v => !v.name.trim())) {
      error = 'All validators must have names';
      return;
    }

    creating = true;
    error = '';
    success = '';

    try {
      const xln = await getXLN();
      if (!xln) throw new Error('XLN not initialized');

      const currentEnv = env;
      if (!currentEnv) throw new Error('Environment not ready');

      const validatorNames = validators.map(v => v.name);
      const thresholdBigInt = BigInt(threshold);

      // Get jurisdiction config
      const jurisdictionReplica = jurisdictions.find(j => j.name === selectedJurisdiction);
      if (!jurisdictionReplica) {
        throw new Error('Selected jurisdiction not found');
      }

      let entityId: string;
      let config: any;

      if (entityType === 'lazy') {
        // Lazy entity - ID is hash of quorum
        entityId = xln.generateLazyEntityId(validatorNames, thresholdBigInt);

        // Check for duplicates
        const existingReplicas = Array.from((currentEnv.eReplicas as Map<string, any>)?.keys?.() || []);
        if (existingReplicas.some((key: string) => key.startsWith(entityId + ':'))) {
          throw new Error(`This validator configuration already exists! Entity ${formatShortId(entityId)} is in use.`);
        }

        const result = xln.createLazyEntity(entityName, validatorNames, thresholdBigInt, {
          name: selectedJurisdiction,
        } as any);
        config = result.config;
      } else if (entityType === 'numbered') {
        // Numbered entity - on-chain registration
        const creation = await xln.createNumberedEntity(entityName, validatorNames, thresholdBigInt, {
          name: selectedJurisdiction,
        } as any);
        config = creation.config;
        entityId = creation.entityId;
      } else {
        // Named entity - requires admin approval
        throw new Error('Named entities require admin approval (not yet implemented)');
      }

      // Create serverTxs to import replicas
      const serverTxs = validatorNames.map((signerId, index) => ({
        type: 'importReplica' as const,
        entityId,
        signerId,
        data: {
          config,
          isProposer: index === 0
        }
      }));

      // Apply to runtime
      const result = await xln.applyRuntimeInput(currentEnv as any, {
        runtimeTxs: serverTxs,
        entityInputs: []
      });

      // Process outbox
      await xln.process(currentEnv as any, result.entityOutbox);

      success = `Entity created: ${formatShortId(entityId)}`;

      // Auto-create panels for each validator
      for (const signerId of validatorNames) {
        tabOperations.addTab(entityId, signerId, selectedJurisdiction);
      }

      // Callback
      if (onCreated) onCreated(entityId);
      dispatch('created', { entityId });

      // Reset form
      resetForm();

    } catch (err) {
      console.error('[FormationPanel] Creation failed:', err);
      error = (err as Error)?.message || 'Creation failed';
    } finally {
      creating = false;
    }
  }

  function resetForm() {
    entityName = 'ACME';
    entityType = 'numbered';
    validators = [{ name: '1', weight: 1 }];
    threshold = 1;
    userModifiedThreshold = false;
  }

  function exportConfig() {
    const config = {
      entityType,
      entityName,
      jurisdiction: selectedJurisdiction,
      validators,
      threshold,
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xln-entity-config-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importConfig() {
    try {
      const config = JSON.parse(importJson);
      if (config.entityType) entityType = config.entityType;
      if (config.entityName) entityName = config.entityName;
      if (config.jurisdiction) selectedJurisdiction = config.jurisdiction;
      if (config.validators) validators = config.validators;
      if (config.threshold) threshold = config.threshold;
      showImport = false;
      importJson = '';
      success = 'Config imported';
    } catch (err) {
      error = 'Invalid JSON config';
    }
  }
</script>

<div class="formation-panel">
  <header class="panel-header">
    <h3>Create Entity</h3>
    <div class="header-actions">
      <button class="icon-btn" on:click={() => showImport = !showImport} title="Import Config">
        <Upload size={14} />
      </button>
      <button class="icon-btn" on:click={exportConfig} title="Export Config">
        <Download size={14} />
      </button>
    </div>
  </header>

  {#if showImport}
    <div class="import-section">
      <textarea
        bind:value={importJson}
        placeholder="Paste entity config JSON..."
        rows="4"
      ></textarea>
      <div class="import-actions">
        <button class="btn-secondary" on:click={() => { showImport = false; importJson = ''; }}>Cancel</button>
        <button class="btn-primary" on:click={importConfig}>Import</button>
      </div>
    </div>
  {/if}

  <!-- Entity Type -->
  <div class="field">
    <label>Entity Type</label>
    <div class="type-selector three-col">
      <button
        class="type-option"
        class:active={entityType === 'numbered'}
        on:click={() => entityType = 'numbered'}
      >
        <Hash size={16} />
        <span>Numbered</span>
        <small>On-chain ID</small>
      </button>
      <button
        class="type-option"
        class:active={entityType === 'lazy'}
        on:click={() => entityType = 'lazy'}
      >
        <Zap size={16} />
        <span>Lazy</span>
        <small>Free, instant</small>
      </button>
      <button
        class="type-option"
        class:active={entityType === 'named'}
        on:click={() => entityType = 'named'}
      >
        <Tag size={16} />
        <span>Named</span>
        <small>Premium</small>
      </button>
    </div>
  </div>

  <!-- Entity Name -->
  <div class="field">
    <label>Entity Name</label>
    <input
      type="text"
      bind:value={entityName}
      placeholder="e.g., ACME Corp"
    />
    <p class="field-hint">Display name for your entity</p>
  </div>

  <!-- Jurisdiction -->
  <div class="field">
    <label>Jurisdiction</label>
    {#if jurisdictions.length === 0}
      <div class="empty-hint">No jurisdictions available. Add one first.</div>
    {:else}
      <div class="jurisdiction-list">
        {#each jurisdictions as j}
          <button
            class="jurisdiction-option"
            class:active={selectedJurisdiction === j.name}
            on:click={() => selectedJurisdiction = j.name}
          >
            <Shield size={14} />
            <span class="j-name">{j.name}</span>
            {#if j.chainId}
              <span class="j-chain">#{j.chainId}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Validators -->
  <div class="field">
    <label>Validators ({validators.length})</label>
    <div class="validators-list">
      {#each validators as v, idx}
        <div class="validator-row">
          <span class="v-index">{idx + 1}</span>
          <select bind:value={v.name} class="v-name">
            <option value="">Select...</option>
            <option value="1">1 (Default)</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
          </select>
          <input
            type="number"
            bind:value={v.weight}
            min="1"
            class="v-weight"
            placeholder="Weight"
          />
          <button class="v-remove" on:click={() => removeValidator(idx)} disabled={validators.length <= 1}>
            <X size={12} />
          </button>
        </div>
      {/each}
    </div>
    <button class="btn-add-validator" on:click={addValidator}>
      <Plus size={14} /> Add Validator
    </button>
  </div>

  <!-- Threshold (only show for multi-validator) -->
  {#if validators.length > 1}
    <div class="field">
      <label>Threshold</label>
      <div class="threshold-selector">
        <input
          type="range"
          min="1"
          max={totalWeight}
          bind:value={threshold}
          on:input={onThresholdChange}
        />
        <span class="threshold-display">{threshold} of {totalWeight}</span>
      </div>
      <p class="field-hint">
        {threshold === totalWeight ? 'All validators must sign' : `${threshold} weight required to sign`}
      </p>
    </div>
  {/if}

  <!-- Quorum Hash (lazy only) -->
  {#if entityType === 'lazy'}
    <div class="preview-box">
      <label>Quorum Hash</label>
      <code>{quorumHash}</code>
      <small>This hash becomes your entity ID</small>
    </div>
  {/if}

  <!-- Expected Entity ID -->
  <div class="preview-box">
    <label>Expected Entity ID</label>
    <code class="entity-id">{expectedEntityId}</code>
  </div>

  <!-- Status Messages -->
  {#if error}
    <div class="message error">{error}</div>
  {/if}
  {#if success}
    <div class="message success">{success}</div>
  {/if}

  <!-- Actions -->
  <div class="actions">
    <button class="btn-secondary" on:click={resetForm}>Clear</button>
    <button
      class="btn-create"
      on:click={createEntity}
      disabled={creating || !selectedJurisdiction || validators.some(v => !v.name)}
    >
      {creating ? 'Creating...' : 'Create Entity'}
    </button>
  </div>
</div>

<style>
  .formation-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .panel-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: #e7e5e4;
  }

  .header-actions {
    display: flex;
    gap: 6px;
  }

  .icon-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #78716c;
    cursor: pointer;
  }

  .icon-btn:hover {
    border-color: #44403c;
    color: #a8a29e;
  }

  /* Import Section */
  .import-section {
    padding: 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
  }

  .import-section textarea {
    width: 100%;
    padding: 10px;
    background: #0c0a09;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #e7e5e4;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    resize: vertical;
  }

  .import-actions {
    display: flex;
    gap: 8px;
    margin-top: 10px;
    justify-content: flex-end;
  }

  /* Fields */
  .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .field label {
    font-size: 11px;
    font-weight: 500;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .field input[type="text"],
  .field select {
    padding: 10px 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #e7e5e4;
    font-size: 13px;
  }

  .field input:focus,
  .field select:focus {
    outline: none;
    border-color: #fbbf24;
  }

  .field-hint {
    margin: 0;
    font-size: 11px;
    color: #57534e;
  }

  /* Type Selector */
  .type-selector {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .type-selector.three-col {
    grid-template-columns: 1fr 1fr 1fr;
  }

  .type-option {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 12px 8px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
    color: #a8a29e;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .type-option small {
    font-size: 9px;
    color: #57534e;
  }

  .type-option:hover {
    border-color: #44403c;
  }

  .type-option.active {
    border-color: #fbbf24;
    background: #422006;
    color: #fbbf24;
  }

  .type-option.active small {
    color: #d97706;
  }

  /* Jurisdiction */
  .empty-hint {
    padding: 16px;
    text-align: center;
    color: #57534e;
    font-size: 12px;
    background: #1c1917;
    border-radius: 8px;
  }

  .jurisdiction-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .jurisdiction-option {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #a8a29e;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s;
  }

  .jurisdiction-option:hover {
    border-color: #44403c;
  }

  .jurisdiction-option.active {
    border-color: #fbbf24;
    background: #422006;
    color: #fbbf24;
  }

  .j-name {
    flex: 1;
    font-weight: 500;
  }

  .j-chain {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #57534e;
  }

  /* Validators */
  .validators-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 180px;
    overflow-y: auto;
  }

  .validator-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
  }

  .v-index {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #292524;
    border-radius: 4px;
    font-size: 10px;
    color: #78716c;
    flex-shrink: 0;
  }

  .v-name {
    flex: 1;
    padding: 6px 8px;
    background: #0c0a09;
    border: 1px solid #292524;
    border-radius: 4px;
    color: #e7e5e4;
    font-size: 12px;
  }

  .v-weight {
    width: 60px;
    padding: 6px 8px;
    background: #0c0a09;
    border: 1px solid #292524;
    border-radius: 4px;
    color: #e7e5e4;
    font-size: 12px;
    text-align: center;
  }

  .v-remove {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: #78716c;
    cursor: pointer;
    flex-shrink: 0;
  }

  .v-remove:hover:not(:disabled) {
    color: #ef4444;
  }

  .v-remove:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .btn-add-validator {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px;
    background: #1c1917;
    border: 1px dashed #44403c;
    border-radius: 6px;
    color: #78716c;
    font-size: 12px;
    cursor: pointer;
  }

  .btn-add-validator:hover {
    border-color: #fbbf24;
    color: #fbbf24;
  }

  /* Threshold */
  .threshold-selector {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: #1c1917;
    border-radius: 8px;
  }

  .threshold-selector input[type="range"] {
    flex: 1;
    accent-color: #fbbf24;
  }

  .threshold-display {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 600;
    color: #fbbf24;
    min-width: 60px;
    text-align: right;
  }

  /* Preview Box */
  .preview-box {
    padding: 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
  }

  .preview-box label {
    display: block;
    font-size: 10px;
    color: #57534e;
    text-transform: uppercase;
    margin-bottom: 6px;
  }

  .preview-box code {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: #22c55e;
    word-break: break-all;
  }

  .preview-box code.entity-id {
    color: #fbbf24;
  }

  .preview-box small {
    display: block;
    font-size: 10px;
    color: #57534e;
    margin-top: 6px;
  }

  /* Messages */
  .message {
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 12px;
  }

  .message.error {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #ef4444;
  }

  .message.success {
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.3);
    color: #22c55e;
  }

  /* Actions */
  .actions {
    display: flex;
    gap: 8px;
  }

  .btn-secondary {
    padding: 10px 16px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #a8a29e;
    font-size: 12px;
    cursor: pointer;
  }

  .btn-secondary:hover {
    border-color: #44403c;
  }

  .btn-primary {
    padding: 8px 14px;
    background: #422006;
    border: 1px solid #713f12;
    border-radius: 6px;
    color: #fbbf24;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-create {
    flex: 1;
    padding: 12px;
    background: linear-gradient(135deg, #15803d, #166534);
    border: none;
    border-radius: 6px;
    color: #dcfce7;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-create:hover:not(:disabled) {
    background: linear-gradient(135deg, #16a34a, #15803d);
  }

  .btn-create:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
