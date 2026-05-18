<script lang="ts">
  /**
   * RuntimeDropdown - Runtime selector (local + remote)
   * Uses unified Dropdown base component.
  */
  import { createEventDispatcher } from 'svelte';
  import Dropdown from '$lib/components/UI/Dropdown.svelte';
  import {
    activeRuntime as activeVaultRuntime,
    allRuntimes as allVaultRuntimes,
    vaultOperations,
    type Runtime as VaultRuntime,
  } from '$lib/stores/vaultStore';
  import {
    activeRuntime as activeStoreRuntime,
    activeRuntimeId,
    runtimes as runtimeStoreRuntimes,
    runtimeOperations,
    type Runtime as StoreRuntime,
  } from '$lib/stores/runtimeStore';
  import { appRuntimeAdapterEndpoint, appRuntimeAdapterMode, appRuntimeAdapterStatus, p2pState } from '$lib/stores/xlnStore';
  import { settings } from '$lib/stores/settingsStore';

  export let allowAdd = false;
  export let allowDelete = false;
  export let addLabel = '+ Add Runtime';

  let isOpen = false;
  const dispatch = createEventDispatcher();

  type RuntimeDotStatus = 'connected' | 'syncing' | 'reconnecting' | 'disconnected' | 'error' | 'inactive';

  type RuntimeEntry = {
    id: string;
    label: string;
    title: string;
    meta: string;
    source: 'browser' | 'remote';
    status: RuntimeDotStatus;
    signers: number;
    vault?: VaultRuntime;
    remote?: StoreRuntime;
  };

  const shortId = (value: string): string => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.length <= 16) return raw;
    return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
  };

  const remoteHostLabel = (runtime: StoreRuntime | null | undefined): string => {
    const raw = String(runtime?.label || runtime?.id || $appRuntimeAdapterEndpoint || 'remote runtime');
    const match = raw.match(/wss?:\/\/[^/\s]+(?:\/[^\s]*)?/);
    if (!match) return raw.replace(/^Remote\s+/i, '');
    try {
      const url = new URL(match[0]);
      return `${url.host}${url.pathname}`;
    } catch {
      return match[0];
    }
  };

  const fromVaultRuntime = (runtime: VaultRuntime): RuntimeEntry => {
    const signerAddress = runtime.signers?.[0]?.address || '';
    return {
      id: runtime.id,
      label: signerAddress ? `${shortId(signerAddress)} (${runtime.label})` : runtime.label || 'Browser runtime',
      title: signerAddress || runtime.id,
      meta: `browser · ${runtime.signers.length} signer${runtime.signers.length === 1 ? '' : 's'}`,
      source: 'browser',
      status: runtime.id === $activeRuntimeId ? connStatus : 'inactive',
      signers: runtime.signers.length,
      vault: runtime,
    };
  };

  const fromRemoteRuntime = (runtime: StoreRuntime): RuntimeEntry => ({
    id: runtime.id,
    label: `Remote ${remoteHostLabel(runtime)}`,
    title: runtime.id,
    meta: `${runtime.permissions === 'write' ? 'remote · full' : 'remote · read'} · ${runtime.status}`,
    source: 'remote',
    status: runtime.status,
    signers: 0,
    remote: runtime,
  });

  $: connStatus = ($p2pState.connected ? 'connected' : $p2pState.reconnect ? 'reconnecting' : 'disconnected') as RuntimeDotStatus;
  $: runtimeAdapterDotStatus = ($appRuntimeAdapterStatus === 'connected'
    ? 'connected'
    : $appRuntimeAdapterStatus === 'connecting'
      ? 'reconnecting'
      : $appRuntimeAdapterStatus === 'error'
        ? 'error'
        : 'disconnected') as RuntimeDotStatus;
  $: relayUrl = $settings.relayUrl;
  $: remoteRuntimes = Array.from($runtimeStoreRuntimes.values()).filter((runtime) => runtime.type === 'remote');
  $: runtimeEntries = [
    ...remoteRuntimes.map(fromRemoteRuntime),
    ...$allVaultRuntimes.map(fromVaultRuntime),
  ];
  $: currentRemoteRuntime = $activeStoreRuntime?.type === 'remote' || $appRuntimeAdapterMode === 'remote'
    ? ($activeStoreRuntime?.type === 'remote' ? $activeStoreRuntime : remoteRuntimes[0] ?? null)
    : null;
  $: currentRuntime = currentRemoteRuntime ? fromRemoteRuntime(currentRemoteRuntime) : ($activeVaultRuntime ? fromVaultRuntime($activeVaultRuntime) : null);

  function selectRuntime(entry: RuntimeEntry) {
    if (entry.source === 'remote') {
      runtimeOperations.selectRuntime(entry.id);
    } else {
      vaultOperations.selectRuntime(entry.id);
    }
    isOpen = false;
  }

  function handleAddRuntime() {
    if (!allowAdd) return;
    dispatch('addRuntime');
    isOpen = false;
  }

  function handleDeleteRuntime(event: MouseEvent, runtimeId: string) {
    event.stopPropagation(); // Don't trigger select
    dispatch('deleteRuntime', { runtimeId });
    isOpen = false;
  }

  function handleRuntimeKeydown(event: KeyboardEvent, runtime: RuntimeEntry) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectRuntime(runtime);
  }

  function runtimeLabel(runtime: RuntimeEntry | null): string {
    if (!runtime) return allowAdd ? 'Add Runtime' : 'Select Runtime';
    return runtime.label || 'Runtime';
  }
</script>

<Dropdown bind:open={isOpen} minWidth={320} maxWidth={560}>
  <span slot="trigger" class="trigger-content">
    <span class="conn-dot {connStatus}"></span>
    <span class="trigger-icon">🧭</span>
    <span class="trigger-text">{runtimeLabel(currentRuntime)}</span>
    <span class="trigger-arrow" class:open={isOpen}>▼</span>
  </span>

  <div slot="menu" class="menu-content">
    {#if runtimeEntries.length === 0}
      <div class="empty-state">No runtimes yet</div>
    {:else}
      {#each runtimeEntries as runtime (runtime.id)}
        <div
          class="menu-item"
          class:selected={runtime.id === currentRuntime?.id}
          role="button"
          tabindex="0"
          on:click={() => selectRuntime(runtime)}
          on:keydown={(event) => handleRuntimeKeydown(event, runtime)}
        >
          <span class="conn-dot {runtime.id === currentRuntime?.id ? runtime.status : 'inactive'}"></span>
          <span class="menu-label" title={runtime.title}>{runtime.label}</span>
          <span class="menu-meta">{runtime.meta}</span>
          {#if allowDelete && runtime.source === 'browser'}
            <button
              class="delete-btn"
              on:click={(e) => handleDeleteRuntime(e, runtime.id)}
              title="Delete runtime"
            >
              ×
            </button>
          {/if}
        </div>
      {/each}
    {/if}

    {#if allowAdd}
      <div class="menu-divider"></div>
      <button class="menu-item add-item" on:click={handleAddRuntime}>
        <span class="menu-label">{addLabel}</span>
      </button>
    {/if}

    <!-- Relay Status -->
    <div class="menu-divider"></div>
    <div class="status-section">
      {#if $appRuntimeAdapterMode === 'remote'}
        <div class="status-row">
          <span class="conn-dot {runtimeAdapterDotStatus}"></span>
          <span class="status-label">Runtime</span>
          <span class="status-value">remote</span>
        </div>
        <div class="status-row">
          <span class="status-label">Host</span>
          <span class="status-value url" title={$appRuntimeAdapterEndpoint}>{$appRuntimeAdapterEndpoint}</span>
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
    font-size: 14px;
    flex-shrink: 0;
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

  .menu-label {
    flex: 1;
    min-width: 0;
    line-height: 1.25;
    overflow-wrap: anywhere;
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
    font-size: 16px;
    line-height: 1;
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
