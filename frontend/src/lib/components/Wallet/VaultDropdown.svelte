<script lang="ts">
  import Dropdown from '$lib/components/UI/Dropdown.svelte';
  import { activeVault, activeSigner, allVaults, vaultOperations } from '$lib/stores/vaultStore';
  import { vaultUiOperations } from '$lib/stores/vaultUiStore';

  let isOpen = false;

  $: currentRuntime = $activeVault;
  $: currentSigner = $activeSigner;
  $: savedRuntimes = $allVaults;

  $: displayRuntime = currentRuntime?.label || 'Runtime';
  $: displaySigner = currentSigner?.name || 'Signer';
  $: displayAddress = currentSigner?.address ? `${currentSigner.address.slice(0, 6)}...${currentSigner.address.slice(-4)}` : '';

  function selectSigner(index: number) {
    vaultOperations.selectSigner(index);
    isOpen = false;
  }

  function addSigner() {
    const newSigner = vaultOperations.addSigner();
    if (newSigner) {
      vaultOperations.selectSigner(newSigner.index);
    }
    isOpen = false;
  }

  function switchToRuntime(runtimeId: string) {
    vaultOperations.selectRuntime(runtimeId);
    isOpen = false;
  }

  function deriveNewRuntime() {
    vaultUiOperations.requestDeriveNewVault();
    isOpen = false;
  }
</script>

<Dropdown bind:open={isOpen} minWidth={220} maxWidth={340}>
  <span slot="trigger" class="trigger-content">
    <span class="trigger-label">{displayRuntime}</span>
    <span class="trigger-sep">·</span>
    <span class="trigger-meta">{displaySigner}</span>
    {#if displayAddress}
      <span class="trigger-addr">{displayAddress}</span>
    {/if}
    <span class="trigger-arrow" class:open={isOpen}>▼</span>
  </span>

  <div slot="menu" class="menu-content">
    {#if currentRuntime}
      <div class="menu-section">Signers</div>
      {#each currentRuntime.signers as signer (signer.index)}
        <button
          class="menu-item"
          class:selected={signer.index === currentSigner?.index}
          on:click={() => selectSigner(signer.index)}
        >
          <span class="menu-label">{signer.name}</span>
          <span class="menu-meta">{signer.address.slice(0, 6)}...{signer.address.slice(-4)}</span>
        </button>
      {/each}
      <button class="menu-item add-item" on:click={addSigner}>
        <span class="menu-label">+ Add Signer</span>
      </button>
    {/if}

    {#if savedRuntimes.some(r => r.id !== currentRuntime?.id)}
      <div class="menu-divider"></div>
      <div class="menu-section">Other Runtimes</div>
      {#each savedRuntimes.filter(r => r.id !== currentRuntime?.id) as runtime}
        <button class="menu-item" on:click={() => switchToRuntime(runtime.id)}>
          <span class="menu-label">{runtime.label}</span>
          <span class="menu-meta">{runtime.signers.length} signers</span>
        </button>
      {/each}
    {/if}

    <div class="menu-divider"></div>
    <button class="menu-item add-item" on:click={deriveNewRuntime}>
      <span class="menu-label">+ Derive New Runtime</span>
    </button>
  </div>
</Dropdown>

<style>
  .trigger-content {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .trigger-label {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trigger-sep {
    color: #666;
  }

  .trigger-meta {
    color: #b5b5b5;
    font-size: 12px;
  }

  .trigger-addr {
    color: #7aa8ff;
    font-size: 11px;
    font-family: 'SF Mono', Consolas, monospace;
  }

  .trigger-arrow {
    margin-left: auto;
    color: #888;
    font-size: 10px;
    transition: transform 0.2s;
  }

  .trigger-arrow.open {
    transform: rotate(180deg);
  }

  .menu-content {
    padding: 4px;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: #e1e1e1;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.12s;
    text-align: left;
  }

  .menu-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .menu-item.selected {
    background: rgba(0, 122, 255, 0.18);
  }

  .menu-label {
    flex: 1;
  }

  .menu-meta {
    font-size: 11px;
    color: #7aa8ff;
  }

  .menu-divider {
    height: 1px;
    background: #333;
    margin: 4px 8px;
  }

  .menu-section {
    padding: 6px 12px;
    font-size: 11px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .add-item {
    color: #7aa8ff;
  }
</style>
