<!--
  HubDiscoveryPanel.svelte - Discover and connect to payment hubs
  Compact sortable list with expandable details.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { xlnFunctions, xlnEnvironment, getXLN, enqueueEntityInputs, resolveRelayUrls } from '../../stores/xlnStore';
  import { getOpenAccountRebalancePolicyData } from '$lib/utils/onboardingPreferences';
  import {
    normalizeEntityId,
    requireSignerIdForEntity,
    hasCounterpartyAccount,
    getCounterpartyAccount,
    getConnectedCounterpartyIds,
  } from '$lib/utils/entityReplica';
  import { RefreshCw, ChevronDown, ChevronUp, Plus, Check, AlertTriangle } from 'lucide-svelte';

  export let entityId: string = '';
  $: env = $xlnEnvironment;
  $: activeFunctions = $xlnFunctions;

  // State
  let loading = false;
  let error = '';
  let connecting: string | null = null;
  let expandedHub: string | null = null;
  let sortKey: 'score' | 'fee' | 'uptime' | 'name' = 'score';
  let sortAsc = false;
  let sortMode: 'score_desc' | 'score_asc' | 'fee_asc' | 'fee_desc' | 'uptime_desc' | 'uptime_asc' | 'name_asc' | 'name_desc' = 'score_desc';

  const DEFAULT_RELAY = resolveRelayUrls()[0] || '';
  const relayLabel = (() => {
    if (typeof window === 'undefined') return 'Relay';
    return `Relay ${window.location.host}`;
  })();
  const relaySelection = DEFAULT_RELAY;

  // Hub data structure
  interface Hub {
    profile: unknown;
    entityId: string;
    name: string;
    metadata: {
      description?: string;
      website?: string;
      fee?: number;
      capacity?: bigint;
      uptime?: number;
    };
    runtimeId?: string;
    endpoints?: string[];
    capabilities?: string[];
    jurisdiction: string;
    verified: boolean;
    creditScore: number;
    isConnected: boolean;
    lastSeen: number;
    raw: string;
    identicon: string;
  }

  let hubs: Hub[] = [];
  const DISCOVERY_TIMEOUT_MS = 8000;

  function generateIdenticon(entityId: string): string {
    const canonicalId = String(entityId || '').trim().toLowerCase();
    return activeFunctions?.generateEntityAvatar?.(canonicalId) || '';
  }

  $: connectedHubIds = getConnectedCounterpartyIds(env, entityId);

  // Sorted hubs (with live connection status from current account state)
  $: sortedHubs = hubs
    .map((hub) => ({
      ...hub,
      isConnected: connectedHubIds.has(normalizeEntityId(hub.entityId)),
    }))
    .sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'fee':
          cmp = (a.metadata.fee || 0) - (b.metadata.fee || 0);
          break;
        case 'score':
          cmp = a.creditScore - b.creditScore;
          break;
        case 'uptime':
          cmp = (a.metadata.uptime || 0) - (b.metadata.uptime || 0);
          break;
      }
      return sortAsc ? cmp : -cmp;
    });

  // Format functions
  function formatCapacity(cap?: bigint): string {
    if (!cap) return '-';
    const num = Number(cap) / 1e18;
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
    return num.toFixed(2);
  }

  function formatFee(ppm?: number): string {
    if (!ppm && ppm !== 0) return '-';
    return (ppm / 100).toFixed(2) + ' bps';
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  function computeCreditScore(entity: string, feePpm: number, uptime: number): number {
    let hash = 0;
    for (let i = 0; i < entity.length; i += 1) {
      hash = ((hash << 5) - hash + entity.charCodeAt(i)) | 0;
    }
    const base = 720 + (Math.abs(hash) % 181); // 720..900 deterministic
    const feeAdj = clamp(Math.round((120 - feePpm) / 10), -40, 20);
    const uptimeAdj = clamp(Math.round((uptime - 99.5) * 20), -30, 30);
    return clamp(base + feeAdj + uptimeAdj, 650, 980);
  }

  const parseCapacity = (value: unknown): bigint | undefined => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.floor(value));
    if (typeof value === 'string' && value.trim() !== '') {
      try {
        const match = value.match(/^BigInt\(([-\d]+)\)$/);
        const raw = match?.[1] ?? value;
        return BigInt(raw);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const formatRawProfile = (profile: any): string => {
    if (activeFunctions?.safeStringify) {
      return activeFunctions.safeStringify(profile, 2);
    }
    try {
      return JSON.stringify(profile, null, 2);
    } catch {
      return '[unserializable profile]';
    }
  };

  function applySortMode(mode: string) {
    const [key, dir] = mode.split('_');
    if (key === 'score' || key === 'fee' || key === 'uptime' || key === 'name') {
      sortKey = key;
      sortAsc = dir === 'asc';
      sortMode = `${key}_${sortAsc ? 'asc' : 'desc'}` as typeof sortMode;
    }
  }

  function toggleExpand(hubId: string) {
    expandedHub = expandedHub === hubId ? null : hubId;
  }

  function isP2PConnected(currentEnv: any): boolean {
    try {
      return Boolean(currentEnv?.runtimeState?.p2p?.isConnected?.());
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
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  // Discover hubs from gossip network
  async function discoverHubs(refreshGossip: boolean = false) {
    loading = true;
    error = '';

    try {
      if (refreshGossip) {
        const xln = await getXLN();
        if (env && xln.refreshGossip) {
          await Promise.race([
            Promise.resolve(xln.refreshGossip(env)),
            new Promise((_, reject) => setTimeout(() => reject(new Error('gossip refresh timeout')), DISCOVERY_TIMEOUT_MS)),
          ]).catch(() => {
            // best-effort refresh only
          });
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      const currentEnv = env;
      if (!currentEnv) throw new Error('Environment not ready');
      await ensureRuntimeRelay(currentEnv, relaySelection);

      const discovered: Hub[] = [];

      type GossipHubProfile = {
        entityId: string;
        runtimeId?: string;
        endpoints?: string[];
        capabilities?: string[];
        metadata?: {
          name?: string;
          bio?: string;
          website?: string;
          routingFeePPM?: number;
          capacity?: unknown;
          uptime?: string | number;
          region?: string;
          lastUpdated?: number;
          isHub?: boolean;
        };
      };

      const gossipProfiles: GossipHubProfile[] = typeof currentEnv.gossip?.getHubs === 'function'
        ? currentEnv.gossip.getHubs()
        : (currentEnv.gossip?.getProfiles?.() || []).filter(
            (profile: GossipHubProfile) =>
              profile?.metadata?.isHub === true ||
              (Array.isArray(profile?.capabilities) && profile.capabilities.includes('hub')),
          );

      for (const profile of gossipProfiles) {
        if (!profile?.entityId) continue;
        if (normalizeEntityId(profile.entityId) === normalizeEntityId(entityId)) continue;

        const isConnected = hasCounterpartyAccount(currentEnv, entityId, profile.entityId);
        const capacity = parseCapacity(profile.metadata?.capacity);
        const feePpm = profile.metadata?.routingFeePPM || 100;
        const uptime = typeof profile.metadata?.uptime === 'number'
          ? profile.metadata.uptime
          : Number.parseFloat(String(profile.metadata?.uptime || '99.9'));
        const capabilities = profile.capabilities || [];
        const fullEntityId = profile.entityId.startsWith('0x') ? profile.entityId : `0x${profile.entityId}`;

        discovered.push({
          profile,
          entityId: profile.entityId,
          name: profile.name || `Hub ${profile.entityId.slice(0, 8)}`,
          metadata: {
            description: profile.bio || 'Payment hub',
            ...(profile.website ? { website: profile.website } : {}),
            fee: feePpm,
            capacity: capacity ?? 0n,
            uptime,
          },
          endpoints: profile.endpoints || [],
          capabilities,
          jurisdiction: profile.metadata?.region || 'global',
          verified: capabilities.includes('hub') || capabilities.includes('routing'),
          creditScore: computeCreditScore(profile.entityId, feePpm, uptime),
          isConnected,
          lastSeen: profile.lastUpdated || Date.now(),
          raw: formatRawProfile(profile),
          identicon: generateIdenticon(fullEntityId),
          ...(typeof profile.runtimeId === 'string' && profile.runtimeId.trim()
            ? { runtimeId: profile.runtimeId }
            : {}),
        });
      }

      hubs = discovered;
      if (hubs.length === 0) {
        error = 'No hubs discovered yet. Try Refresh; if it persists, check relay connectivity.';
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
      await enqueueEntityInputs(currentEnv as any, [{
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

  async function waitForAccountReady(currentEnv: any, ownerEntityId: string, counterpartyEntityId: string, timeoutMs = 20_000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const accountEntry = getCounterpartyAccount(currentEnv, ownerEntityId, counterpartyEntityId);
      if (accountEntry && !accountEntry.account?.pendingFrame) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  async function ensureRuntimeRelay(currentEnv: any, relayUrl: string, timeoutMs = 12_000): Promise<void> {
    const desired = String(relayUrl || '').trim();
    if (!desired) return;
    const xln = await getXLN();
    const p2p = xln.getP2P?.(currentEnv as any) as { relayUrls?: string[]; isConnected?: () => boolean; updateConfig?: (cfg: any) => void } | null | undefined;
    if (!p2p?.updateConfig) {
      throw new Error('Create or restore a wallet runtime first. Hub gossip uses the active runtime P2P client.');
    }
    const currentRelays = Array.isArray(p2p.relayUrls) ? p2p.relayUrls : [];
    if (currentRelays.length !== 1 || currentRelays[0] !== desired) {
      p2p.updateConfig({ relayUrls: [desired] });
    }
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const relaysNow = Array.isArray(p2p.relayUrls) ? p2p.relayUrls : [];
      const connected = typeof p2p.isConnected === 'function' ? p2p.isConnected() : false;
      if (relaysNow.length === 1 && relaysNow[0] === desired && connected) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
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
        if (!hasP2PClient(env)) {
          loading = false;
          error = 'Create or restore a wallet runtime first. Hub gossip is attached to the active runtime.';
          setTimeout(() => {
            hasDiscoveredOnce = false;
          }, 1500);
          return;
        }
        const ready = await waitForP2PReady(env);
        if (!ready) {
          loading = false;
          error = 'Relay not connected yet. Wait a moment or press Refresh.';
          setTimeout(() => {
            hasDiscoveredOnce = false;
          }, 1500);
          return;
        }
        // One-shot gossip refresh on first load once network is connected.
        await discoverHubs(true);
      })();
    }
    return () => {};
  });

  // Also refresh when env becomes available (only once)
  $: if (env && hubs.length === 0 && !loading && !hasDiscoveredOnce) {
    hasDiscoveredOnce = true;
    (async () => {
      if (!hasP2PClient(env)) {
        loading = false;
        error = 'Create or restore a wallet runtime first. Hub gossip is attached to the active runtime.';
        setTimeout(() => {
          hasDiscoveredOnce = false;
        }, 1500);
        return;
      }
      const ready = await waitForP2PReady(env);
      if (!ready) {
        loading = false;
        error = 'Relay not connected yet. Wait a moment or press Refresh.';
        setTimeout(() => {
          hasDiscoveredOnce = false;
        }, 1500);
        return;
      }
      await discoverHubs(true);
    })();
  }
</script>

<div class="hub-panel">
  <header class="panel-header">
    <h3>Hubs</h3>
    <div class="header-controls">
      <span class="relay-badge" title={relaySelection}>{relayLabel}</span>
      <button class="refresh-btn" on:click={() => discoverHubs(true)} disabled={loading}>
        <span class:spinning={loading}><RefreshCw size={14} /></span>
        Refresh
      </button>
    </div>
  </header>

  {#if !entityId}
    <div class="warning-banner">
      <AlertTriangle size={14} />
      <span>Select an entity to connect to hubs</span>
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
      <span>No hubs found</span>
    </div>
  {:else}
    <div class="hub-sorting">
      <label>
        Sort by
        <select bind:value={sortMode} on:change={(e) => applySortMode((e.currentTarget as HTMLSelectElement).value)}>
          <option value="score_desc">Credit score ↓</option>
          <option value="score_asc">Credit score ↑</option>
          <option value="fee_asc">Fee ↑</option>
          <option value="fee_desc">Fee ↓</option>
          <option value="uptime_desc">Uptime ↓</option>
          <option value="uptime_asc">Uptime ↑</option>
          <option value="name_asc">Name A→Z</option>
          <option value="name_desc">Name Z→A</option>
        </select>
      </label>
    </div>

    <div class="hub-cards">
      {#each sortedHubs as hub (hub.entityId)}
        <article class="hub-card" class:connected={hub.isConnected}>
          <div class="hub-card-top">
            <button class="hub-primary" on:click={() => toggleExpand(hub.entityId)}>
              <img src={hub.identicon} alt="" class="hub-identicon" />
              <div class="hub-title">
                <span class="hub-name">{hub.name}</span>
                <span class="hub-id mono">{hub.entityId}</span>
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

          <div class="hub-strip" aria-hidden="true"></div>

          <div class="hub-metrics-inline">
            <div class="metric-inline">
              <span class="metric-inline-label">Fee</span>
              <span class="metric-inline-value">{formatFee(hub.metadata.fee)}</span>
            </div>
            <div class="metric-inline">
              <span class="metric-inline-label">Capacity</span>
              <span class="metric-inline-value">{formatCapacity(hub.metadata.capacity)}</span>
            </div>
            <div class="metric-inline">
              <span class="metric-inline-label">Uptime</span>
              <span class="metric-inline-value">{hub.metadata.uptime?.toFixed(1) || '-'}%</span>
            </div>
            <div class="metric-inline">
              <span class="metric-inline-label">Region</span>
              <span class="metric-inline-value">{hub.jurisdiction}</span>
            </div>
          </div>

          {#if expandedHub === hub.entityId}
            <div class="row-details">
              <div class="detail-grid">
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
                  <span class="label">Endpoints</span>
                  <span class="value mono">{hub.endpoints?.join(', ') || '-'}</span>
                </div>
                <div class="detail">
                  <span class="label">Capabilities</span>
                  <span class="value">{hub.capabilities?.join(', ') || '-'}</span>
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
    display: flex;
    flex-direction: column;
    gap: 12px;
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

  .header-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .relay-badge {
    display: inline-flex;
    align-items: center;
    background: #1c1917;
    border: 1px solid #292524;
    color: #a8a29e;
    padding: 6px 8px;
    border-radius: 6px;
    font-size: 11px;
  }

  .refresh-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #a8a29e;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .refresh-btn:hover:not(:disabled) {
    border-color: #fbbf24;
    color: #fbbf24;
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
    padding: 8px 12px;
    background: rgba(245, 158, 11, 0.08);
    border: 1px solid rgba(245, 158, 11, 0.15);
    border-radius: 6px;
    color: #d97706;
    font-size: 12px;
  }

  .error-banner {
    padding: 8px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 6px;
    color: #ef4444;
    font-size: 12px;
  }

  .loading-state, .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    color: #57534e;
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

  .hub-sorting {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .hub-sorting label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #a8a29e;
    font-size: 12px;
  }

  .hub-sorting select {
    background: #1c1917;
    border: 1px solid #292524;
    color: #e7e5e4;
    padding: 6px 8px;
    border-radius: 6px;
    font-size: 12px;
  }

  .sort-direction {
    background: #1c1917;
    border: 1px solid #292524;
    color: #a8a29e;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
  }

  .hub-cards {
    display: flex;
    flex-direction: column;
    border: 1px solid #292524;
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(24, 24, 27, 0.96) 0%, rgba(15, 15, 17, 0.96) 100%);
    overflow: hidden;
  }

  .hub-card {
    padding: 14px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .hub-card:last-child {
    border-bottom: none;
  }

  .hub-card.connected {
    background: linear-gradient(90deg, rgba(34, 197, 94, 0.04), transparent 38%);
  }

  .hub-card-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .hub-primary {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }

  .hub-identicon {
    width: 26px;
    height: 26px;
    border-radius: 6px;
    flex-shrink: 0;
  }

  .hub-title {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 2px;
  }

  .hub-name {
    font-weight: 600;
    color: #e7e5e4;
    font-size: 15px;
    letter-spacing: 0.01em;
  }

  .hub-id {
    color: #78716c;
    font-size: 11px;
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
  }

  .hub-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .badge {
    border-radius: 999px;
    border: 1px solid transparent;
    padding: 4px 9px;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #aeb5c4;
    background: rgba(255, 255, 255, 0.02);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .badge.verified {
    border-color: rgba(251, 191, 36, 0.4);
    color: #fbbf24;
  }

  .badge.score {
    border-color: rgba(255, 255, 255, 0.14);
    color: #d8dde8;
  }

  .badge.open {
    border-color: rgba(34, 197, 94, 0.35);
    color: #4ade80;
  }

  .btn-connect {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 11px;
    background: rgba(255, 196, 75, 0.08);
    border: 1px solid rgba(255, 196, 75, 0.42);
    border-radius: 999px;
    color: #ffc24b;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-connect:hover:not(:disabled) {
    background: rgba(255, 196, 75, 0.16);
    border-color: rgba(255, 196, 75, 0.62);
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
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: transparent;
    color: #aeb5c4;
    cursor: pointer;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .hub-strip {
    margin: 10px 0 12px;
    height: 1px;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.03));
  }

  .hub-metrics-inline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px;
  }

  .metric-inline {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }

  .metric-inline-label {
    font-size: 10px;
    color: #838ca1;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .metric-inline-value {
    font-size: 13px;
    color: #e9ecf4;
    font-weight: 500;
  }

  /* Expanded details */
  .row-details {
    padding: 12px 16px;
    background: rgba(24, 24, 27, 0.9);
    border-top: 1px solid #292524;
    margin-top: 10px;
    border-radius: 8px;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px 16px;
    margin-bottom: 12px;
  }

  .detail {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .detail .label {
    font-size: 10px;
    color: #57534e;
  }

  .detail .value {
    font-size: 11px;
    color: #a8a29e;
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
    color: #78716c;
    padding: 4px 0;
  }

  .raw-details pre {
    margin: 8px 0 0;
    padding: 8px;
    background: #171717;
    border: 1px solid #292524;
    border-radius: 4px;
    font-size: 10px;
    color: #d6d3d1;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
  }

  .mono {
    font-family: 'JetBrains Mono', monospace;
  }

  @media (max-width: 740px) {
    .panel-header {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
    }

    .header-controls {
      width: 100%;
      justify-content: space-between;
    }

    .relay-select {
      flex: 1;
      min-width: 0;
    }

    .hub-sorting {
      flex-direction: column;
      align-items: stretch;
    }

    .hub-card-top {
      flex-direction: column;
    }

    .hub-actions {
      justify-content: flex-start;
    }
  }
</style>
