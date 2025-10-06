<script lang="ts">
  import { onMount } from 'svelte';
  import { getXLN, xlnEnvironment } from '../../stores/xlnStore';
  import { loadJurisdictions } from '../../stores/jurisdictionStore';
  import { tabOperations } from '../../stores/tabStore';
  import type { EntityFormData } from '$lib/types/ui';
  import { xlnFunctions } from '../../stores/xlnStore';

  let formData: EntityFormData = {
    jurisdiction: '',
    entityType: 'numbered',
    entityName: 'ACME',
    validators: [{ name: 's1', weight: 1 }],
    threshold: 1 // Will be updated to match total weight on load
  };

  let isCreating = false;
  let error = '';
  let userModifiedThreshold = false; // Track if user manually changed threshold

  // Set initial threshold to max on component mount
  onMount(async () => {
    const initialTotalWeight = formData.validators.reduce((sum, v) => sum + v.weight, 0);
    formData.threshold = initialTotalWeight;
    
    // Load jurisdiction options from server
    await loadJurisdictionOptions();
  });

  function addValidator() {
    formData.validators = [...formData.validators, { name: '', weight: 1 }];
    // Auto-set threshold to max when validators change
    updateThresholdToMax();
  }

  function removeValidator(index: number) {
    if (formData.validators.length > 1) {
      formData.validators = formData.validators.filter((_, i) => i !== index);
      // Handle threshold based on remaining validators
      if (formData.validators.length === 1) {
        updateThresholdForSingleValidator();
      } else {
        updateThresholdToMax();
      }
    }
  }

  function updateTotalWeight() {
    const totalWeight = formData.validators.reduce((sum, v) => sum + v.weight, 0);
    if (formData.threshold > totalWeight) {
      formData.threshold = totalWeight;
    }
  }

  function updateThresholdToMax() {
    // Set threshold to maximum (total weight) whenever validators or weights change
    const totalWeight = formData.validators.reduce((sum, v) => sum + v.weight, 0);
    formData.threshold = totalWeight;
    userModifiedThreshold = false; // Reset flag since this is an auto-update
  }

  function updateThresholdForSingleValidator() {
    // When there's only one validator, threshold must be 1
    if (formData.validators.length === 1) {
      formData.threshold = 1;
      userModifiedThreshold = false;
    }
  }

  function onThresholdChange() {
    // User manually changed threshold
    userModifiedThreshold = true;
  }

  async function createEntity() {
    if (isCreating) return;
    
    error = '';
    isCreating = true;

    try {
      // Validate form
      if (!formData.entityName.trim()) {
        throw new Error('Entity name is required');
      }

      if (formData.validators.some(v => !v.name.trim())) {
        throw new Error('All validators must have names');
      }

      const totalWeight = formData.validators.reduce((sum, v) => sum + v.weight, 0);
      if (formData.threshold > totalWeight) {
        throw new Error('Threshold cannot exceed total weight');
      }

      // Create entity using proper server workflow
      const xln = await getXLN();
      const env = $xlnEnvironment;
      
      if (!env) {
        throw new Error('XLN environment not ready');
      }
      
      const validatorNames = formData.validators.map(v => v.name);
      const threshold = BigInt(formData.threshold);
      
      // Get the full jurisdiction config from our stored data
      const jurisdictionConfig = jurisdictionData[formData.jurisdiction];
      if (!jurisdictionConfig) {
        throw new Error('Selected jurisdiction not found');
      }

      // Convert to the format expected by the backend
      const formattedJurisdiction = {
        name: jurisdictionConfig.name,
        address: jurisdictionConfig.rpc,
        entityProviderAddress: jurisdictionConfig.contracts.entityProvider,
        depositoryAddress: jurisdictionConfig.contracts.depository,
        chainId: jurisdictionConfig.chainId
      };
      
      let config: any;
      let entityId: string;
      
      if (formData.entityType === 'lazy') {
        // For lazy entities, we need to generate the ID separately
        entityId = xln.generateLazyEntityId(validatorNames, threshold);
        
        // Check if this board hash is already used
        const existingReplicas = Array.from(env.replicas.keys()) as string[];
        const isDuplicate = existingReplicas.some((key: string) => key.startsWith(entityId + ':'));
        
        if (isDuplicate) {
          throw new Error(`⚠️ This validator configuration already exists! Entity #${$xlnFunctions!.getEntityNumber(entityId)} is already in use. Try different validators or weights to create a unique entity.`);
        }
        
        config = xln.createLazyEntity(formData.entityName, validatorNames, threshold, formattedJurisdiction);
        console.log('✅ Lazy entity config created:', config);
        console.log('✅ Entity ID: #', $xlnFunctions!.getEntityNumber(entityId));
      } else {
        const creation = await xln.createNumberedEntity(formData.entityName, validatorNames, threshold, formattedJurisdiction);
        config = creation.config;
        entityId = creation.entityId; // Use the returned entityId
        console.log('✅ Numbered entity config created:', creation);
      }
      
      // Create serverTxs to import replicas for each validator  
      console.log(`🔍 Creating serverTxs with entityId: ${entityId}`);
      const serverTxs = validatorNames.map((signerId, index) => ({
        type: 'importReplica' as const,
        entityId: entityId,
        signerId,
        data: {
          config,
          isProposer: index === 0 // First validator is proposer
        }
      }));
      
      console.log(`🔍 Generated ${serverTxs.length} serverTxs:`, serverTxs);
      
      // Apply to server and process until empty
      const result = await xln.applyServerInput(env, {
        serverTxs,
        entityInputs: []
      });
      
      console.log('🔥 Processing entity creation through server...');
      await xln.processUntilEmpty(env, result.entityOutbox);
      console.log('✅ Entity creation complete!');

      console.log(`💰 Entity #${$xlnFunctions!.getEntityNumber(entityId)} automatically prefunded by Depository.sol contract during deployment`);
      console.log(`🔄 J-Watcher will sync historical ReserveUpdated events to populate reserves`);

      // Auto-create panels with entity and signers pre-selected
      const jurisdictionName = jurisdictionConfig?.name || 'Unknown';
      
      console.log(`🎯 Auto-creating ${validatorNames.length} panels with entity and signers pre-selected`);
      console.log(`🌐 Jurisdiction: ${formData.jurisdiction} → ${jurisdictionName}`);
      
      for (let i = 0; i < validatorNames.length; i++) {
        const signer = validatorNames[i];
        console.log(`📋 Creating panel ${i + 1} for Entity #${$xlnFunctions!.getEntityNumber(entityId as string)} with signerId: ${signer} on ${jurisdictionName}`);
        tabOperations.addTab(entityId as string, signer, jurisdictionName);
      }
      
      console.log(`✅ ${validatorNames.length} panels auto-created with replicas selected!`);

      // Reset form on success
      clearForm();
      
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create entity';
    } finally {
      isCreating = false;
    }
  }

  function clearForm() {
    formData = {
      jurisdiction: '',
      entityType: 'numbered',
      entityName: 'ACME',
      validators: [{ name: 's1', weight: 1 }],
      threshold: 1
    };
    error = '';
    userModifiedThreshold = false; // Reset threshold tracking
    
    // Set threshold to max after reset
    const totalWeight = formData.validators.reduce((sum, v) => sum + v.weight, 0);
    formData.threshold = totalWeight;
  }

  // Reactive updates
  $: totalWeight = formData.validators.reduce((sum, v) => sum + v.weight, 0);
  $: if (formData.threshold > totalWeight) formData.threshold = totalWeight;
  
  // Auto-set threshold based on number of validators and weights
  $: {
    const newTotalWeight = formData.validators.reduce((sum, v) => sum + v.weight, 0);
    // Auto-update threshold if user hasn't manually changed it
    if (!userModifiedThreshold && newTotalWeight > 0) {
      if (formData.validators.length === 1) {
        formData.threshold = 1; // Single validator always has threshold 1
      } else {
        formData.threshold = newTotalWeight; // Multiple validators default to max
      }
    }
  }

  // Calculate quorum hash for lazy entities
  $: quorumHash = formData.entityType === 'lazy' ? calculateQuorumHash(formData.validators, formData.threshold) : '';
  
  // Calculate expected entity ID
  $: expectedEntityId = calculateExpectedEntityId(formData.entityType, quorumHash);

  function calculateQuorumHash(validators: Array<{name: string, weight: number}>, threshold: number): string {
    // This is a simplified hash calculation for demo purposes
    const validatorString = validators.map(v => `${v.name}:${v.weight}`).sort().join(',');
    const hashInput = `${validatorString}|${threshold}`;
    // Simple hash function (in real implementation, use proper cryptographic hash)
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
      const char = hashInput.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  function calculateExpectedEntityId(entityType: string, quorumHash: string): string {
    if (entityType === 'lazy') {
      return `0x${quorumHash}`;
    } else if (entityType === 'numbered') {
      return '#42'; // Placeholder for next sequential number
    } else {
      return 'custom-name'; // Placeholder for named entity
    }
  }

  let jurisdictionOptions: Array<{ value: string; label: string }> = [];
  let jurisdictionData: Record<string, any> = {}; // Store full jurisdiction data

  // Load jurisdiction options from centralized store (single source of truth)
  async function loadJurisdictionOptions() {
    try {
      // Use the centralized jurisdictionStore instead of fetching directly
      const config = await loadJurisdictions();

      jurisdictionOptions = Object.entries(config.jurisdictions).map(([, data]: [string, any]) => {
        const port = data.rpc.split(':').pop();
        jurisdictionData[port] = data; // Store full jurisdiction data by port
        return {
          value: port, // Use port as value
          label: `${data.name} (Port ${port})`
        };
      });

      // Default to Ethereum (8545) instead of first option
      if (jurisdictionOptions.length > 0 && !formData.jurisdiction) {
        const ethereumOption = jurisdictionOptions.find(j => j.label.includes('Ethereum'));
        formData.jurisdiction = ethereumOption ? ethereumOption.value : (jurisdictionOptions[0]?.value || '');
        console.log('🔍 Defaulted jurisdiction to:', formData.jurisdiction);
      }

      console.log(`✅ Loaded ${jurisdictionOptions.length} jurisdiction options from store:`, jurisdictionOptions);
    } catch (error) {
      console.error('❌ Failed to load jurisdiction options:', error);
      jurisdictionOptions = [];
    }
  }

</script>

<div class="entity-formation">
  <div class="formation-panel">
    <div class="formation-group">
      <label for="jurisdictionSelect">🏛️ Jurisdiction:</label>
      <select id="jurisdictionSelect" bind:value={formData.jurisdiction}>
        {#each jurisdictionOptions as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
      <div class="jurisdiction-info">
        <small>
          <strong>📡 Network:</strong> {jurisdictionOptions.find(j => j.value === formData.jurisdiction)?.label.split(' (')[0] || 'Unknown'}<br>
          <strong>🔗 RPC Port:</strong> {formData.jurisdiction}
        </small>
      </div>
    </div>

    <div class="formation-group">
      <label for="entityTypeSelect">🆔 Entity Type:</label>
      <select id="entityTypeSelect" bind:value={formData.entityType}>
        <option value="numbered">🔢 Numbered Entity (Gas Required - Sequential ID) [PREFUNDED]</option>
        <option value="lazy">🔒 Lazy Entity (Free - ID = Quorum Hash)</option>
        <option value="named">🏷️ Named Entity (Premium Gas + Admin Approval)</option>
      </select>
      <div class="entity-type-info">
        <small>
          {#if formData.entityType === 'lazy'}
            <strong>🔒 Lazy:</strong> Free to create, entityId = hash(validators), works immediately.
          {:else if formData.entityType === 'numbered'}
            <strong>🔢 Numbered:</strong> Small gas cost, get sequential number like #42, on-chain registered. <strong>✨ PREFUNDED with 1M tokens for testing!</strong>
          {:else}
            <strong>🏷️ Named:</strong> Premium gas + admin approval, get custom name like "coinbase".
          {/if}
        </small>
      </div>
    </div>
    
    <div class="formation-group">
      <label for="entityNameInput">🏷️ Entity Name:</label>
      <input 
        type="text" 
        id="entityNameInput" 
        bind:value={formData.entityName}
        placeholder="e.g., trading, chat, governance"
      >
      <small>Display name for your entity</small>
    </div>
    
    <div class="validators-section">
      <h4>👥 Validators:</h4>
      <div class="validators-list">
        {#each formData.validators as validator, index}
          <div class="validator-row">
            <select bind:value={validator.name} class="validator-name">
              <option value="">Select signer...</option>
              <option value="s1">s1 (Default)</option>
              <option value="s2">s2</option>
              <option value="s3">s3</option>
              <option value="s4">s4</option>
              <option value="s5">s5</option>
            </select>
            <input 
              type="number" 
              bind:value={validator.weight}
              on:input={() => {
                updateTotalWeight();
                if (!userModifiedThreshold) updateThresholdToMax();
              }}
              class="validator-weight" 
              min="1" 
              placeholder="1"
            >
            {#if formData.validators.length > 1}
              <button 
                type="button" 
                class="btn btn-danger btn-small" 
                on:click={() => removeValidator(index)}
              >
                ❌
              </button>
            {/if}
          </div>
        {/each}
      </div>
      <button type="button" class="btn btn-secondary" on:click={addValidator}>
        ➕ Add Validator
      </button>
      <small>💡 Start with a single signer for personal use, or add more for multisig/corporate entities</small>
    </div>
    
    {#if formData.validators.length > 1}
      <div class="threshold-section">
        <label for="thresholdSlider">🎯 Threshold: {formData.threshold}</label>
        <input 
          type="range" 
          id="thresholdSlider" 
          bind:value={formData.threshold}
          on:input={onThresholdChange}
          min="1" 
          max={totalWeight}
          class="threshold-slider"
        >
        <div class="threshold-info">
          <span>Total Weight: <strong>{totalWeight}</strong></span>
          <span>Required: <strong>{formData.threshold}</strong></span>
        </div>
      </div>
    {/if}

    {#if formData.entityType === 'lazy'}
      <div class="quorum-hash-section">
        <h4>🔐 Quorum Hash</h4>
        <div class="hash-display">
          <code>{quorumHash}</code>
        </div>
        <small>This hash is calculated from your validators and threshold. It will be your entity ID.</small>
      </div>
    {/if}

    <div class="expected-id-section">
      <h4>🆔 Expected Entity ID</h4>
      <div class="id-display">
        <code>{expectedEntityId}</code>
      </div>
      <small>
        {#if formData.entityType === 'lazy'}
          This will be your entity's unique identifier, derived from the quorum hash.
        {:else if formData.entityType === 'numbered'}
          This will be your entity's sequential number (actual number may vary).
        {:else}
          This will be your custom entity name (subject to admin approval).
        {/if}
      </small>
    </div>
    
    {#if error}
      <div class="error-message">
        ❌ {error}
      </div>
    {/if}
    
    <div class="button-group">
      <button 
        class="btn btn-primary" 
        on:click={createEntity}
        disabled={isCreating}
      >
        {isCreating ? '🔄 Creating...' : '🚀 Create Entity'}
      </button>
      <button class="btn btn-secondary" on:click={clearForm} disabled={isCreating}>
        🗑️ Clear Form
      </button>
    </div>
  </div>
</div>

<style>
  .entity-formation {
    padding: 20px;
  }

  .formation-panel {
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-width: 800px;
  }

  .formation-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .formation-group label {
    font-weight: bold;
    color: #d4d4d4;
    font-size: 0.9em;
  }

  .formation-group input, 
  .formation-group select {
    padding: 8px 12px;
    border: 2px solid #555;
    border-radius: 6px;
    font-size: 14px;
    background: #1e1e1e;
    color: #d4d4d4;
    transition: border-color 0.3s ease;
  }

  .formation-group input:focus, 
  .formation-group select:focus {
    outline: none;
    border-color: #007acc;
  }

  .jurisdiction-info,
  .entity-type-info {
    padding: 8px;
    background: #2a2a2a;
    border-left: 3px solid #007acc;
    border-radius: 4px;
    margin-top: 4px;
  }

  .jurisdiction-info small,
  .entity-type-info small {
    color: #9d9d9d;
    font-size: 0.8em;
    line-height: 1.4;
  }

  .validators-section {
    background: #2a2a2a;
    padding: 20px;
    border-radius: 8px;
    border: 1px solid #3e3e3e;
  }

  .validators-section h4 {
    margin: 0 0 15px 0;
    color: #d4d4d4;
    font-size: 1.1em;
  }

  .validators-list {
    display: flex;
    flex-direction: column;
    gap: 15px;
    margin-bottom: 20px;
  }

  .validator-row {
    display: flex;
    gap: 12px;
    align-items: center;
    background: #1e1e1e;
    padding: 15px;
    border-radius: 8px;
    border: 1px solid #3e3e3e;
  }

  .validator-name {
    flex: 2;
    min-height: 45px;
  }

  .validator-weight {
    flex: 1;
    max-width: 100px;
    min-height: 45px;
  }

  .threshold-section {
    background: #2a2a2a;
    padding: 15px;
    border-radius: 8px;
    border: 1px solid #3e3e3e;
  }

  .threshold-section label {
    display: block;
    margin-bottom: 10px;
    font-weight: bold;
    color: #d4d4d4;
  }

  .threshold-slider {
    width: 100%;
    height: 6px;
    border-radius: 3px;
    background: #555;
    outline: none;
    margin-bottom: 10px;
    -webkit-appearance: none;
    appearance: none;
  }

  .threshold-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #007acc;
    cursor: pointer;
  }

  .threshold-slider::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #007acc;
    cursor: pointer;
    border: none;
  }

  .threshold-info {
    display: flex;
    justify-content: space-between;
    color: #9d9d9d;
    font-size: 0.85em;
  }

  .threshold-info strong {
    color: #007acc;
  }

  .quorum-hash-section,
  .expected-id-section {
    background: #2a2a2a;
    padding: 15px;
    border-radius: 8px;
    border: 1px solid #3e3e3e;
  }

  .quorum-hash-section h4,
  .expected-id-section h4 {
    margin: 0 0 10px 0;
    color: #d4d4d4;
    font-size: 1em;
  }

  .hash-display,
  .id-display {
    background: #1e1e1e;
    border: 2px solid #007acc;
    border-radius: 6px;
    padding: 12px;
    margin-bottom: 8px;
  }

  .hash-display code,
  .id-display code {
    color: #00ff88;
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
    font-size: 14px;
    font-weight: bold;
    word-break: break-all;
  }

  .button-group {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .btn {
    padding: 10px 20px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    font-weight: bold;
    transition: all 0.3s ease;
  }

  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-primary {
    background: #007acc;
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: #0086e6;
  }

  .btn-secondary {
    background-color: #6c757d;
    color: white;
  }

  .btn-secondary:hover:not(:disabled) {
    background-color: #5a6268;
  }

  .btn-danger {
    background: #dc3545;
    color: white;
    padding: 4px 8px;
    font-size: 12px;
  }

  .btn-danger:hover {
    background: #c82333;
  }

  .btn-small {
    padding: 4px 8px;
    font-size: 12px;
    min-width: auto;
  }

  .error-message {
    background: rgba(220, 53, 69, 0.1);
    border: 1px solid rgba(220, 53, 69, 0.3);
    border-radius: 4px;
    padding: 12px;
    color: #dc3545;
    font-size: 0.9em;
  }

  small {
    color: #9d9d9d;
    font-size: 0.8em;
    margin-top: 4px;
    display: block;
  }
</style>
