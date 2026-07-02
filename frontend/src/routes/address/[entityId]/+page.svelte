<script lang="ts">
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import type { RuntimeAdapterEntitySummary, RuntimeAdapterViewFrame } from '@xln/runtime/xln-api';
  import ActivityHistoryPanel from '$lib/components/Entity/ActivityHistoryPanel.svelte';
  import EntityIdentity from '$lib/components/shared/EntityIdentity.svelte';
  import { runtimeAdapterHeight, runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
  import { runtimeOperations, runtimes } from '$lib/stores/runtimeStore';
  import { refreshRuntimeView } from '$lib/stores/runtimeViewStore';
  import { ensureProjectionRuntimeConnected } from '$lib/utils/runtimeConnection';

  type ExplorerEntity = {
    entityId: string;
    runtimeId?: string;
    name: string;
    isHub: boolean;
    online: boolean;
    lastUpdated: number;
    capabilities: string[];
    metadata: Record<string, unknown>;
  };

  let loading = true;
  let error: string | null = null;
  let entity: ExplorerEntity | null = null;
  let lastLoadedEntityId = '';
  let mounted = false;
  let activeTab: 'overview' | 'history' = 'history';

  $: entityId = decodeURIComponent($page.params.entityId || '').trim();
  $: normalized = entityId.toLowerCase();
  $: validEntityId = /^0x[0-9a-f]{64}$/.test(normalized);

  function normalizeEntityId(value: string | null | undefined): string {
    return String(value || '').trim().toLowerCase();
  }

  function summaryMatches(summary: RuntimeAdapterEntitySummary | null | undefined, requestedEntityId: string): boolean {
    return normalizeEntityId(summary?.entityId) === requestedEntityId;
  }

  function currentRuntimeId(): string {
    return normalizeRuntimeId($runtimeControllerHandle.runtimeId || $runtimeControllerHandle.id);
  }

  function normalizeRuntimeId(value: string | null | undefined): string {
    return String(value || '').trim().toLowerCase();
  }

  function summaryRuntimeId(summary: RuntimeAdapterEntitySummary | null | undefined): string {
    return normalizeRuntimeId(summary?.runtimeId) || currentRuntimeId();
  }

  function buildExplorerEntityFromSummary(
    summary: RuntimeAdapterEntitySummary,
    requestedEntityId: string,
  ): ExplorerEntity | null {
    if (!summaryMatches(summary, requestedEntityId)) return null;
    const runtimeId = summaryRuntimeId(summary);
    const isHub = summary.isHub === true;
    return {
      entityId: requestedEntityId,
      runtimeId,
      name: String(summary.label || requestedEntityId).trim(),
      isHub,
      online: $runtimeControllerHandle.status === 'connected',
      lastUpdated: Math.max(0, Math.floor(Number(summary.height || $runtimeControllerHandle.height || 0))),
      capabilities: ['entity', ...(isHub ? ['hub', 'routing'] : [])],
      metadata: {
        runtimeId,
        height: Math.max(0, Math.floor(Number(summary.height || 0))),
        jurisdiction: summary.jurisdiction ?? null,
        accounts: {
          shown: 0,
          total: 0,
          hasMore: false,
          source: 'summary',
        },
        books: {
          shown: 0,
          total: 0,
          hasMore: false,
          source: 'summary',
        },
        profile: {
          bio: '',
          website: '',
        },
      },
    };
  }

  function buildExplorerEntity(frame: RuntimeAdapterViewFrame, requestedEntityId: string): ExplorerEntity | null {
    const active = frame.activeEntity;
    const summary = active?.summary || frame.entities.find((candidate) => summaryMatches(candidate, requestedEntityId));
    if (!summary || !summaryMatches(summary, requestedEntityId)) return null;
    const core = active?.core;
    const profile = core?.profile as { name?: string; isHub?: boolean; bio?: string; website?: string } | undefined;
    const accountPage = active?.accounts;
    const bookPage = active?.books;
    const isHub = summary.isHub === true || profile?.isHub === true || Boolean(core?.orderbookHubProfile);
    const runtimeId = summaryRuntimeId(summary);
    return {
      entityId: requestedEntityId,
      runtimeId,
      name: String(profile?.name || summary.label || requestedEntityId).trim(),
      isHub,
      online: $runtimeControllerHandle.status === 'connected',
      lastUpdated: Math.max(0, Math.floor(Number(summary.height || frame.height || $runtimeControllerHandle.height || 0))),
      capabilities: [
        'entity',
        ...(isHub ? ['hub', 'routing'] : []),
        Number(accountPage?.totalItems ?? accountPage?.items?.length ?? 0) > 0 ? 'accounts' : '',
        Number(bookPage?.totalItems ?? bookPage?.items?.length ?? 0) > 0 ? 'books' : '',
      ].filter(Boolean),
      metadata: {
        runtimeId,
        height: Math.max(0, Math.floor(Number(frame.height || 0))),
        jurisdiction: summary.jurisdiction ?? null,
        accounts: {
          shown: accountPage?.items?.length ?? 0,
          total: accountPage?.totalItems ?? accountPage?.items?.length ?? 0,
          hasMore: Boolean(accountPage?.nextCursor),
        },
        books: {
          shown: bookPage?.items?.length ?? 0,
          total: bookPage?.totalItems ?? bookPage?.items?.length ?? 0,
          hasMore: Boolean(bookPage?.nextCursor),
        },
        profile: {
          bio: profile?.bio || '',
          website: profile?.website || '',
        },
      },
    };
  }

  async function fetchSummaryExplorerEntity(requestedEntityId: string): Promise<ExplorerEntity | null> {
    const summaries = await runtimeQueryClient.readEntities({ limit: 5000 });
    const summary = summaries.find((candidate) => summaryMatches(candidate, requestedEntityId));
    return summary ? buildExplorerEntityFromSummary(summary, requestedEntityId) : null;
  }

  async function selectEntityRuntimeFromDirectory(requestedEntityId: string): Promise<boolean> {
    const summaries = await runtimeQueryClient.readEntities({ limit: 5000 });
    const summary = summaries.find((candidate) => summaryMatches(candidate, requestedEntityId));
    const targetRuntimeId = summaryRuntimeId(summary);
    if (!targetRuntimeId || targetRuntimeId === currentRuntimeId()) return false;
    const targetRuntime = get(runtimes).get(targetRuntimeId);
    if (!targetRuntime || targetRuntime.type !== 'local') return false;
    await runtimeOperations.selectRuntime(targetRuntimeId);
    return true;
  }

  async function fetchExplorer(): Promise<void> {
    if (!validEntityId) {
      loading = false;
      error = 'Invalid entity id format. Expected 0x + 64 hex chars.';
      return;
    }
    loading = true;
    error = null;
    try {
      await ensureProjectionRuntimeConnected();
      if (await selectEntityRuntimeFromDirectory(normalized)) {
        await ensureProjectionRuntimeConnected();
      }
      const summaryEntity = await fetchSummaryExplorerEntity(normalized);
      const summaryRuntime = normalizeRuntimeId(summaryEntity?.runtimeId);
      if (
        summaryEntity &&
        $runtimeControllerHandle.mode === 'remote' &&
        summaryRuntime &&
        summaryRuntime !== currentRuntimeId()
      ) {
        entity = summaryEntity;
        return;
      }
      let projectionError: unknown = null;
      try {
        const view = await refreshRuntimeView({
          entityId: normalized,
          accountsLimit: 8,
          booksLimit: 8,
        });
        const frame = view.frame;
        if (!frame) throw new Error('Runtime projection frame is not available.');
        entity = buildExplorerEntity(frame, normalized);
      } catch (err) {
        projectionError = err;
        entity = null;
      }
      if (!entity) entity = summaryEntity;
      if (!entity && projectionError) throw projectionError;
      if (!entity) error = 'Entity not found in runtime projection.';
    } catch (err) {
      console.error('[EntityExplorer] projection read failed', err);
      error = err instanceof Error ? err.message : 'Failed to load entity explorer';
      entity = null;
    } finally {
      loading = false;
    }
  }

  $: if (browser && mounted && entityId && entityId !== lastLoadedEntityId) {
    lastLoadedEntityId = entityId;
    fetchExplorer();
  }

  onMount(() => {
    mounted = true;
    if (entityId && entityId !== lastLoadedEntityId) {
      lastLoadedEntityId = entityId;
      void fetchExplorer();
    }
    const unsubscribeHeight = runtimeAdapterHeight.subscribe(() => {
      if (!mounted || !entityId || entityId !== lastLoadedEntityId) return;
      void fetchExplorer();
    });
    return () => {
      mounted = false;
      unsubscribeHeight();
    };
  });
</script>

<svelte:head>
  <title>XLN Entity Explorer</title>
</svelte:head>

<div class="page">
  <header class="top">
    <h1>Entity Explorer</h1>
    <a href="/health">Back to Health</a>
  </header>

  {#if loading}
    <div class="panel">Loading explorer...</div>
  {:else if error}
    <div class="panel error">{error}</div>
  {/if}

  {#if entity}
    <section class="identity-band">
      <EntityIdentity entityId={entity.entityId} name={entity.name} size={44} />
      <div class="meta">
        <span class="chip" class:ok={entity.online} class:bad={!entity.online}>{entity.online ? 'online' : 'offline'}</span>
        {#if entity.isHub}<span class="chip">hub</span>{/if}
        {#if entity.runtimeId}<span class="chip">runtime: {entity.runtimeId.slice(0, 14)}...</span>{/if}
        <span class="chip">h{entity.lastUpdated || 0}</span>
      </div>
    </section>
  {/if}

  {#if entity}
    <section class="panel">
      <div class="tabs" aria-label="Entity page sections">
        <button type="button" class:active={activeTab === 'overview'} onclick={() => activeTab = 'overview'}>Overview</button>
        <button type="button" class:active={activeTab === 'history'} onclick={() => activeTab = 'history'} data-testid="entity-history-tab">History</button>
      </div>

      {#if activeTab === 'overview'}
        <div class="overview">
          <div>
            <h2>Profile</h2>
            <p class="muted">Gossip profile and public runtime metadata for this entity.</p>
          </div>
          <div class="caps">
            {#if entity.capabilities?.length}
              {#each entity.capabilities as cap}
                <span class="chip">{cap}</span>
              {/each}
            {:else}
              <span class="muted">No capabilities declared</span>
            {/if}
          </div>
          <pre>{JSON.stringify(entity.metadata || {}, null, 2)}</pre>
        </div>
      {:else}
        <ActivityHistoryPanel entityId={entity.entityId} runtimeId={entity.runtimeId} />
      {/if}
    </section>
  {/if}
</div>

<style>
  :global(body) {
    margin: 0;
    background: radial-gradient(1200px 700px at 5% -10%, #111926 0%, #06080b 55%, #05070a 100%);
    color: #b7c2d3;
    font-family: 'Space Grotesk', 'IBM Plex Sans', 'Segoe UI', sans-serif;
  }

  .page { max-width: 1220px; margin: 0 auto; padding: 20px; }
  .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .top h1 { margin: 0; color: #e2e8f2; }
  .top a { color: #92a5bc; text-decoration: none; }
  .panel {
    background: linear-gradient(180deg, #0e141f, #0a1119);
    border: 1px solid #1f2b3a;
    border-radius: 8px;
    padding: 14px;
    margin-bottom: 12px;
  }
  .identity-band {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    background: #0c131c;
    border: 1px solid #1d2a38;
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 12px;
  }
  .error { border-color: #6a2435; color: #ff9db0; }
  .meta, .caps { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
  .identity-band .meta { margin-top: 0; justify-content: flex-end; }
  .chip {
    border: 1px solid #324154;
    border-radius: 999px;
    padding: 2px 8px;
    background: #0f1724;
    color: #9fb0c8;
    font-size: 11px;
  }
  .ok { color: #00d26a; }
  .bad { color: #ff5b73; }
  h2 { margin: 0 0 6px 0; }
  .muted { color: #7f8fa7; font-size: 12px; }
  .tabs {
    display: flex;
    gap: 6px;
    border-bottom: 1px solid #1d2937;
    padding-bottom: 10px;
    margin-bottom: 14px;
  }
  .tabs button {
    height: 36px;
    border-radius: 8px;
    border: 1px solid #2b3746;
    background: #101925;
    color: #c7d3e4;
    padding: 0 13px;
    cursor: pointer;
    font-weight: 700;
  }
  .tabs button.active {
    border-color: #6fb6ff;
    background: #112b3f;
    color: #e7f4ff;
  }
  .overview {
    display: grid;
    gap: 12px;
  }
  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 11px;
    color: #a7b5c8;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  @media (max-width: 720px) {
    .page { padding: 12px; }
    .top, .identity-band { align-items: flex-start; flex-direction: column; }
    .identity-band .meta { justify-content: flex-start; }
  }
</style>
