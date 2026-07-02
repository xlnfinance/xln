<!--
  HubDiscoveryPanel.svelte - Discover and connect to payment hubs
  Compact sortable list with expandable details.
-->
<script lang="ts">
  import type { Env, RuntimeInput } from '@xln/runtime/xln-api';
  import { runtimeControllerHandle } from '../../stores/runtimeControllerStore';
  import { getOpenAccountRebalancePolicyData } from '$lib/utils/onboardingPreferences';
  import {
    normalizeEntityId,
    requireSignerIdForEntity,
  } from '$lib/utils/entityReplica';
  import {
    emptyHubDiscoveryProjection,
    buildHubOpenAccountRuntimeInput,
    canSubmitHubOpenAccount,
    ensureHubOpenAccountProfileReady,
    getHubOpenAccountPermissionError,
    hubDiscoveryJurisdictionKey,
    isSameEntityId,
    normalizeHubEntityId,
    type HubDiscoveryHub,
    type HubDiscoveryProjection,
  } from './hub-discovery-profile';
  import { compareStableText } from '$lib/utils/stableSort';
  import { RefreshCw, ChevronDown, ChevronUp, Plus, Check, AlertTriangle } from 'lucide-svelte';

  export let entityId: string = '';
  export let actionRuntimeEnv: Env | null = null;
  export let hubDiscoveryProjection: HubDiscoveryProjection = emptyHubDiscoveryProjection();
  export let canOpenAccounts = true;
  export let submitRuntimeInput: ((input: RuntimeInput) => Promise<unknown> | unknown) | null = null;

  // State
  let loading = false;
  let error = '';
  let connectingHubIds = new Set<string>();
  let expandedHub: string | null = null;

  type Hub = HubDiscoveryHub;

  let hubs: Hub[] = [];

  // Sorted hubs (with live connection status from current account state)
  $: projectedHubs = mergeHubs(hubDiscoveryProjection.localHubs, hubs);
  $: visibleHubs = projectedHubs.filter((hub) => !isSameEntityId(entityId, hub.entityId));
  $: sortedHubs = visibleHubs
    .map((hub) => ({
      ...hub,
      ...(hubDiscoveryProjection.connectionByHubId.get(normalizeHubEntityId(hub.entityId)) ?? {}),
    }))
    .sort((a, b) => compareStableText(a.name, b.name));
  $: openAccountPermissionError = getHubOpenAccountPermissionError({
    adapterMode: $runtimeControllerHandle.mode,
    authLevel: $runtimeControllerHandle.authLevel,
  });
  $: canOpenHubAccount = canOpenAccounts && canSubmitHubOpenAccount({
    adapterMode: $runtimeControllerHandle.mode,
    authLevel: $runtimeControllerHandle.authLevel,
  });

  function hubConnectionState(hub: Hub & { isConnected?: boolean; isOpening?: boolean }): 'open' | 'opening' | 'closed' {
    const hubId = normalizeEntityId(hub.entityId);
    if (hub.isConnected) return 'open';
    if (hub.isOpening || connectingHubIds.has(hubId)) return 'opening';
    return 'closed';
  }

  function formatFee(ppm?: number): string {
    if (!ppm && ppm !== 0) return '-';
    return (ppm / 100).toFixed(2) + ' bps';
  }

  function mergeHubs(primary: Hub[], secondary: Hub[]): Hub[] {
    const byId = new Map<string, Hub>();
    for (const hub of secondary) byId.set(normalizeEntityId(hub.entityId), hub);
    for (const hub of primary) byId.set(normalizeEntityId(hub.entityId), hub);
    return Array.from(byId.values());
  }

  function toggleExpand(hubId: string) {
    expandedHub = expandedHub === hubId ? null : hubId;
  }

  async function requireHubReadyForOpenAccount(currentEnv: Env | null, ownerEntityId: string, hub: Hub): Promise<void> {
    await ensureHubOpenAccountProfileReady({
      env: currentEnv,
      sourceEntityId: ownerEntityId,
      hub,
      timeoutMs: 5_000,
    });
  }

  // Discover hubs from the active RuntimeView/radapter projection.
  async function discoverHubs() {
    loading = true;
    error = '';

    try {
      const localHubs = hubDiscoveryProjection.localHubs;
      hubs = mergeHubs(localHubs, hubs);
      if (hubs.filter((hub) => !isSameEntityId(entityId, hub.entityId)).length === 0) {
        error = 'No projected hubs for this jurisdiction yet. Refresh after the active runtime projection advances.';
      }

    } catch (err) {
      console.error('[HubDiscovery] Failed:', err);
      error = (err as Error)?.message || 'Discovery failed';
    } finally {
      loading = false;
    }
  }

  // Connect to hub (open account + extend credit in same frame)
  async function connectToHub(hub: Hub) {
    if (!entityId) return;

    const hubId = normalizeEntityId(hub.entityId);
    if (connectingHubIds.has(hubId)) return;
    const projectedConnection = hubDiscoveryProjection.connectionByHubId.get(normalizeHubEntityId(hub.entityId));
    if (projectedConnection?.isConnected || projectedConnection?.isOpening) return;

    connectingHubIds = new Set(connectingHubIds).add(hubId);
    error = '';

    try {
      const currentEnv = actionRuntimeEnv;
      if (!canOpenHubAccount) throw new Error(openAccountPermissionError || 'Open Account is not available');
      if (!submitRuntimeInput) throw new Error('Open Account command path is not connected');
      const entityJurisdiction = hubDiscoveryProjection.entityJurisdictionKey;
      const hubJurisdiction = hubDiscoveryJurisdictionKey(hub.metadata?.jurisdiction);
      if (!entityJurisdiction) throw new Error('Entity jurisdiction is still loading');
      if (!hubJurisdiction || hubJurisdiction !== entityJurisdiction) {
        throw new Error('Hub belongs to a different or unknown jurisdiction');
      }

      const signerId = hubDiscoveryProjection.sourceSignerId
        || (currentEnv ? requireSignerIdForEntity(currentEnv, entityId, 'hub-connect') : '');
      if (!signerId) throw new Error('No signer available for hub account setup');

      // Default credit amount: 10,000 tokens (with 18 decimals)
      const creditAmount = 10_000n * 10n ** 18n;
      const rebalancePolicy = getOpenAccountRebalancePolicyData();

      // Preload signed gossip/runtime routing metadata first so the initial
      // openAccount does not sit in the local pending queue waiting for pubkey discovery.
      await requireHubReadyForOpenAccount(currentEnv, entityId, hub);

      await submitRuntimeInput(buildHubOpenAccountRuntimeInput({
        sourceEntityId: entityId,
        signerId,
        hubEntityId: hub.entityId,
        creditAmount,
        tokenId: 1,
        rebalancePolicy,
      }));

    } catch (err) {
      console.error('[HubDiscovery] Connect failed:', err);
      error = (err as Error)?.message || 'Connection failed';
    } finally {
      const next = new Set(connectingHubIds);
      next.delete(hubId);
      connectingHubIds = next;
    }
  }

  // Track if we've already discovered (prevent repeated auto-fetch loops)
  let hasDiscoveredOnce = false;
  let activeDiscoveryKey = '';

  $: localHubProjectionSignature = hubDiscoveryProjection.localHubs
    .map((hub) => `${normalizeHubEntityId(hub.entityId)}:${hub.lastSeen}`)
    .join('|');
  let lastLocalHubProjectionSignature = '';
  $: if (localHubProjectionSignature !== lastLocalHubProjectionSignature) {
    lastLocalHubProjectionSignature = localHubProjectionSignature;
    if (localHubProjectionSignature) hubs = mergeHubs(hubDiscoveryProjection.localHubs, hubs);
  }

  $: currentDiscoveryKey = hubDiscoveryProjection.discoveryKey;
  $: if (currentDiscoveryKey !== activeDiscoveryKey) {
    activeDiscoveryKey = currentDiscoveryKey;
    hubs = [];
    error = '';
    expandedHub = null;
    connectingHubIds = new Set();
    hasDiscoveredOnce = false;
  }

  // Also refresh when env becomes available (only once)
  $: if (currentDiscoveryKey && hubs.length === 0 && !loading && !hasDiscoveredOnce) {
    hasDiscoveredOnce = true;
    (async () => {
      await discoverHubs();
    })();
  }
</script>

<div class="hub-panel">
  <header class="panel-header">
    <div class="panel-copy">
      <span class="panel-kicker">Counterparties</span>
    </div>
    <div class="header-controls">
      <button class="refresh-btn" on:click={() => discoverHubs()} disabled={loading}>
        <span class:spinning={loading}><RefreshCw size={14} /></span>
        Refresh
      </button>
    </div>
  </header>

  {#if !entityId}
    <div class="warning-banner">
      <AlertTriangle size={14} />
      <span>Select an entity to discover counterparties</span>
    </div>
  {/if}

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  {#if loading && hubs.length === 0}
    <div class="loading-state">
      <span class="pulse"><RefreshCw size={20} /></span>
      <span>Scanning network...</span>
    </div>
  {:else if sortedHubs.length === 0}
    <div class="empty-state">
      <span>No counterparties found</span>
    </div>
  {:else}
    <div class="hub-cards">
      {#each sortedHubs as hub (hub.entityId)}
        <article
          class="hub-card"
          class:connected={hub.isConnected}
          data-testid="hub-discovery-card"
          data-hub-entity-id={normalizeEntityId(hub.entityId)}
          data-connection-state={hubConnectionState(hub)}
        >
          <div class="hub-strip" aria-hidden="true"></div>

          <div class="hub-card-top">
            <button class="hub-primary" on:click={() => toggleExpand(hub.entityId)}>
              <img src={hub.avatar} alt="" class="hub-avatar" />
              <div class="hub-title">
                <span class="hub-name">{hub.name}</span>
              </div>
            </button>
            <div class="hub-actions">
              {#if hub.isConnected}
                <span class="connection-state"><Check size={12} /> Open</span>
              {:else if hub.isOpening || connectingHubIds.has(normalizeEntityId(hub.entityId))}
                <span class="connection-state opening"><span class="opening-icon"><RefreshCw size={12} /></span> Opening</span>
              {:else if entityId && canOpenHubAccount}
                <button
                  class="btn-connect"
                  data-testid="hub-connect-button"
                  on:click={() => connectToHub(hub)}
                  disabled={connectingHubIds.has(normalizeEntityId(hub.entityId))}
                >
                  {#if connectingHubIds.has(normalizeEntityId(hub.entityId))}
                    ...
                  {:else}
                    <Plus size={12} /> Connect
                  {/if}
                </button>
              {/if}
              <button class="expand-toggle" on:click={() => toggleExpand(hub.entityId)}>
                <span>{#if expandedHub === hub.entityId}Hide{:else}Details{/if}</span>
                {#if expandedHub === hub.entityId}
                  <ChevronUp size={12} />
                {:else}
                  <ChevronDown size={12} />
                {/if}
              </button>
            </div>
          </div>

          {#if expandedHub === hub.entityId}
            <div class="row-details">
              <div class="detail-grid">
                <div class="detail">
                  <span class="label">Fee</span>
                  <span class="value">{formatFee(hub.metadata.fee)}</span>
                </div>
                <div class="detail">
                  <span class="label">Peers</span>
                  <span class="value">{hub.metadata.peerCount}</span>
                </div>
                <div class="detail">
                  <span class="label">Entity ID</span>
                  <span class="value mono">{hub.entityId.slice(0, 10)}...{hub.entityId.slice(-6)}</span>
                </div>
                <div class="detail">
                  <span class="label">Runtime ID</span>
                  <span class="value mono">{hub.runtimeId || '-'}</span>
                </div>
                <div class="detail">
                  <span class="label">Description</span>
                  <span class="value">{hub.metadata.description || '-'}</span>
                </div>
                <div class="detail">
                  <span class="label">Website</span>
                  <span class="value">{hub.metadata.website || '-'}</span>
                </div>
                <div class="detail">
                  <span class="label">Direct WS</span>
                  <span class="value mono">{hub.wsUrl || '-'}</span>
                </div>
                <div class="detail">
                  <span class="label">Last Seen</span>
                  <span class="value">{new Date(hub.lastSeen).toLocaleString()}</span>
                </div>
              </div>
              <details class="raw-details">
                <summary>Raw Profile</summary>
                <pre>{hub.raw}</pre>
              </details>
            </div>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .hub-panel {
    --hub-accent: var(--theme-accent, #fbbf24);
    --hub-border: color-mix(in srgb, var(--theme-border, #27272a) 82%, transparent);
    --hub-surface: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, transparent);
    --hub-surface-hover: color-mix(in srgb, var(--theme-surface-hover, var(--theme-card-bg, #1c1c20)) 94%, transparent);
    --hub-elevated: color-mix(in srgb, var(--theme-input-bg, #09090b) 96%, transparent);
    --hub-text: var(--theme-text-primary, #e4e4e7);
    --hub-text-secondary: var(--theme-text-secondary, #a1a1aa);
    --hub-text-muted: var(--theme-text-muted, #71717a);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .panel-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .panel-kicker {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.01em;
    text-transform: none;
    color: var(--hub-text);
  }

  .header-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .refresh-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 38px;
    padding: 0 14px !important;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--hub-surface) 96%, transparent),
      color-mix(in srgb, var(--hub-elevated) 100%, transparent)
    ) !important;
    border: 1px solid color-mix(in srgb, var(--hub-border) 92%, transparent) !important;
    border-radius: 999px !important;
    color: var(--hub-text-secondary) !important;
    font-size: 12px !important;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .refresh-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--hub-surface-hover) 100%, transparent) !important;
    border-color: color-mix(in srgb, var(--hub-accent) 18%, transparent) !important;
    color: var(--hub-text) !important;
  }

  .refresh-btn:disabled {
    opacity: 0.5;
  }

  .spinning {
    display: flex;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .warning-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--theme-warning, #f59e0b) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-warning, #f59e0b) 18%, transparent);
    border-radius: 12px;
    color: color-mix(in srgb, var(--theme-warning, #f59e0b) 76%, white 24%);
    font-size: 12px;
  }

  .error-banner {
    padding: 10px 12px;
    background: color-mix(in srgb, var(--theme-debit, #ef4444) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-debit, #ef4444) 22%, transparent);
    border-radius: 12px;
    color: color-mix(in srgb, var(--theme-debit, #ef4444) 78%, white 22%);
    font-size: 12px;
  }

  .loading-state,
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    border-radius: 14px;
    border: 1px solid color-mix(in srgb, var(--hub-border) 86%, transparent);
    background: color-mix(in srgb, var(--hub-surface) 98%, transparent);
    color: var(--hub-text-muted);
    font-size: 12px;
  }

  .pulse {
    display: flex;
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  .hub-cards {
    display: flex;
    flex-direction: column;
    border: 1px solid color-mix(in srgb, var(--hub-border) 64%, transparent);
    border-radius: 14px;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--hub-surface) 94%, transparent),
      color-mix(in srgb, var(--hub-elevated) 100%, transparent)
    );
    overflow: hidden;
    box-shadow: 0 8px 18px color-mix(in srgb, var(--theme-background, #09090b) 5%, transparent);
  }

  .hub-card {
    position: relative;
    border-bottom: 1px solid color-mix(in srgb, var(--hub-border) 56%, transparent);
    background: color-mix(in srgb, var(--hub-surface) 98%, transparent);
  }

  .hub-card:last-child {
    border-bottom: none;
  }

  .hub-card:nth-child(even) {
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--hub-surface-hover) 42%, transparent),
      color-mix(in srgb, var(--hub-surface) 100%, transparent) 32%
    );
  }

  .hub-card.connected {
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--hub-accent) 9%, transparent),
      color-mix(in srgb, var(--hub-surface) 100%, transparent) 24%
    );
  }

  .hub-card-top {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 16px 14px 18px;
  }

  .hub-primary {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    flex: 1;
    background: transparent !important;
    border: none !important;
    padding: 0 !important;
    margin: 0;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }

  .hub-primary:hover .hub-name {
    color: var(--hub-accent);
  }

  .hub-avatar {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--hub-border) 90%, transparent);
    flex-shrink: 0;
  }

  .hub-title {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 4px;
  }

  .hub-name {
    font-weight: 700;
    color: var(--hub-text);
    font-size: 15px;
    letter-spacing: 0.01em;
    transition: color 0.15s ease;
  }

  .connection-state {
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--theme-credit, #22c55e) 18%, transparent);
    padding: 4px 9px;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--theme-credit, #22c55e) 72%, white 28%);
    background: color-mix(in srgb, var(--theme-credit, #22c55e) 10%, transparent);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 700;
  }

  .connection-state.opening {
    border-color: color-mix(in srgb, var(--hub-accent) 22%, transparent);
    color: color-mix(in srgb, var(--hub-accent) 72%, white 28%);
    background: color-mix(in srgb, var(--hub-accent) 10%, transparent);
  }

  .opening-icon {
    display: inline-flex;
    animation: spin 1s linear infinite;
  }

  .hub-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .btn-connect {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 32px;
    padding: 0 12px !important;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--hub-accent) 12%, transparent),
      color-mix(in srgb, var(--hub-accent) 8%, transparent)
    ) !important;
    border: 1px solid color-mix(in srgb, var(--hub-accent) 14%, transparent) !important;
    border-radius: 999px !important;
    color: var(--hub-accent) !important;
    font-size: 11px !important;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-connect:hover:not(:disabled) {
    background: color-mix(in srgb, var(--hub-accent) 16%, transparent) !important;
  }

  .btn-connect:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .expand-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 32px;
    padding: 0 12px !important;
    border-radius: 999px !important;
    border: 1px solid color-mix(in srgb, var(--hub-border) 60%, transparent) !important;
    background: color-mix(in srgb, var(--hub-elevated) 96%, transparent) !important;
    color: var(--hub-text-secondary) !important;
    cursor: pointer;
    font-size: 11px !important;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .expand-toggle:hover {
    border-color: color-mix(in srgb, var(--hub-accent) 18%, transparent) !important;
    color: var(--hub-text) !important;
  }

  .hub-strip {
    display: block;
    position: absolute;
    inset: 0 auto 0 0;
    width: 2px;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--hub-accent) 88%, transparent),
      color-mix(in srgb, var(--theme-accent-secondary, var(--hub-accent)) 42%, transparent)
    );
    opacity: 0.58;
  }

  .row-details {
    padding: 0 18px 16px 18px;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--hub-surface) 0%, transparent),
      color-mix(in srgb, var(--hub-elevated) 100%, transparent)
    );
    border-top: 1px solid color-mix(in srgb, var(--hub-border) 56%, transparent);
  }

  .detail-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 12px;
    padding-top: 14px;
  }

  .detail {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--hub-border) 52%, transparent);
    background: color-mix(in srgb, var(--hub-surface-hover) 72%, transparent);
  }

  .detail .label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--hub-text-muted);
  }

  .detail .value {
    font-size: 12px;
    color: var(--hub-text-secondary);
    word-break: break-all;
  }

  .detail .value.mono {
    font-family: 'JetBrains Mono', monospace;
  }

  .raw-details {
    margin-top: 8px;
  }

  .raw-details summary {
    cursor: pointer;
    font-size: 11px;
    color: var(--hub-text-muted);
    padding: 4px 0;
  }

  .raw-details pre {
    margin: 8px 0 0;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--hub-elevated) 100%, transparent);
    border: 1px solid color-mix(in srgb, var(--hub-border) 84%, transparent);
    border-radius: 12px;
    font-size: 10px;
    color: var(--hub-text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
  }

  .mono {
    font-family: 'JetBrains Mono', monospace;
  }

  @media (max-width: 740px) {
    .header-controls {
      width: auto;
      justify-content: flex-end;
    }

    .hub-card-top {
      grid-template-columns: 1fr;
      gap: 10px;
    }

    .hub-actions {
      justify-content: flex-start;
      gap: 6px;
      width: 100%;
    }

    .detail-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 520px) {
    .hub-panel {
      gap: 10px;
    }

    .panel-header,
    .hub-card-top {
      gap: 10px;
    }

    .hub-card-top,
    .row-details {
      padding-left: 14px;
      padding-right: 14px;
    }

    .panel-header {
      align-items: start;
    }

    .panel-kicker {
      font-size: 9px;
      letter-spacing: 0.08em;
    }

    .refresh-btn {
      min-height: 34px;
      padding: 0 12px !important;
      font-size: 11px !important;
    }

    .hub-avatar {
      width: 30px;
      height: 30px;
      border-radius: 9px;
    }

    .hub-name {
      font-size: 14px;
    }

    .hub-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, max-content));
      justify-content: start;
      align-items: center;
      gap: 6px;
    }

    .detail-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
