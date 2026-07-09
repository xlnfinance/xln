<script lang="ts">
  /**
   * RuntimeDropdown - Runtime selector (local + remote)
   * Uses unified Dropdown base component.
  */
  import { createEventDispatcher } from 'svelte';
  import { Compass, Plus, Trash2 } from 'lucide-svelte';
  import Dropdown from '$lib/components/UI/Dropdown.svelte';
  import {
    activeRuntime as activeVaultRuntime,
    allRuntimes as allVaultRuntimes,
    vaultOperations,
  } from '$lib/stores/vaultStore';
  import {
    activeRuntime as activeStoreRuntime,
    activeRuntimeId,
    runtimes as runtimeStoreRuntimes,
    runtimeOperations,
  } from '$lib/stores/runtimeStore';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { p2pState } from '$lib/stores/xlnStore';
  import { settings } from '$lib/stores/settingsStore';
  import {
    buildRuntimeDropdownEntries,
    shortRuntimeId,
    type RuntimeDotStatus,
    type RuntimeDropdownEntry,
  } from './runtime-dropdown-view';

  export let allowAdd = false;
  export let allowDelete = false;
  export let addLabel = '+ Add Runtime';

  let isOpen = false;
  const dispatch = createEventDispatcher();

  $: connStatus = ($p2pState.connected ? 'connected' : $p2pState.reconnect ? 'reconnecting' : 'disconnected') as RuntimeDotStatus;
  $: runtimeAdapterDotStatus = ($runtimeControllerHandle.status === 'connected'
    ? 'connected'
    : $runtimeControllerHandle.status === 'connecting'
      ? 'reconnecting'
      : $runtimeControllerHandle.status === 'error'
        ? 'error'
        : 'disconnected') as RuntimeDotStatus;
  $: relayUrl = $settings.relayUrl;
  $: remoteRuntimes = Array.from($runtimeStoreRuntimes.values()).filter((runtime) => runtime.type === 'remote');
  $: runtimeEntries = buildRuntimeDropdownEntries({
    remoteRuntimes,
    vaultRuntimes: $allVaultRuntimes,
    activeRuntimeId: $activeRuntimeId,
    connStatus,
    runtimeAdapterDotStatus,
    runtimeControllerEndpoint: $runtimeControllerHandle.endpoint,
  });
  $: currentRemoteRuntime = $activeStoreRuntime?.type === 'remote' || $runtimeControllerHandle.mode === 'remote'
    ? ($activeStoreRuntime?.type === 'remote' ? $activeStoreRuntime : remoteRuntimes[0] ?? null)
    : null;
  $: currentRuntimeId = currentRemoteRuntime?.id ?? $activeVaultRuntime?.id ?? '';
  $: currentRuntime = runtimeEntries.find((runtime) => runtime.id === currentRuntimeId) ?? null;

  async function selectRuntime(entry: RuntimeDropdownEntry): Promise<void> {
    if (entry.source === 'remote') {
      await runtimeOperations.selectRuntime(entry.id);
    } else {
      await vaultOperations.selectRuntime(entry.id);
    }
    isOpen = false;
  }

  function handleAddRuntime() {
    if (!allowAdd) return;
    dispatch('addRuntime');
    isOpen = false;
  }

  async function handleDeleteRuntime(event: MouseEvent, runtime: RuntimeDropdownEntry): Promise<void> {
    event.stopPropagation();
    if (runtime.source === 'remote') {
      await runtimeOperations.disconnect(runtime.id);
    } else {
      dispatch('deleteRuntime', { runtimeId: runtime.id });
    }
    isOpen = false;
  }

  function handleRuntimeKeydown(event: KeyboardEvent, runtime: RuntimeDropdownEntry) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void selectRuntime(runtime);
  }

  function runtimeLabel(runtime: RuntimeDropdownEntry | null): string {
    if (!runtime) return allowAdd ? 'Add Runtime' : 'Select Runtime';
    return runtime.label || 'Runtime';
  }
</script>

<Dropdown bind:open={isOpen} minWidth={360} maxWidth={640}>
  <span slot="trigger" class="trigger-content" data-testid="runtime-dropdown-trigger">
    <span class="conn-dot {currentRuntime?.source === 'remote' ? runtimeAdapterDotStatus : connStatus}"></span>
    <Compass class="trigger-icon" size={14} />
    <span class="trigger-text">{runtimeLabel(currentRuntime)}</span>
    <span class="trigger-arrow" class:open={isOpen}>▼</span>
  </span>

  <div slot="menu" class="menu-content">
    {#if runtimeEntries.length === 0}
      <div class="empty-state">No runtimes yet</div>
    {:else}
      {#each runtimeEntries as runtime (runtime.id)}
        <div
          class="menu-item runtime-item"
          class:selected={runtime.id === currentRuntime?.id}
          role="button"
          tabindex="0"
          on:click={() => void selectRuntime(runtime)}
          on:keydown={(event) => handleRuntimeKeydown(event, runtime)}
        >
          <div class="runtime-item-main">
            <span class="conn-dot {runtime.id === currentRuntime?.id ? runtime.status : 'inactive'}"></span>
            <span class="menu-label" title={runtime.title}>{runtime.label}</span>
            <span class="source-chip {runtime.source}">{runtime.source}</span>
            <span class="menu-meta">{runtime.meta}</span>
            {#if runtime.source === 'remote' || (allowDelete && runtime.source === 'browser')}
              <button
                class="delete-btn"
                on:click={(e) => void handleDeleteRuntime(e, runtime)}
                title={runtime.source === 'remote' ? 'Forget remote runtime' : 'Delete runtime'}
              >
                <Trash2 size={12} />
              </button>
            {/if}
          </div>
          {#if runtime.groups.length > 0}
            <div class="runtime-tree" aria-label={`${runtime.label} entities`}>
              {#each runtime.groups as group (group.id)}
                <div class="tree-jurisdiction">
                  <span class="tree-branch"></span>
                  <span class="tree-jurisdiction-label">{group.label}</span>
                  <span class="tree-count">{group.entities.length}</span>
                </div>
                {#each group.entities as entity (entity.id)}
                  <div class="tree-entity" title={entity.id}>
                    <span class="tree-branch entity-branch"></span>
                    <span class="tree-entity-label">{entity.label}</span>
                    <span class="tree-entity-id">{shortRuntimeId(entity.id)}</span>
                  </div>
                {/each}
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}

    {#if allowAdd}
      <div class="menu-divider"></div>
      <button class="menu-item add-item" on:click={handleAddRuntime}>
        <Plus size={13} />
        <span class="menu-label">{addLabel}</span>
      </button>
    {/if}

    <!-- Relay Status -->
    <div class="menu-divider"></div>
    <div class="status-section">
      {#if $runtimeControllerHandle.mode === 'remote'}
        <div class="status-row">
          <span class="conn-dot {runtimeAdapterDotStatus}"></span>
          <span class="status-label">Runtime</span>
          <span class="status-value">remote</span>
        </div>
        <div class="status-row">
          <span class="status-label">Host</span>
          <span class="status-value url" title={$runtimeControllerHandle.endpoint}>{$runtimeControllerHandle.endpoint}</span>
        </div>
      {:else}
      <div class="status-row">
        <span class="conn-dot {connStatus}"></span>
        <span class="status-label">Relay</span>
        <span class="status-value">{connStatus}</span>
      </div>
      <div class="status-row">
        <span class="status-label">URL</span>
        <span class="status-value url" title={relayUrl}>{relayUrl}</span>
      </div>
      {#if $p2pState.queue.totalMessages > 0}
        <div class="status-row">
          <span class="status-label">Queue</span>
          <span class="status-value">{$p2pState.queue.totalMessages} msgs</span>
        </div>
      {/if}
      {/if}
    </div>
  </div>
</Dropdown>

<style>
  .trigger-content {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .trigger-icon {
    flex-shrink: 0;
    color: #9ca3af;
  }

  .trigger-text {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trigger-meta {
    font-size: 10px;
    color: #6fdc8b;
  }

  .trigger-arrow {
    color: #888;
    font-size: 10px;
    transition: transform 0.2s;
    flex-shrink: 0;
  }

  .trigger-arrow.open {
    transform: rotate(180deg);
  }

  .menu-content {
    padding: 4px;
  }

  .menu-item {
    display: flex;
    align-items: flex-start;
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
    position: relative;
  }

  .menu-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .menu-item.selected {
    background: rgba(0, 122, 255, 0.18);
  }

  .runtime-item {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }

  .runtime-item-main {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
  }

  .menu-label {
    flex: 1;
    min-width: 0;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }

  .source-chip {
    flex-shrink: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 9px;
    line-height: 1.3;
    text-transform: uppercase;
    letter-spacing: 0;
    color: #c7d2fe;
    background: rgba(99, 102, 241, 0.12);
  }

  .source-chip.browser {
    color: #bbf7d0;
    background: rgba(34, 197, 94, 0.1);
    border-color: rgba(34, 197, 94, 0.18);
  }

  .runtime-tree {
    display: grid;
    grid-template-columns: 1fr;
    gap: 3px;
    padding-left: 15px;
    color: #a1a1aa;
  }

  .tree-jurisdiction,
  .tree-entity {
    display: grid;
    grid-template-columns: 12px minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 11px;
    line-height: 1.25;
  }

  .tree-entity {
    padding-left: 12px;
    color: #71717a;
    font-size: 10px;
  }

  .tree-branch {
    width: 8px;
    height: 8px;
    border-left: 1px solid rgba(161, 161, 170, 0.35);
    border-bottom: 1px solid rgba(161, 161, 170, 0.35);
  }

  .entity-branch {
    border-color: rgba(113, 113, 122, 0.3);
  }

  .tree-jurisdiction-label,
  .tree-entity-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tree-count,
  .tree-entity-id {
    flex-shrink: 0;
    font-family: 'SF Mono', monospace;
    color: #52525b;
    font-size: 10px;
  }

  .menu-meta {
    flex-shrink: 0;
    font-size: 11px;
    color: #7aa8ff;
    margin-right: 4px;
    line-height: 1.25;
  }

  .delete-btn {
    width: 20px;
    height: 20px;
    padding: 0;
    background: rgba(255, 59, 48, 0.08);
    border: 1px solid rgba(255, 59, 48, 0.2);
    border-radius: 3px;
    color: rgba(255, 59, 48, 0.5);
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .delete-btn:hover {
    background: rgba(255, 59, 48, 0.25);
    border-color: rgba(255, 59, 48, 0.6);
    color: rgba(255, 59, 48, 1);
  }


  .menu-divider {
    height: 1px;
    background: #333;
    margin: 4px 8px;
  }

  .add-item {
    color: #7aa8ff;
    align-items: center;
  }

  .empty-state {
    padding: 12px;
    text-align: center;
    color: #666;
    font-size: 12px;
  }

  .conn-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .conn-dot.connected {
    background: #4ade80;
    box-shadow: 0 0 4px rgba(74, 222, 128, 0.5);
  }

  .conn-dot.reconnecting {
    background: #fbbf24;
    animation: conn-pulse 2s infinite;
  }

  .conn-dot.syncing {
    background: #60a5fa;
    animation: conn-pulse 2s infinite;
  }

  .conn-dot.disconnected {
    background: #ef4444;
    box-shadow: 0 0 4px rgba(239, 68, 68, 0.3);
  }

  .conn-dot.error {
    background: #ef4444;
    box-shadow: 0 0 4px rgba(239, 68, 68, 0.3);
  }

  .conn-dot.inactive {
    background: #3f3f46;
  }

  @keyframes conn-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .status-section {
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .status-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: 8px;
    font-size: 11px;
  }

  .status-label {
    color: #666;
    min-width: 36px;
  }

  .status-value {
    color: #a1a1aa;
    font-family: 'SF Mono', monospace;
    font-size: 10px;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .status-value.url {
    max-width: none;
  }
</style>
