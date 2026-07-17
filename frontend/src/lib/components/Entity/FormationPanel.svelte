<!--
  FormationPanel.svelte - Entity formation as proper panel

  Entity formation with jurisdiction, type, validator, and threshold controls.
  Features: Jurisdiction, entity type (numbered/lazy/named), validators with weights, threshold.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { ConsensusConfig } from '@xln/runtime/xln-api';
  import { createActiveNumberedEntity, getXLN, submitRuntimeInput } from '../../stores/xlnStore';
  import { errorLog } from '../../stores/errorLogStore';
  import { activeRuntime, vaultOperations } from '../../stores/vaultStore';
  import { tabOperations } from '../../stores/tabStore';
  import { generateLazyEntityIdPreview } from '../../utils/lazyEntityId';
  import { Plus, X, Download, Upload, Shield, Hash, Tag, Zap } from 'lucide-svelte';
  import {
    emptyFormationRuntimeProjection,
    hasProjectedEntityId,
    type FormationRuntimeProjection,
  } from './formation-runtime-projection';

  export let onCreated: ((entityId: string) => void) | undefined = undefined;
  export let runtimeProjection: FormationRuntimeProjection = emptyFormationRuntimeProjection();

  const dispatch = createEventDispatcher();
  $: vault = $activeRuntime;

  // Form state
  type EntityType = 'numbered' | 'lazy' | 'named';
  let entityType: EntityType = 'numbered';
  let entityName = 'ACME';
  let selectedJurisdiction = '';
  let threshold = 1;
  let validators: Array<{ name: string; weight: number }> = [{ name: '', weight: 1 }];
  let seededSignerAddress = '';
  let creating = false;
  let error = '';
  let success = '';
  let userModifiedThreshold = false;

  // Import/Export state
  let showImport = false;
  let importJson = '';

  $: jurisdictions = runtimeProjection.jurisdictions;

  // Auto-select first jurisdiction
  $: if (jurisdictions.length > 0 && !selectedJurisdiction) {
    selectedJurisdiction = jurisdictions[0]?.name || '';
  }

  // My signer address
  $: mySignerAddress = vault?.signers?.[vault.activeSignerIndex]?.address || '';
  $: if (mySignerAddress && mySignerAddress !== seededSignerAddress) {
    if (
      validators.length === 1 &&
      (!validators[0]?.name || validators[0]?.name === seededSignerAddress)
    ) {
      validators = [{ name: mySignerAddress, weight: validators[0]?.weight || 1 }];
    }
    seededSignerAddress = mySignerAddress;
  }

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

  let quorumHash = '';
  let previewError = '';
  $: {
    try {
      quorumHash = entityType === 'lazy'
        ? generateLazyEntityIdPreview(validators, BigInt(threshold))
        : '';
      previewError = '';
    } catch (cause) {
      quorumHash = '';
      previewError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  // Expected entity ID preview
  $: expectedEntityId = (() => {
    if (entityType === 'lazy') return quorumHash || 'Invalid board';
    if (entityType === 'numbered') return '#(next)';
    return entityName.toLowerCase().replace(/\s+/g, '-');
  })();

  function addValidator() {
    validators = [...validators, { name: '', weight: 1 }];
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
    return id || '';
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

      const boardMembers = validators.map((validator) => ({
        name: validator.name.trim(),
        weight: Number(validator.weight),
      }));
      const thresholdBigInt = BigInt(threshold);
      if (boardMembers.some((member) => !Number.isInteger(member.weight) || member.weight <= 0 || member.weight > 0xffff)) {
        throw new Error('Every board weight must be an integer from 1 to 65535');
      }
      if (!Number.isInteger(threshold) || threshold <= 0 || threshold > totalWeight) {
        throw new Error(`Board threshold must be between 1 and ${totalWeight}`);
      }

      // Get jurisdiction config
      const jurisdictionReplica = jurisdictions.find(j => j.name === selectedJurisdiction);
      if (!jurisdictionReplica) {
        throw new Error('Selected jurisdiction not found');
      }

      let entityId: string;
      let config: ConsensusConfig;

      if (entityType === 'lazy') {
        // Lazy entity - ID is hash of quorum
        entityId = xln.generateLazyEntityId(boardMembers, thresholdBigInt);

        // Check for duplicates
        if (hasProjectedEntityId(runtimeProjection, entityId)) {
          throw new Error(`This validator configuration already exists! Entity ${formatShortId(entityId)} is in use.`);
        }

        const result = xln.createLazyEntity(entityName, boardMembers, thresholdBigInt, jurisdictionReplica);
        config = result.config;
      } else if (entityType === 'numbered') {
        // Numbered entity - on-chain registration
        const registrationSignerId = mySignerAddress.trim().toLowerCase();
        if (!registrationSignerId) {
          throw new Error('NUMBERED_ENTITY_ACTIVE_WALLET_SIGNER_REQUIRED');
        }
        const vaultRuntimeId = String(vault?.id || '').trim().toLowerCase();
        const creation = await createActiveNumberedEntity(
          entityName,
          boardMembers,
          thresholdBigInt,
          jurisdictionReplica,
          registrationSignerId,
          vaultRuntimeId,
        );
        config = creation.config;
        entityId = creation.entityId;
      } else {
        // Named entity - requires admin approval
        throw new Error('Named entities require admin approval (not yet implemented)');
      }

      const localSignerId = mySignerAddress.toLowerCase();
      const localBoardIndex = config.validators.findIndex(
        (member) => member.toLowerCase() === localSignerId,
      );
      if (localBoardIndex >= 0) {
        await submitRuntimeInput({
          runtimeTxs: [{
            type: 'importReplica',
            entityId,
            signerId: localSignerId,
            data: {
              config,
              isProposer: localBoardIndex === 0,
              profileName: entityName,
            },
          }],
          entityInputs: [],
        });
        tabOperations.addTab(entityId, localSignerId, selectedJurisdiction);
        success = `Entity created: ${formatShortId(entityId)}`;
      } else {
        success = `Board created: ${formatShortId(entityId)}. Import this configuration in a member wallet.`;
      }

      // Callback
      if (onCreated) onCreated(entityId);
      dispatch('created', { entityId });

      // Reset form
      resetForm();

    } catch (err) {
      errorLog.log('Entity creation failed', 'Formation Panel', { entityName, entityType, selectedJurisdiction, err });
      error = err instanceof Error ? err.message : 'Creation failed';
    } finally {
      creating = false;
    }
  }

  function resetForm() {
    entityName = 'ACME';
    entityType = 'numbered';
    validators = [{ name: mySignerAddress, weight: 1 }];
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
      error = err instanceof Error ? `Invalid entity config: ${err.message}` : 'Invalid entity config';
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

  <div class="field">
    <div class="field-label">Entity Type</div>
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

  <div class="field">
    <div class="field-label">Entity Name</div>
    <input
      type="text"
      bind:value={entityName}
      placeholder="e.g., ACME Corp"
    />
    <p class="field-hint">Display name for your entity</p>
  </div>

  <div class="field">
    <div class="field-label">Jurisdiction</div>
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

  <div class="field">
    <div class="field-label">Ordered board ({validators.length})</div>
    <div class="validators-list">
      {#each validators as v, idx}
        <div class="validator-row">
          <span class="v-index">{idx + 1}</span>
          <input
            type="text"
            bind:value={v.name}
            class="v-name"
            placeholder="EOA address or Entity ID"
            aria-label={`Board member ${idx + 1}`}
          />
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
      <Plus size={14} /> Add Board Member
    </button>
    <p class="field-hint">Member 1 proposes. Order, weights and threshold are part of the Entity ID.</p>
  </div>

  {#if validators.length > 1}
    <div class="field">
      <div class="field-label">Threshold</div>
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

  {#if entityType === 'lazy'}
    <div class="preview-box">
      <div class="preview-label">Canonical Board Hash</div>
      <code>{quorumHash}</code>
      <small>This hash becomes your entity ID</small>
    </div>
  {/if}

  {#if previewError}
    <div class="message error">{previewError}</div>
  {/if}

  <div class="preview-box">
    <div class="preview-label">Expected Entity ID</div>
    <code class="entity-id">{expectedEntityId}</code>
  </div>

  {#if error}
    <div class="message error">{error}</div>
  {/if}
  {#if success}
    <div class="message success">{success}</div>
  {/if}

  <div class="actions">
    <button class="btn-secondary" on:click={resetForm}>Clear</button>
    <button
      class="btn-create"
      on:click={createEntity}
      disabled={creating || !selectedJurisdiction || validators.some(v => !v.name) || Boolean(previewError)}
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
    color: var(--theme-text-primary, #e4e4e7);
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
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent);
    border-radius: 6px;
    color: var(--theme-text-muted, #71717a);
    cursor: pointer;
  }

  .icon-btn:hover {
    border-color: color-mix(in srgb, var(--theme-border, #27272a) 84%, white 16%);
    color: var(--theme-text-secondary, #a1a1aa);
  }

  /* Import Section */
  .import-section {
    padding: 12px;
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent);
    border-radius: 8px;
  }

  .import-section textarea {
    width: 100%;
    padding: 10px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-input-border, #27272a) 82%, transparent);
    border-radius: 6px;
    color: var(--theme-text-primary, #e4e4e7);
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

  .field-label {
    font-size: 11px;
    font-weight: 500;
    color: var(--theme-text-secondary, #a1a1aa);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .field input[type="text"] {
    padding: 10px 12px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-input-border, #27272a) 82%, transparent);
    border-radius: 6px;
    color: var(--theme-text-primary, #e4e4e7);
    font-size: 13px;
  }

  .field input:focus {
    outline: none;
    border-color: var(--theme-input-focus, #fbbf24);
  }

  .field-hint {
    margin: 0;
    font-size: 11px;
    color: var(--theme-text-muted, #71717a);
  }

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
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent);
    border-radius: 8px;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .type-option small {
    font-size: 9px;
    color: var(--theme-text-muted, #71717a);
  }

  .type-option:hover {
    border-color: color-mix(in srgb, var(--theme-border, #27272a) 84%, white 16%);
  }

  .type-option.active {
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 68%, transparent);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 12%, transparent);
    color: var(--theme-accent, #fbbf24);
  }

  .type-option.active small {
    color: color-mix(in srgb, var(--theme-accent, #fbbf24) 78%, #7c2d12);
  }

  .empty-hint {
    padding: 16px;
    text-align: center;
    color: var(--theme-text-muted, #71717a);
    font-size: 12px;
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent);
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
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent);
    border-radius: 6px;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s;
  }

  .jurisdiction-option:hover {
    border-color: color-mix(in srgb, var(--theme-border, #27272a) 84%, white 16%);
  }

  .jurisdiction-option.active {
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 68%, transparent);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 12%, transparent);
    color: var(--theme-accent, #fbbf24);
  }

  .j-name {
    flex: 1;
    font-weight: 500;
  }

  .j-chain {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--theme-text-muted, #71717a);
  }

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
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent);
    border-radius: 6px;
  }

  .v-index {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 85%, transparent);
    border-radius: 4px;
    font-size: 10px;
    color: var(--theme-text-muted, #71717a);
    flex-shrink: 0;
  }

  .v-name {
    flex: 1;
    padding: 6px 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-input-border, #27272a) 82%, transparent);
    border-radius: 4px;
    color: var(--theme-text-primary, #e4e4e7);
    font-size: 12px;
  }

  .v-weight {
    width: 60px;
    padding: 6px 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-input-border, #27272a) 82%, transparent);
    border-radius: 4px;
    color: var(--theme-text-primary, #e4e4e7);
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
    color: var(--theme-text-muted, #71717a);
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
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent);
    border: 1px dashed color-mix(in srgb, var(--theme-border, #27272a) 84%, white 16%);
    border-radius: 6px;
    color: var(--theme-text-muted, #71717a);
    font-size: 12px;
    cursor: pointer;
  }

  .btn-add-validator:hover {
    border-color: var(--theme-accent, #fbbf24);
    color: var(--theme-accent, #fbbf24);
  }

  .threshold-selector {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 12px;
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent);
    border-radius: 8px;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }

  .threshold-selector input[type="range"] {
    flex: 1 1 220px;
    min-width: 0;
    max-width: 100%;
  }

  .threshold-display {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 600;
    color: var(--theme-accent, #fbbf24);
    min-width: 60px;
    text-align: right;
  }

  .preview-box {
    padding: 12px;
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent);
    border-radius: 8px;
  }

  .preview-label {
    display: block;
    font-size: 10px;
    color: var(--theme-text-muted, #71717a);
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
    color: var(--theme-text-muted, #71717a);
    margin-top: 6px;
  }

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
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent);
    border-radius: 6px;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 12px;
    cursor: pointer;
  }

  .btn-secondary:hover {
    border-color: color-mix(in srgb, var(--theme-border, #27272a) 84%, white 16%);
  }

  .btn-primary {
    padding: 8px 14px;
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-accent, #fbbf24) 34%, transparent);
    border-radius: 6px;
    color: var(--theme-accent, #fbbf24);
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

  @media (max-width: 900px) {
    .validators-list {
      max-height: none;
      overflow: visible;
    }
  }
</style>
