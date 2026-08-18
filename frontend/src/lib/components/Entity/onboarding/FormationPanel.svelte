<!--
  FormationPanel.svelte - Entity formation as proper panel

  Entity formation with jurisdiction, type, validator, and threshold controls.
  Features: Jurisdiction, numbered/lazy identity, validators with weights, threshold.
-->
<script lang="ts">
  import { isTronChainId, type ConsensusConfig } from '@xln/core/api/public/runtime-module';
  import { getXLN, registerActiveNumberedEntities, submitRuntimeInput } from '../../../stores/xlnStore';
  import { errorLog } from '../../../stores/errorLogStore';
  import { activeRuntime } from '../../../stores/vault/vaultStore';
  import { tabOperations } from '../../../stores/ui/tabStore';
  import { generateLazyEntityIdPreview } from '../../../utils/identity/lazyEntityId';
  import { Plus, X, Shield, Hash, UserRound, UsersRound, Zap } from 'lucide-svelte';
  import {
    emptyFormationRuntimeProjection,
    hasProjectedEntityId,
    type FormationRuntimeProjection,
  } from './formation-runtime-projection';

  export let onCreated: ((entityId: string) => void) | undefined = undefined;
  export let runtimeProjection: FormationRuntimeProjection = emptyFormationRuntimeProjection();

  $: vault = $activeRuntime;

  // Form state
  type EntityType = 'numbered' | 'lazy';
  type BoardMode = 'personal' | 'shared';
  let entityType: EntityType = 'numbered';
  let boardMode: BoardMode = 'personal';
  let entityName = '';
  let selectedJurisdiction = '';
  let threshold = 1;
  let validators: Array<{ name: string; weight: number }> = [{ name: '', weight: 1 }];
  let seededSignerAddress = '';
  let creating = false;
  let error = '';
  let success = '';
  let userModifiedThreshold = false;

  $: jurisdictions = runtimeProjection.jurisdictions;
  $: selectableJurisdictions = entityType === 'numbered'
    ? jurisdictions.filter(jurisdiction => !isTronChainId(Number(jurisdiction.chainId)))
    : jurisdictions;

  // Keep the selection inside the capabilities of the chosen entity type.
  $: if (!selectableJurisdictions.some(jurisdiction => jurisdiction.name === selectedJurisdiction)) {
    selectedJurisdiction = selectableJurisdictions[0]?.name || '';
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

  $: formationValidators = boardMode === 'personal'
    ? [{ name: mySignerAddress, weight: 1 }]
    : validators;
  $: totalWeight = formationValidators.reduce((sum, validator) => sum + validator.weight, 0);

  // Auto-update threshold when validators change (if user hasn't manually changed it)
  $: {
    if (!userModifiedThreshold && totalWeight > 0) {
      if (boardMode === 'personal') {
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
        ? generateLazyEntityIdPreview(formationValidators, BigInt(threshold))
        : '';
      previewError = '';
    } catch (cause) {
      quorumHash = '';
      previewError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  function addValidator() {
    validators = [...validators, { name: '', weight: 1 }];
    if (!userModifiedThreshold) {
      threshold = validators.reduce((sum, v) => sum + v.weight, 0);
    }
  }

  function selectPersonalBoard(): void {
    boardMode = 'personal';
    threshold = 1;
    userModifiedThreshold = false;
  }

  function selectSharedBoard(): void {
    boardMode = 'shared';
    if (validators.length === 1) {
      validators = [validators[0] ?? { name: mySignerAddress, weight: 1 }, { name: '', weight: 1 }];
    }
    threshold = validators.reduce((sum, validator) => sum + validator.weight, 0);
    userModifiedThreshold = false;
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

  function requireSharedEntitySeed(seed: string | undefined): string {
    if (!seed) throw new Error('NUMBERED_ENTITY_SHARED_SEED_REQUIRED');
    return seed;
  }

  async function createEntity() {
    if (!selectedJurisdiction) {
      error = 'Select a jurisdiction';
      return;
    }

    if (formationValidators.some(validator => !validator.name.trim())) {
      error = 'All validators must have names';
      return;
    }

    creating = true;
    error = '';
    success = '';

    try {
      const xln = await getXLN();
      if (!xln) throw new Error('XLN not initialized');

      const boardMembers = formationValidators.map((validator) => ({
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
      const jurisdictionReplica = selectableJurisdictions.find(j => j.name === selectedJurisdiction);
      if (!jurisdictionReplica) {
        throw new Error('Selected jurisdiction not found');
      }

      let entityId: string;
      let config: ConsensusConfig;
      let numberedImported = false;

      if (entityType === 'lazy') {
        // Lazy entity - ID is hash of quorum
        entityId = xln.generateLazyEntityId(boardMembers, thresholdBigInt);

        // Check for duplicates
        if (hasProjectedEntityId(runtimeProjection, entityId)) {
          throw new Error(`This validator configuration already exists! Entity ${formatShortId(entityId)} is in use.`);
        }

        const result = xln.createLazyEntity(entityName, boardMembers, thresholdBigInt, jurisdictionReplica);
        config = result.config;
      } else {
        // Numbered entity - on-chain registration
        const registrationSignerId = mySignerAddress.trim().toLowerCase();
        if (!registrationSignerId) {
          throw new Error('NUMBERED_ENTITY_ACTIVE_WALLET_SIGNER_REQUIRED');
        }
        const vaultRuntimeId = String(vault?.id || '').trim().toLowerCase();
        const localSignerId = boardMembers.some(
          member => member.name.toLowerCase() === registrationSignerId,
        ) ? registrationSignerId : null;
        const ownership = localSignerId === null
          ? { localSignerId: null, entitySeed: null }
          : {
              localSignerId,
              entitySeed: xln.canonicalEntitySeed(requireSharedEntitySeed(vault?.seed)),
            };
        const registration = await registerActiveNumberedEntities(
          {
            jurisdictionRef: selectedJurisdiction,
            payerSignerId: registrationSignerId,
            entities: [{
              name: entityName,
              validators: boardMembers,
              threshold: thresholdBigInt,
              ...ownership,
              profileName: entityName,
            }],
          },
          vaultRuntimeId,
        );
        const creation = registration.entities[0];
        if (!creation) throw new Error('NUMBERED_ENTITY_REGISTRATION_RESULT_MISSING');
        config = creation.config;
        entityId = creation.entityId;
        numberedImported = creation.imported;
      }

      const localSignerId = mySignerAddress.toLowerCase();
      const localBoardIndex = config.validators.findIndex(
        (member) => member.toLowerCase() === localSignerId,
      );
      if (entityType === 'lazy' && localBoardIndex >= 0) {
        if (!vault?.seed) throw new Error('ENTITY_IMPORT_RUNTIME_SEED_REQUIRED');
        await submitRuntimeInput({
          runtimeTxs: [xln.importEntity({
            entityId,
            signerId: localSignerId,
            entitySeed: vault.seed,
            data: {
              config,
              isProposer: localBoardIndex === 0,
              profileName: entityName,
            },
          })],
          entityInputs: [],
        });
        tabOperations.addTab(entityId, localSignerId, selectedJurisdiction);
        success = `Entity created: ${formatShortId(entityId)}`;
      } else if (entityType === 'numbered' && numberedImported) {
        tabOperations.addTab(entityId, localSignerId, selectedJurisdiction);
        success = `Entity created: ${formatShortId(entityId)}`;
      } else {
        success = `Board created: ${formatShortId(entityId)}. Import this configuration in a member wallet.`;
      }

      // Callback
      if (onCreated) onCreated(entityId);
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
    entityName = '';
    entityType = 'numbered';
    boardMode = 'personal';
    validators = [{ name: mySignerAddress, weight: 1 }];
    threshold = 1;
    userModifiedThreshold = false;
  }

</script>

<div class="formation-panel" data-testid="entity-formation-panel">
  <header class="panel-header">
    <div>
      <p class="eyebrow">New subject</p>
      <h3>Create Entity</h3>
      <p class="header-copy">Every person, company, and hub starts as the same Entity.</p>
    </div>
  </header>

  <div class="field">
    <div class="field-label">1 · Jurisdiction</div>
    {#if selectableJurisdictions.length === 0}
      <div class="empty-hint">
        {entityType === 'numbered'
          ? 'Numbered registration is not available on the connected jurisdictions.'
          : 'No jurisdictions available. Add one first.'}
      </div>
    {:else}
      <div class="jurisdiction-list">
        {#each selectableJurisdictions as j}
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
    <div class="field-label">2 · Entity name</div>
    <input type="text" bind:value={entityName} placeholder="e.g., ACME" />
    <p class="field-hint">A display name only. The canonical identity comes from registration and the board.</p>
  </div>

  <div class="field">
    <div class="field-label">3 · Control</div>
    <div class="type-selector">
      <button data-testid="formation-personal" class="type-option" class:active={boardMode === 'personal'} on:click={selectPersonalBoard}>
        <UserRound size={18} /><span>Personal</span><small>One Runtime signer</small>
      </button>
      <button data-testid="formation-shared" class="type-option" class:active={boardMode === 'shared'} on:click={selectSharedBoard}>
        <UsersRound size={18} /><span>Shared board</span><small>Weighted multisig</small>
      </button>
    </div>
  </div>

  {#if boardMode === 'personal'}
    <div class="personal-signer">
      <small>Runtime signer</small>
      <code>{mySignerAddress || 'Unlock a Runtime signer first'}</code>
    </div>
  {:else}
  <div class="field">
    <div class="field-label">Board members ({validators.length})</div>
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
            aria-label={`Board member ${idx + 1} weight`}
          />
          <button class="v-remove" aria-label={`Remove board member ${idx + 1}`} on:click={() => removeValidator(idx)} disabled={validators.length <= 1}>
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
          aria-label="Board signing threshold"
        />
        <span class="threshold-display">{threshold} of {totalWeight}</span>
      </div>
      <p class="field-hint">
        {threshold === totalWeight ? 'All validators must sign' : `${threshold} weight required to sign`}
      </p>
    </div>
  {/if}
  {/if}

  <details class="advanced">
    <summary>Advanced identity settings</summary>
    <div class="advanced-content">
      <div class="field">
        <div class="field-label">Registration</div>
        <div class="type-selector">
          <button class="type-option" class:active={entityType === 'numbered'} on:click={() => entityType = 'numbered'}>
            <Hash size={16} /><span>Numbered</span><small>Registered on-chain</small>
          </button>
          <button class="type-option" class:active={entityType === 'lazy'} on:click={() => entityType = 'lazy'}>
            <Zap size={16} /><span>Lazy</span><small>Board hash identity</small>
          </button>
        </div>
      </div>
      {#if entityType === 'lazy'}
        <div class="preview-box">
          <div class="preview-label">Canonical Board Hash</div>
          <code>{quorumHash}</code>
          <small>This hash becomes your entity ID</small>
        </div>
      {/if}
    </div>
  </details>

  {#if previewError}
    <div class="message error">{previewError}</div>
  {/if}

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
      disabled={creating || !entityName.trim() || !selectedJurisdiction || formationValidators.some(validator => !validator.name) || Boolean(previewError)}
    >
      {creating ? 'Creating...' : 'Create Entity'}
    </button>
  </div>
</div>

<style>
  .formation-panel {
    display: flex;
    flex-direction: column;
    gap: 20px;
    width: min(100%, 760px);
    margin: 0 auto;
    padding: clamp(18px, 3vw, 28px);
    box-sizing: border-box;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 78%, transparent);
    border-radius: 18px;
    background: color-mix(in srgb, var(--theme-surface, #18181b) 72%, transparent);
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

  .eyebrow, .header-copy { margin: 0; }
  .eyebrow {
    color: var(--theme-accent, #fbbf24);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .12em;
    text-transform: uppercase;
  }
  .header-copy {
    margin-top: 5px;
    color: var(--theme-text-muted, #71717a);
    font-size: 11px;
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

  .personal-signer {
    display: grid;
    gap: 6px;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent);
  }

  .personal-signer small { color: var(--theme-text-muted, #71717a); font-size: 10px; text-transform: uppercase; }
  .personal-signer code { color: var(--theme-text-secondary, #a1a1aa); font-size: 11px; overflow-wrap: anywhere; }

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

  .advanced {
    padding: 12px 14px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent);
    border-radius: 10px;
  }

  .advanced summary {
    cursor: pointer;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 11px;
    font-weight: 600;
  }

  .advanced-content {
    display: grid;
    gap: 14px;
    margin-top: 14px;
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

  @media (max-width: 560px) {
    .formation-panel { padding: 16px; border-radius: 14px; }
    .type-selector { grid-template-columns: 1fr; }
    .validator-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; }
    .v-weight { grid-column: 2 / 3; width: auto; }
  }
</style>
