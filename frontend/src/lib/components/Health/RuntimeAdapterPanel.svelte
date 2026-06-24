<script lang="ts">
  import { onMount } from 'svelte';
  import {
    connectRuntimeAdapter,
    disconnectRuntimeAdapter,
    runtimeAdapterAuthLevel,
    runtimeAdapterHeight,
    runtimeAdapterRead,
    runtimeAdapterStatus,
  } from '$lib/stores/runtimeAdapterStore';
  import type {
    RuntimeAdapterEntitySummary,
    RuntimeAdapterViewFrame,
  } from '@xln/runtime/xln-api';
  import type { StorageHead } from '@xln/runtime/storage/types';
  import { makeQaSeveritySignal, type QaSeveritySignal } from '@xln/runtime/qa/severity';

  type Props = {
    fullPage?: boolean;
    autoConnect?: boolean;
  };

  let { fullPage = false, autoConnect = false }: Props = $props();

  let wsUrl = $state('');
  let authKey = $state('');
  let selectedEntityId = $state('');
  let head = $state<StorageHead | null>(null);
  let viewFrame = $state<RuntimeAdapterViewFrame | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  const entities = $derived(viewFrame?.entities ?? []);
  const activeEntity = $derived(viewFrame?.activeEntity ?? null);
  const activeAccounts = $derived(activeEntity?.accounts?.items ?? []);
  const activeBooks = $derived(activeEntity?.books?.items ?? []);
  const adapterSeverity = $derived.by<QaSeveritySignal>(() => {
    if (error) {
      return makeQaSeveritySignal({
        severity: 'FAIL',
        reason: error,
        since: Date.now(),
        owner: 'remote-adapter',
        evidence: [{ label: 'status', value: $runtimeAdapterStatus }],
      });
    }
    if (loading) {
      return makeQaSeveritySignal({
        severity: 'UNKNOWN',
        reason: 'Runtime adapter request is in flight',
        since: Date.now(),
        owner: 'remote-adapter',
        evidence: [{ label: 'status', value: $runtimeAdapterStatus }],
      });
    }
    if ($runtimeAdapterStatus === 'connected') {
      return makeQaSeveritySignal({
        severity: viewFrame ? 'OK' : 'WARN',
        reason: viewFrame ? 'Remote runtime compact frame is loaded' : 'Remote adapter is connected; compact frame not loaded yet',
        since: Date.now(),
        owner: 'remote-adapter',
        evidence: [
          { label: 'height', value: $runtimeAdapterHeight },
          { label: 'auth', value: $runtimeAdapterAuthLevel ?? 'none' },
          { label: 'entities', value: entities.length },
        ],
      });
    }
    if ($runtimeAdapterStatus === 'error') {
      return makeQaSeveritySignal({
        severity: 'FAIL',
        reason: 'Remote adapter connection failed',
        since: Date.now(),
        owner: 'remote-adapter',
        evidence: [{ label: 'status', value: $runtimeAdapterStatus }],
      });
    }
    return makeQaSeveritySignal({
      severity: 'UNKNOWN',
      reason: 'Remote adapter is not connected',
      since: 0,
      owner: 'remote-adapter',
      evidence: [{ label: 'status', value: $runtimeAdapterStatus }],
    });
  });

  function defaultWsUrl(): string {
    if (typeof window === 'undefined') return '';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/rpc`;
  }

  function errorMessage(value: unknown): string {
    return value instanceof Error ? value.message : String(value || 'Runtime adapter error');
  }

  function short(value?: string | null, len = 10): string {
    const text = String(value || '');
    if (!text) return '-';
    return text.length <= len ? text : `${text.slice(0, len)}...${text.slice(-4)}`;
  }

  function formatJson(value: unknown): string {
    return JSON.stringify(value, (_key, raw) => {
      if (typeof raw === 'bigint') return `${raw.toString()}n`;
      if (raw instanceof Map) return Object.fromEntries(raw.entries());
      if (raw instanceof Set) return Array.from(raw.values());
      return raw;
    }, 2);
  }

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const nextHead = await runtimeAdapterRead<StorageHead>('head');
      const nextFrame = await runtimeAdapterRead<RuntimeAdapterViewFrame>('view-frame', {
        limit: 12,
        accountsLimit: 10,
        booksLimit: 10,
        ...(selectedEntityId ? { entityId: selectedEntityId } : {}),
      });
      head = nextHead;
      viewFrame = nextFrame;
      selectedEntityId = nextFrame.activeEntityId || nextFrame.entities[0]?.entityId || selectedEntityId;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  async function connect(): Promise<void> {
    loading = true;
    error = null;
    try {
      await connectRuntimeAdapter({
        mode: 'remote',
        wsUrl,
        ...(authKey.trim() ? { authKey: authKey.trim() } : {}),
      });
      await refresh();
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  async function selectEntity(entityId: string): Promise<void> {
    selectedEntityId = entityId;
    await refresh();
  }

  function hydrateFromLocation(): void {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    wsUrl = params.get('ws') || defaultWsUrl();
    authKey = params.get('token') || params.get('key') || params.get('auth') || '';
    if (params.has('token') || params.has('key') || params.has('auth')) {
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      url.searchParams.delete('key');
      url.searchParams.delete('auth');
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }

  onMount(() => {
    hydrateFromLocation();
    if (autoConnect) void connect();
  });
</script>

<section id="runtime-adapter" class:full-page={fullPage} class="runtime-adapter-panel">
  {#if fullPage}
    <header class="topbar">
      <div>
        <p class="eyebrow">xln admin</p>
        <h1>Runtime Adapter Inspector</h1>
      </div>
      <a href="/health">Health admin</a>
    </header>
  {:else}
    <div class="panel-head">
      <div>
        <h2>Runtime Adapter</h2>
        <p class="sub">Frontend-only inspector for remote runtime snapshots</p>
      </div>
      <a class="panel-link" href="/radapter">Open inspector</a>
    </div>
  {/if}

  <div class="status-line">
    <span class:ok={adapterSeverity.severity === 'OK'} class:bad={adapterSeverity.severity === 'FAIL'}>{adapterSeverity.severity}</span>
    <span title={adapterSeverity.reason}>{adapterSeverity.reason}</span>
    <span class:ok={$runtimeAdapterStatus === 'connected'} class:bad={$runtimeAdapterStatus === 'error'}>{$runtimeAdapterStatus}</span>
    <span>height {$runtimeAdapterHeight}</span>
    <span>{$runtimeAdapterAuthLevel ?? 'no auth'}</span>
  </div>

  <div class="connect-band">
    <label>
      WS URL
      <input bind:value={wsUrl} placeholder="ws://127.0.0.1:8080/rpc" />
    </label>
    <label>
      Token
      <input bind:value={authKey} type="password" placeholder="read/admin token" />
    </label>
    <button onclick={connect} disabled={loading}>{loading ? 'Loading' : 'Connect'}</button>
    <button class="secondary" onclick={refresh} disabled={loading || $runtimeAdapterStatus !== 'connected'}>Refresh</button>
    <button class="secondary" onclick={disconnectRuntimeAdapter}>Disconnect</button>
  </div>

  {#if error}
    <div class="error-band">{error}</div>
  {/if}

  <div class="summary-grid">
    <article>
      <span>Latest</span>
      <strong>{head?.latestHeight ?? viewFrame?.height ?? 0}</strong>
    </article>
    <article>
      <span>Materialized</span>
      <strong>{head?.latestMaterializedHeight ?? 0}</strong>
    </article>
    <article>
      <span>Snapshot</span>
      <strong>{head?.latestSnapshotHeight ?? 0}</strong>
    </article>
    <article>
      <span>Entities</span>
      <strong>{entities.length}</strong>
    </article>
  </div>

  <div class="workspace">
    <aside class="entity-list">
      <h3>Entities</h3>
      {#if entities.length === 0}
        <div class="empty">No connected runtime frame.</div>
      {:else}
        {#each entities as entity}
          <button
            class:active={entity.entityId === selectedEntityId}
            onclick={() => selectEntity(entity.entityId)}
          >
            <span>{entity.label || short(entity.entityId, 12)}</span>
            <small>{short(entity.entityId, 14)}{entity.isHub ? ' · hub' : ''}</small>
          </button>
        {/each}
      {/if}
    </aside>

    <section class="details">
      {#if activeEntity}
        <div class="detail-head">
          <div>
            <p class="eyebrow">Active entity</p>
            <h3>{activeEntity.core.profile?.name || short(activeEntity.core.entityId, 14)}</h3>
          </div>
          <span class="height-pill">E{activeEntity.core.height}</span>
        </div>

        <div class="bounded-grid">
          <article>
            <span>Accounts shown</span>
            <strong>{activeAccounts.length}</strong>
            <small>limit 10</small>
          </article>
          <article>
            <span>Books shown</span>
            <strong>{activeBooks.length}</strong>
            <small>limit 10</small>
          </article>
          <article>
            <span>Frame</span>
            <strong>{viewFrame?.height ?? 0}</strong>
            <small>compact view-frame</small>
          </article>
        </div>

        <div class="table">
          <div class="table-head">
            <span>Counterparty</span>
            <span>Status</span>
            <span>Height</span>
          </div>
          {#each activeAccounts as account}
            <div class="table-row">
              <span>{short(account.leftEntity?.toLowerCase() === selectedEntityId.toLowerCase() ? account.rightEntity : account.leftEntity, 14)}</span>
              <span>{account.status}</span>
              <span>{account.currentHeight}</span>
            </div>
          {/each}
          {#if activeAccounts.length === 0}
            <div class="empty">No accounts in compact page.</div>
          {/if}
        </div>

        <details>
          <summary>Core JSON</summary>
          <pre>{formatJson(activeEntity.core)}</pre>
        </details>
      {:else}
        <div class="empty">Connect a runtime adapter to inspect its compact frame.</div>
      {/if}
    </section>
  </div>
</section>

<style>
  .runtime-adapter-panel {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.035);
    padding: 16px;
  }

  .runtime-adapter-panel.full-page {
    min-height: 100vh;
    box-sizing: border-box;
    border: 0;
    border-radius: 0;
    background: #0d1117;
    color: #e6edf3;
    padding: 28px;
  }

  .topbar,
  .panel-head,
  .status-line,
  .detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .topbar {
    margin-bottom: 18px;
  }

  .topbar a,
  .panel-link {
    color: #dbeafe;
    text-decoration: none;
    font-size: 12px;
    font-weight: 700;
  }

  .eyebrow {
    margin: 0 0 5px;
    color: #7da7f7;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3 {
    margin: 0;
    letter-spacing: 0;
  }

  h1 {
    font-size: 28px;
  }

  h2 {
    font-size: 18px;
  }

  h3 {
    font-size: 16px;
  }

  .sub {
    margin: 4px 0 0;
    color: #8b949e;
    font-size: 12px;
  }

  .status-line {
    justify-content: flex-end;
    flex-wrap: wrap;
    margin: 12px 0;
  }

  .status-line span,
  .height-pill {
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    padding: 6px 10px;
    background: rgba(0, 0, 0, 0.22);
    color: #8b949e;
    font-size: 12px;
  }

  .ok {
    color: #7ee787 !important;
  }

  .bad {
    color: #ff7b72 !important;
  }

  .connect-band {
    display: grid;
    grid-template-columns: minmax(240px, 1fr) minmax(180px, 260px) auto auto auto;
    gap: 10px;
    align-items: end;
    margin-bottom: 14px;
  }

  label {
    display: grid;
    gap: 5px;
    color: #8b949e;
    font-size: 12px;
    font-weight: 700;
  }

  input,
  button {
    min-height: 36px;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.28);
    color: #e6edf3;
    font: inherit;
  }

  input {
    min-width: 0;
    padding: 0 10px;
  }

  button {
    padding: 0 12px;
    background: #7da7f7;
    border-color: #7da7f7;
    color: #07111f;
    cursor: pointer;
    font-size: 12px;
    font-weight: 800;
  }

  button.secondary {
    color: #dbeafe;
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.12);
  }

  button:disabled {
    opacity: 0.55;
    cursor: wait;
  }

  .error-band {
    margin-bottom: 12px;
    border: 1px solid rgba(248, 81, 73, 0.36);
    border-radius: 6px;
    padding: 10px;
    color: #ffb3ad;
    background: rgba(248, 81, 73, 0.08);
    font-size: 12px;
  }

  .summary-grid,
  .bounded-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 14px;
  }

  .bounded-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .summary-grid article,
  .bounded-grid article {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    padding: 10px;
    background: rgba(0, 0, 0, 0.18);
  }

  .summary-grid span,
  .bounded-grid span,
  .bounded-grid small {
    display: block;
    color: #8b949e;
    font-size: 11px;
    font-weight: 700;
  }

  .summary-grid strong,
  .bounded-grid strong {
    display: block;
    margin-top: 5px;
    color: #f8fafc;
    font-size: 20px;
  }

  .workspace {
    display: grid;
    grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
    gap: 14px;
  }

  .entity-list {
    display: grid;
    gap: 7px;
    align-content: start;
  }

  .entity-list button {
    min-height: 48px;
    display: grid;
    gap: 3px;
    justify-items: start;
    text-align: left;
    color: #dbeafe;
    background: rgba(0, 0, 0, 0.24);
    border-color: rgba(255, 255, 255, 0.1);
  }

  .entity-list button.active {
    background: rgba(125, 167, 247, 0.14);
    border-color: rgba(125, 167, 247, 0.7);
  }

  .entity-list small {
    color: #8b949e;
  }

  .details {
    min-width: 0;
  }

  .detail-head {
    margin-bottom: 12px;
  }

  .table {
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
  }

  .table-head,
  .table-row {
    display: grid;
    grid-template-columns: 1.4fr 0.8fr 0.6fr;
    gap: 10px;
    padding: 9px 11px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    color: #c9d1d9;
    font-size: 12px;
  }

  .table-head {
    color: #8b949e;
    font-weight: 800;
    text-transform: uppercase;
    background: rgba(0, 0, 0, 0.18);
  }

  .table-row:last-child {
    border-bottom: 0;
  }

  details {
    margin-top: 12px;
  }

  summary {
    color: #dbeafe;
    cursor: pointer;
    font-size: 12px;
    font-weight: 800;
  }

  pre {
    max-height: 320px;
    overflow: auto;
    margin: 10px 0 0;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    padding: 10px;
    background: rgba(0, 0, 0, 0.34);
    color: #c9d1d9;
    font-size: 12px;
    line-height: 1.45;
  }

  .empty {
    padding: 12px;
    color: #8b949e;
    font-size: 12px;
  }

  @media (max-width: 940px) {
    .connect-band,
    .workspace,
    .summary-grid,
    .bounded-grid {
      grid-template-columns: 1fr;
    }

    .topbar,
    .panel-head,
    .detail-head {
      align-items: flex-start;
      flex-direction: column;
    }

    .status-line {
      justify-content: flex-start;
    }
  }
</style>
