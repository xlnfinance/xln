<!--
  HubDiscoveryPanel.svelte - Discover and connect to payment hubs
  Compact sortable list with expandable details.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Env, Profile as GossipProfile } from '@xln/runtime/xln-api';
  import {
    xlnFunctions,
    xlnEnvironment,
    getXLN,
    enqueueEntityInputs,
    resolveConfiguredApiBase,
    resolveRelayUrls,
  } from '../../stores/xlnStore';
  import { getOpenAccountRebalancePolicyData } from '$lib/utils/onboardingPreferences';
  import { entityAvatar } from '$lib/utils/avatar';
  import { normalizeWsUrl, sameWsEndpoint } from '$lib/utils/wsUrl';
  import {
    normalizeEntityId,
    requireSignerIdForEntity,
    hasCounterpartyAccount,
    getCounterpartyAccount,
    getConnectedCounterpartyIds,
    isCounterpartyBlockedByDispute,
  } from '$lib/utils/entityReplica';
  import { RefreshCw, ChevronDown, ChevronUp, Plus, Check, AlertTriangle } from 'lucide-svelte';

  export let entityId: string = '';
  export let envOverride: Env | null = null;
  $: env = envOverride || $xlnEnvironment;
  $: activeFunctions = $xlnFunctions;

  // State
  let loading = false;
  let error = '';
  let connecting: string | null = null;
  let expandedHub: string | null = null;
  const DEFAULT_RELAY = resolveRelayUrls()[0] || '';
  const relaySelection = DEFAULT_RELAY;

  // Hub data structure
  interface Hub {
    profile: GossipProfile;
    entityId: string;
    name: string;
    metadata: {
      description?: string;
      website?: string;
      fee: number;
      peerCount: number;
    };
    runtimeId: string;
    wsUrl: string | null;
    verified: boolean;
    creditScore: number;
    isConnected: boolean;
    lastSeen: number;
    raw: string;
    avatar: string;
  }

  let hubs: Hub[] = [];
  const DISCOVERY_TIMEOUT_MS = 8000;

  type PublicHubResponse = {
    ok: boolean;
    hubs?: Array<{
      entityId: string;
      runtimeId?: string | null;
      name?: string;
      bio?: string | null;
      website?: string | null;
      wsUrl?: string | null;
      publicAccounts?: string[];
      metadata?: {
        isHub?: boolean;
        routingFeePPM?: number;
      };
      lastUpdated?: number;
      online?: boolean;
    }>;
  };

  const HUB_NAME_ORDER = ['H1', 'H2', 'H3'] as const;

  type RuntimeP2PView = {
    relayUrls?: string[];
    isConnected?: () => boolean;
    updateConfig?: (cfg: { relayUrls: string[] }) => void;
  };

  $: connectedHubIds = getConnectedCounterpartyIds(env, entityId);

  // Sorted hubs (with live connection status from current account state)
  $: sortedHubs = hubs
    .map((hub) => ({
      ...hub,
      isConnected: connectedHubIds.has(normalizeEntityId(hub.entityId)),
    }))
    .sort((a, b) => {
      const fixedOrderA = HUB_NAME_ORDER.indexOf(String(a.name || '').toUpperCase() as typeof HUB_NAME_ORDER[number]);
      const fixedOrderB = HUB_NAME_ORDER.indexOf(String(b.name || '').toUpperCase() as typeof HUB_NAME_ORDER[number]);
      if (fixedOrderA !== fixedOrderB) {
        if (fixedOrderA === -1) return 1;
        if (fixedOrderB === -1) return -1;
        return fixedOrderA - fixedOrderB;
      }
      return a.name.localeCompare(b.name);
    });

  function formatFee(ppm?: number): string {
    if (!ppm && ppm !== 0) return '-';
    return (ppm / 100).toFixed(2) + ' bps';
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  function computeCreditScore(entity: string, feePpm: number, peerCount: number): number {
    let hash = 0;
    for (let i = 0; i < entity.length; i += 1) {
      hash = ((hash << 5) - hash + entity.charCodeAt(i)) | 0;
    }
    const base = 720 + (Math.abs(hash) % 181); // 720..900 deterministic
    const feeAdj = clamp(Math.round((120 - feePpm) / 10), -40, 20);
    const peerAdj = clamp(peerCount * 4, 0, 24);
    return clamp(base + feeAdj + peerAdj, 650, 980);
  }

  const formatRawProfile = (profile: unknown): string => {
    if (activeFunctions?.safeStringify) {
      return activeFunctions.safeStringify(profile, 2);
    }
    try {
      return JSON.stringify(profile, null, 2);
    } catch {
      return '[unserializable profile]';
    }
  };

  function toggleExpand(hubId: string) {
    expandedHub = expandedHub === hubId ? null : hubId;
  }

  async function fetchPublicHubs(timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<Hub[]> {
    if (typeof window === 'undefined') return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const apiBase = resolveConfiguredApiBase(window.location.origin);
      const url = new URL('/api/hubs', apiBase);
      url.searchParams.set('ts', String(Date.now()));
      const response = await fetch(url.toString(), {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return [];
      const payload = await response.json() as PublicHubResponse;
      const serverHubs = Array.isArray(payload.hubs) ? payload.hubs : [];
      return serverHubs
        .filter((hub) => hub?.entityId && hub?.metadata?.isHub === true)
        .map((hub) => {
          const fullEntityId = hub.entityId.startsWith('0x') ? hub.entityId : `0x${hub.entityId}`;
          const peerCount = Array.isArray(hub.publicAccounts) ? hub.publicAccounts.length : 0;
          const feePpm = Number(hub.metadata?.routingFeePPM ?? 0);
          return {
            profile: {
              entityId: hub.entityId,
              name: hub.name || hub.entityId,
              bio: hub.bio || '',
              website: hub.website || undefined,
              wsUrl: hub.wsUrl || null,
              publicAccounts: hub.publicAccounts || [],
              metadata: {
                isHub: true,
                routingFeePPM: feePpm,
              },
              runtimeId: hub.runtimeId || '',
              lastUpdated: Number(hub.lastUpdated || 0),
            } as GossipProfile,
            entityId: hub.entityId,
            name: hub.name || hub.entityId,
            metadata: {
              description: hub.bio || 'Payment hub',
              ...(hub.website ? { website: hub.website } : {}),
              fee: feePpm,
              peerCount,
            },
            runtimeId: hub.runtimeId || '',
            wsUrl: hub.wsUrl || null,
            verified: true,
            creditScore: computeCreditScore(hub.entityId, feePpm, peerCount),
            isConnected: false,
            lastSeen: Number(hub.lastUpdated || 0),
            raw: formatRawProfile(hub),
            avatar: entityAvatar(activeFunctions, fullEntityId),
          } satisfies Hub;
        });
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  function isP2PConnected(currentEnv: unknown): boolean {
    try {
      const p2p = (currentEnv as { runtimeState?: { p2p?: RuntimeP2PView } } | null)?.runtimeState?.p2p;
      return typeof p2p?.isConnected === 'function' ? Boolean(p2p.isConnected()) : false;
    } catch {
      return false;
    }
  }

  function hasP2PClient(currentEnv: unknown): boolean {
    try {
      return Boolean((currentEnv as { runtimeState?: { p2p?: unknown } } | null)?.runtimeState?.p2p);
    } catch {
      return false;
    }
  }

  async function waitForP2PReady(currentEnv: unknown, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<boolean> {
    if (!hasP2PClient(currentEnv)) return false;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (isP2PConnected(currentEnv)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  // Discover hubs from gossip network
  async function discoverHubs(refreshGossip: boolean = false) {
    loading = true;
    error = '';

    try {
      const currentEnv = env;
      const fetchedHubs = await fetchPublicHubs();
      if (refreshGossip) {
        try {
          const xln = await getXLN();
          if (currentEnv && xln.refreshGossip) {
            await ensureRuntimeRelay(currentEnv, relaySelection);
            await Promise.race([
              Promise.resolve(xln.refreshGossip(currentEnv)),
              new Promise((_, reject) => setTimeout(() => reject(new Error('gossip refresh timeout')), DISCOVERY_TIMEOUT_MS)),
            ]);
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        } catch {
          // Discovery stays server-authoritative; local gossip refresh is best-effort only.
        }
      }

      hubs = fetchedHubs
        .filter((hub) => !currentEnv || !entityId || !isCounterpartyBlockedByDispute(currentEnv, entityId, hub.entityId))
        .map((hub) => ({
          ...hub,
          isConnected: currentEnv ? hasCounterpartyAccount(currentEnv, entityId, hub.entityId) : false,
        }));
      if (hubs.length === 0) {
        error = 'No public hubs discovered yet. Try Refresh; if it persists, check relay connectivity.';
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
    if (!entityId || connecting) return;

    connecting = hub.entityId;
    error = '';

    try {
      const xln = await getXLN();
      if (!xln) throw new Error('XLN not initialized');

      const currentEnv = env;
      if (!currentEnv) throw new Error('Environment not ready');
      await ensureRuntimeRelay(currentEnv, relaySelection);

      // Find signer for our entity
      const signerId = requireSignerIdForEntity(currentEnv, entityId, 'hub-connect');

      // Default credit amount: 10,000 tokens (with 18 decimals)
      const creditAmount = 10_000n * 10n ** 18n;
      const rebalancePolicy = getOpenAccountRebalancePolicyData();

      // Open account WITH credit extension (both in same frame)
      // Frame #1 will have: [add_delta, set_credit_limit] - order matters!
      console.log('[HubDiscovery] Opening account + extending credit to', hub.entityId);
      await enqueueEntityInputs(currentEnv, [{
        entityId,
        signerId,
        entityTxs: [
          {
            type: 'openAccount' as const,
              data: {
                targetEntityId: hub.entityId,
                creditAmount,    // Both txs go in same frame
                tokenId: 1,      // USDC
                ...(rebalancePolicy ? { rebalancePolicy } : {}),
              }
            }
          ]
        }]);

      const opened = await waitForAccountReady(currentEnv, entityId, hub.entityId, 20_000);
      if (!opened) {
        throw new Error('Account opening is still pending consensus. Wait for ACK and retry.');
      }

      // Update hub status
      hubs = hubs.map(h =>
        normalizeEntityId(h.entityId) === normalizeEntityId(hub.entityId)
          ? { ...h, isConnected: true }
          : h
      );

    } catch (err) {
      console.error('[HubDiscovery] Connect failed:', err);
      error = (err as Error)?.message || 'Connection failed';
    } finally {
      connecting = null;
    }
  }

  async function waitForAccountReady(currentEnv: Env, ownerEntityId: string, counterpartyEntityId: string, timeoutMs = 20_000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const accountEntry = getCounterpartyAccount(currentEnv, ownerEntityId, counterpartyEntityId);
      if (accountEntry && !accountEntry.account?.pendingFrame) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async function ensureRuntimeRelay(currentEnv: Env, relayUrl: string, timeoutMs = 12_000): Promise<void> {
    const desired = normalizeWsUrl(String(relayUrl || '').trim() || resolveRelayUrls()[0] || '');
    if (!desired) return;
    const xln = await getXLN();
    const p2p = xln.getP2P?.(currentEnv) as RuntimeP2PView | null | undefined;
    if (!p2p?.updateConfig) {
      throw new Error('Create or restore a wallet runtime first. Hub gossip uses the active runtime P2P client.');
    }
    const currentRelays = Array.isArray(p2p.relayUrls) ? p2p.relayUrls : [];
    if (currentRelays.length !== 1 || !sameWsEndpoint(currentRelays[0] || '', desired)) {
      p2p.updateConfig({ relayUrls: [desired] });
    }
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const relaysNow = Array.isArray(p2p.relayUrls) ? p2p.relayUrls : [];
      const connected = typeof p2p.isConnected === 'function' ? p2p.isConnected() : false;
      if (relaysNow.length === 1 && sameWsEndpoint(relaysNow[0] || '', desired) && connected) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const relaysNow = Array.isArray(p2p.relayUrls) ? p2p.relayUrls.join(',') : 'none';
    throw new Error(`Relay switch timeout (desired=${desired}, actual=${relaysNow})`);
  }

  // Track if we've already discovered (prevent repeated auto-fetch loops)
  let hasDiscoveredOnce = false;

  // Auto-load once on mount. No background retries; user can press Refresh.
  onMount(() => {
    if (env) {
      hasDiscoveredOnce = true;
      (async () => {
        await discoverHubs(true);
      })();
    }
    return () => {};
  });

  // Also refresh when env becomes available (only once)
  $: if (env && hubs.length === 0 && !loading && !hasDiscoveredOnce) {
    hasDiscoveredOnce = true;
    (async () => {
      await discoverHubs(true);
    })();
  }
</script>

<div class="hub-panel">
  <header class="panel-header">
    <div class="panel-copy">
      <span class="panel-kicker">Counterparty discovery</span>
      <span class="panel-note">Verified and scored hubs, ranked for fast account opening.</span>
    </div>
    <div class="header-controls">
      <button class="refresh-btn" on:click={() => discoverHubs(true)} disabled={loading}>
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
  {:else if hubs.length === 0}
    <div class="empty-state">
      <span>No counterparties found</span>
    </div>
  {:else}
    <div class="hub-cards">
      {#each sortedHubs as hub (hub.entityId)}
        <article class="hub-card" class:connected={hub.isConnected}>
          <div class="hub-strip" aria-hidden="true"></div>

          <div class="hub-card-top">
            <button class="hub-primary" on:click={() => toggleExpand(hub.entityId)}>
              <img src={hub.avatar} alt="" class="hub-avatar" />
              <div class="hub-title">
                <span class="hub-name">{hub.name}</span>
                <div class="hub-subline">
                  <span class="hub-id mono">{hub.entityId.slice(0, 10)}...{hub.entityId.slice(-6)}</span>
                  <span class="hub-dot"></span>
                  <span class="hub-inline-meta">{formatFee(hub.metadata.fee)} fee</span>
                  <span class="hub-dot"></span>
                  <span class="hub-inline-meta">{hub.metadata.peerCount} peers</span>
                </div>
              </div>
            </button>
            <div class="hub-actions">
              {#if hub.verified}
                <span class="badge verified">Verified</span>
              {/if}
              <span class="badge score">Score {hub.creditScore}</span>
              {#if hub.isConnected}
                <span class="badge open"><Check size={12} /> Open</span>
              {:else if entityId}
                <button
                  class="btn-connect"
                  on:click={() => connectToHub(hub)}
                  disabled={connecting === hub.entityId}
                >
                  {#if connecting === hub.entityId}
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
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--hub-accent);
  }

  .panel-note {
    font-size: 12px;
    color: var(--hub-text-muted);
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

  .hub-subline {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
    color: var(--hub-text-muted);
    font-size: 11px;
  }

  .hub-id {
    color: var(--hub-text-secondary);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hub-dot {
    width: 3px;
    height: 3px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--hub-text-muted) 72%, transparent);
    flex: 0 0 auto;
  }

  .hub-inline-meta {
    color: var(--hub-text-muted);
  }

  .hub-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .badge {
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--hub-border) 56%, transparent);
    padding: 4px 9px;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--hub-text-secondary);
    background: color-mix(in srgb, var(--hub-elevated) 100%, transparent);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 700;
  }

  .badge.verified {
    color: var(--hub-accent);
    background: color-mix(in srgb, var(--hub-accent) 10%, transparent);
    border-color: color-mix(in srgb, var(--hub-accent) 18%, transparent);
  }

  .badge.score {
    color: var(--hub-text);
  }

  .badge.open {
    color: color-mix(in srgb, var(--theme-credit, #22c55e) 72%, white 28%);
    background: color-mix(in srgb, var(--theme-credit, #22c55e) 10%, transparent);
    border-color: color-mix(in srgb, var(--theme-credit, #22c55e) 18%, transparent);
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
    .panel-header,
    .hub-card-top {
      gap: 12px;
    }

    .hub-subline {
      gap: 6px;
    }

    .hub-card-top,
    .row-details {
      padding-left: 16px;
      padding-right: 16px;
    }

    .detail-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
