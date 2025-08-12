<script lang="ts">
  import { onMount } from 'svelte';
  import {
    initEnvFromBrowser,
    createLazyEntity,
    createNumberedEntity,
    xln,
    getAvailableJurisdictions,
    getJurisdictionByPort,
    getNextEntityNumber,
    getCurrentXLN
  } from '../stores/xln';

  export let idPrefix = '';
  let entityType: 'lazy' | 'numbered' | 'named' = 'lazy';
  let entityName = 'ACME';
  let threshold = 1;
  let validators: Array<{ signer: string; weight: number }> = [
    { signer: 'alice', weight: 1 }
  ];
  let jurisdiction: any = null;
  let jurisdictions: Map<string, any> = new Map();
  let nextNumber: number | null = null;
  let runtimeReady = false;
  let XLN: any;
  let registerOnChain = false;

  onMount(async () => {
    await initEnvFromBrowser();
    xln.subscribe((mod) => (XLN = mod));
    runtimeReady = Boolean(getCurrentXLN());
    if (runtimeReady) {
      jurisdictions = await getAvailableJurisdictions();
      jurisdiction = jurisdictions.get('8545') ?? Array.from(jurisdictions.values())[0] ?? null;
      if (jurisdiction) nextNumber = await getNextEntityNumber(jurisdiction);
    }
  });

  function addValidator() {
    validators = [...validators, { signer: 'bob', weight: 1 }];
    updateThresholdMax();
  }
  function removeValidator(i: number) {
    validators = validators.filter((_, idx) => idx !== i);
    updateThresholdMax();
  }

  async function onCreate() {
    if (!getCurrentXLN()) {
      alert('Runtime not loaded. Click "Load Runtime" or set localStorage xln_use_dist_server=1 and reload.');
      return;
    }
    if (entityType === 'lazy') {
      await createLazyEntity(entityName, validators, threshold, jurisdiction);
      return;
    }
    if (entityType === 'numbered') {
      if (!jurisdiction) { alert('Select a jurisdiction'); return; }
      await createNumberedEntity(entityName, validators, threshold, jurisdiction, { registerOnChain });
      nextNumber = await getNextEntityNumber(jurisdiction);
      return;
    }
    alert('Named entities not yet supported in UI');
  }

  async function onJurisdictionChange(e: Event) {
    const port = (e.target as HTMLSelectElement).value;
    jurisdiction = await getJurisdictionByPort(port);
    nextNumber = jurisdiction ? await getNextEntityNumber(jurisdiction) : null;
  }

  function loadRuntime() {
    localStorage.setItem('xln_use_dist_server', '1');
    location.reload();
  }

  function sumWeights() {
    return validators.reduce((sum, v) => sum + Number(v.weight || 0), 0);
  }

  function updateThresholdMax() {
    const total = sumWeights();
    if (threshold > total) threshold = total || 1;
  }

  $: updateThresholdMax();
</script>

<div class="space-y-3" id="formationTabContent">
  <div class="bg-panel border border-outline rounded p-3">
    <div class="mb-2">
      <label class="block text-sm" for="entityTypeSelect">🆔 Entity Type</label>
      <select id="entityTypeSelect" class="bg-surface border border-outline rounded px-2 py-1"
        bind:value={entityType}>
        <option value="lazy">🔒 Lazy</option>
        <option value="numbered">🔢 Numbered</option>
        <option value="named" disabled>🏷️ Named</option>
      </select>
    </div>

    <div class="mb-2">
      <label class="block text-sm" for="jurisdictionSelect">🏛️ Jurisdiction</label>
      <select id="jurisdictionSelect" class="bg-surface border border-outline rounded px-2 py-1" on:change={onJurisdictionChange} disabled={!runtimeReady}>
        {#if runtimeReady && jurisdictions.size > 0}
          {#each Array.from(jurisdictions.entries()) as [port, j]}
            <option value={port} selected={jurisdiction && jurisdictions.get(port) === jurisdiction}>{j.name} (Port {port})</option>
          {/each}
        {:else}
          <option value="">Runtime not loaded</option>
        {/if}
      </select>
      <div id="nextNumberInfo" class="text-xs text-green-300 mt-1" style="display: block;">
        {#if nextNumber !== null}
          🔢 Next Available Number: <span id="nextNumberDisplay">#{nextNumber}</span>
        {:else}
          <span class="text-gray-400">Select jurisdiction (or load runtime)</span>
        {/if}
      </div>
      {#if entityType === 'numbered'}
        <label class="flex items-center gap-2 text-xs mt-1">
          <input type="checkbox" bind:checked={registerOnChain} /> Register on-chain (uses local Hardhat)
        </label>
      {/if}
    </div>

    <div class="mb-2">
      <label class="block text-sm" for="entityNameInput">🏷️ Entity Name</label>
      <input id="entityNameInput" class="w-full bg-surface border border-outline rounded px-2 py-1"
        bind:value={entityName} />
    </div>

    <div class="mb-2">
      <label class="block text-sm" for="validatorsList">👥 Validators</label>
      <div id="validatorsList" class="space-y-2">
        {#each validators as v, i}
          <div class="flex gap-2 items-center validator-row" data-validator-id={i}>
            <input aria-label="Signer" class="bg-surface border border-outline rounded px-2 py-1 w-36" bind:value={v.signer} />
            <input aria-label="Weight" type="number" min="1" class="bg-surface border border-outline rounded px-2 py-1 w-24 validator-weight" bind:value={v.weight} on:change={updateThresholdMax} />
            {#if validators.length > 1}
              <button class="px-2 py-1 border border-outline rounded" on:click={() => removeValidator(i)}>❌</button>
            {/if}
          </div>
        {/each}
      </div>
      <button class="mt-2 px-2 py-1 border border-outline rounded" on:click={addValidator}>➕ Add New Validator</button>
    </div>

    <div class="mb-2">
      <label class="block text-sm" for="thresholdSlider">🎯 Threshold: <span id="thresholdValue">{threshold}</span> / {sumWeights()}</label>
      <input id="thresholdSlider" type="range" min="1" max={Math.max(1, sumWeights())} bind:value={threshold} />
    </div>

    <div class="mt-3 flex gap-2">
      <button class="btn btn-primary border border-outline rounded px-3 py-1" id="createEntityBtn" on:click={onCreate}>🚀 Create Entity</button>
      {#if !runtimeReady}
        <button class="border border-outline rounded px-3 py-1" on:click={loadRuntime}>Load Runtime</button>
      {/if}
    </div>
  </div>
</div>


