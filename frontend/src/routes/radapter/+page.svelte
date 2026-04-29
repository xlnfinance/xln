<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    connectRuntimeAdapter,
    disconnectRuntimeAdapter,
    runtimeAdapterAuthLevel,
    runtimeAdapterHeight,
    runtimeAdapterRead,
    runtimeAdapterStatus,
  } from '$lib/stores/runtimeAdapterStore';
  import type { RuntimeAdapterEntitySummary } from '@xln/runtime/radapter/types';
  import type { StorageAccountDoc, StorageEntityCoreDoc, StorageHead } from '@xln/runtime/storage/types';

  type AccountPage = {
    items: StorageAccountDoc[];
    nextCursor: string | null;
  };

  let mode: 'embedded' | 'remote' = 'embedded';
  let wsUrl = '';
  let authKey = '';
  let selectedEntityId = '';
  let head: StorageHead | null = null;
  let entities: RuntimeAdapterEntitySummary[] = [];
  let entity: StorageEntityCoreDoc | null = null;
  let accounts: AccountPage | null = null;
  let books: unknown[] = [];
  let loading = false;
  let error: string | null = null;
  let unsubscribeHeight: (() => void) | null = null;

  const errorMessage = (value: unknown): string => value instanceof Error ? value.message : String(value || 'Adapter error');

  const formatJson = (value: unknown): string => JSON.stringify(value, (_key, raw) => {
    if (typeof raw === 'bigint') return `${raw.toString()}n`;
    if (raw instanceof Map) return Object.fromEntries(raw.entries());
    if (raw instanceof Set) return Array.from(raw.values());
    return raw;
  }, 2);

  const accountName = (doc: StorageAccountDoc): string => {
    if (!selectedEntityId) return `${doc.leftEntity.slice(-6)}:${doc.rightEntity.slice(-6)}`;
    const selected = selectedEntityId.toLowerCase();
    return (doc.leftEntity.toLowerCase() === selected ? doc.rightEntity : doc.leftEntity).slice(-12);
  };

  async function refreshAll(): Promise<void> {
    loading = true;
    error = null;
    try {
      head = await runtimeAdapterRead<StorageHead>('head');
      entities = await runtimeAdapterRead<RuntimeAdapterEntitySummary[]>('entities');
      if (!selectedEntityId && entities.length > 0) selectedEntityId = entities[0]?.entityId ?? '';
      if (selectedEntityId) {
        entity = await runtimeAdapterRead<StorageEntityCoreDoc>(`entity/${selectedEntityId}`);
        accounts = await runtimeAdapterRead<AccountPage>(`entity/${selectedEntityId}/accounts`, { limit: 100 });
        books = await runtimeAdapterRead<unknown[]>(`entity/${selectedEntityId}/books`);
      } else {
        entity = null;
        accounts = null;
        books = [];
      }
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  async function connect(): Promise<void> {
    error = null;
    try {
      await connectRuntimeAdapter({
        mode,
        ...(mode === 'remote' ? { wsUrl, authKey } : {}),
      });
      await refreshAll();
    } catch (err) {
      error = errorMessage(err);
    }
  }

  async function selectEntity(entityId: string): Promise<void> {
    selectedEntityId = entityId;
    await refreshAll();
  }

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const queryWs = params.get('ws');
    const queryKey = params.get('key');
    if (queryWs) {
      mode = 'remote';
      wsUrl = queryWs;
      authKey = queryKey ?? '';
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${protocol}//${window.location.host}/rpc`;
    }
    unsubscribeHeight = runtimeAdapterHeight.subscribe(() => {
      void refreshAll();
    });
    void connect();
  });

  onDestroy(() => {
    unsubscribeHeight?.();
  });
</script>

<svelte:head>
  <title>Runtime Adapter</title>
</svelte:head>

<main class="radapter-page">
  <header class="topbar">
    <div>
      <p class="eyebrow">XLN Runtime Adapter</p>
      <h1>Runtime Inspector</h1>
    </div>
    <div class="status-line">
      <span class="status {$runtimeAdapterStatus}">{$runtimeAdapterStatus}</span>
      <span>height {$runtimeAdapterHeight}</span>
      <span>{$runtimeAdapterAuthLevel ?? 'no auth'}</span>
    </div>
  </header>

  <section class="connect-band">
    <label>
      Mode
      <select bind:value={mode}>
        <option value="embedded">Embedded</option>
        <option value="remote">Remote</option>
      </select>
    </label>
    {#if mode === 'remote'}
      <label class="url-input">
        WS URL
        <input bind:value={wsUrl} placeholder="ws://127.0.0.1:8080/rpc" />
      </label>
      <label class="key-input">
        Key
        <input bind:value={authKey} type="password" placeholder="inspect/admin key" />
      </label>
    {/if}
    <button on:click={connect} disabled={loading}>{loading ? 'Loading' : 'Connect'}</button>
    <button class="secondary" on:click={refreshAll} disabled={loading}>Refresh</button>
    <button class="secondary" on:click={disconnectRuntimeAdapter}>Disconnect</button>
  </section>

  {#if error}
    <section class="error-band">{error}</section>
  {/if}

  <section class="summary-grid">
    <div class="metric">
      <span>Latest</span>
      <strong>{head?.latestHeight ?? 0}</strong>
    </div>
    <div class="metric">
      <span>Materialized</span>
      <strong>{head?.latestMaterializedHeight ?? 0}</strong>
    </div>
    <div class="metric">
      <span>Snapshot</span>
      <strong>{head?.latestSnapshotHeight ?? 0}</strong>
    </div>
    <div class="metric">
      <span>Entities</span>
      <strong>{entities.length}</strong>
    </div>
  </section>

  <section class="workspace">
    <aside class="entity-list">
      <h2>Entities</h2>
      {#each entities as item}
        <button
          class:active={item.entityId === selectedEntityId}
          on:click={() => selectEntity(item.entityId)}
        >
          <span>{item.label}</span>
          <small>{item.entityId.slice(-12)}</small>
        </button>
      {/each}
    </aside>

    <section class="details">
      {#if entity}
        <div class="section-title">
          <div>
            <p class="eyebrow">Entity</p>
            <h2>{entity.profile?.name || entity.entityId.slice(-12)}</h2>
          </div>
          <span class="height-pill">E{entity.height}</span>
        </div>

        <div class="account-table">
          <div class="table-head">
            <span>Counterparty</span>
            <span>Status</span>
            <span>Height</span>
            <span>Deltas</span>
          </div>
          {#each accounts?.items ?? [] as account}
            <div class="table-row">
              <span>{accountName(account)}</span>
              <span>{account.status}</span>
              <span>{account.currentHeight}</span>
              <span>{account.deltas?.size ?? 0}</span>
            </div>
          {/each}
          {#if (accounts?.items.length ?? 0) === 0}
            <p class="empty">No accounts.</p>
          {/if}
        </div>

        <div class="json-grid">
          <section>
            <h3>Entity Core</h3>
            <pre>{formatJson(entity)}</pre>
          </section>
          <section>
            <h3>Books</h3>
            <pre>{formatJson(books)}</pre>
          </section>
        </div>
      {:else}
        <p class="empty">No entity selected.</p>
      {/if}
    </section>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0d1117;
    color: #e6edf3;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .radapter-page {
    min-height: 100vh;
    padding: 28px;
    background: #0d1117;
  }

  .topbar,
  .connect-band,
  .workspace,
  .summary-grid {
    max-width: 1440px;
    margin: 0 auto;
  }

  .topbar {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 24px;
  }

  .eyebrow {
    margin: 0 0 6px;
    color: #7da7f7;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0;
  }

  h1,
  h2,
  h3 {
    margin: 0;
    letter-spacing: 0;
  }

  h1 {
    font-size: 30px;
  }

  h2 {
    font-size: 20px;
  }

  h3 {
    font-size: 14px;
    color: #c9d1d9;
  }

  .status-line {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
    color: #8b949e;
    font-size: 13px;
  }

  .status-line span,
  .height-pill {
    padding: 6px 10px;
    border: 1px solid #30363d;
    border-radius: 6px;
    background: #161b22;
  }

  .status.connected {
    color: #7ee787;
  }

  .status.error {
    color: #ff7b72;
  }

  .connect-band {
    display: grid;
    grid-template-columns: 150px minmax(260px, 1fr) minmax(220px, 320px) auto auto auto;
    gap: 12px;
    align-items: end;
    margin-bottom: 18px;
    padding: 16px 0;
    border-top: 1px solid #21262d;
    border-bottom: 1px solid #21262d;
  }

  label {
    display: grid;
    gap: 6px;
    color: #8b949e;
    font-size: 12px;
    font-weight: 700;
  }

  input,
  select,
  button {
    min-height: 40px;
    border: 1px solid #30363d;
    border-radius: 6px;
    background: #161b22;
    color: #e6edf3;
    font: inherit;
  }

  input,
  select {
    padding: 0 12px;
  }

  button {
    padding: 0 16px;
    cursor: pointer;
    font-weight: 700;
    color: #0d1117;
    background: #7da7f7;
    border-color: #7da7f7;
  }

  button.secondary {
    color: #c9d1d9;
    background: #161b22;
    border-color: #30363d;
  }

  button:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  .error-band {
    max-width: 1440px;
    margin: 0 auto 18px;
    padding: 12px 14px;
    border: 1px solid #f85149;
    border-radius: 6px;
    color: #ffb3ad;
    background: #2d1112;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(140px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }

  .metric {
    padding: 14px;
    border: 1px solid #30363d;
    border-radius: 6px;
    background: #161b22;
  }

  .metric span {
    display: block;
    color: #8b949e;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .metric strong {
    display: block;
    margin-top: 8px;
    font-size: 24px;
  }

  .workspace {
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr);
    gap: 20px;
    align-items: start;
  }

  .entity-list {
    display: grid;
    gap: 8px;
  }

  .entity-list h2 {
    margin-bottom: 8px;
  }

  .entity-list button {
    display: grid;
    gap: 4px;
    min-height: 58px;
    padding: 10px 12px;
    text-align: left;
    color: #c9d1d9;
    background: #161b22;
    border-color: #30363d;
  }

  .entity-list button.active {
    border-color: #7da7f7;
    background: #1c2433;
  }

  .entity-list small {
    color: #8b949e;
    font-size: 12px;
  }

  .details {
    min-width: 0;
  }

  .section-title {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }

  .account-table {
    border: 1px solid #30363d;
    border-radius: 6px;
    overflow: hidden;
    background: #0d1117;
  }

  .table-head,
  .table-row {
    display: grid;
    grid-template-columns: 1.4fr 0.8fr 0.6fr 0.6fr;
    gap: 12px;
    padding: 11px 14px;
    border-bottom: 1px solid #21262d;
    align-items: center;
  }

  .table-head {
    color: #8b949e;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    background: #161b22;
  }

  .table-row {
    color: #c9d1d9;
  }

  .table-row:last-child {
    border-bottom: 0;
  }

  .json-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 16px;
    margin-top: 18px;
  }

  .json-grid section {
    min-width: 0;
  }

  pre {
    max-height: 420px;
    overflow: auto;
    margin: 10px 0 0;
    padding: 12px;
    border: 1px solid #30363d;
    border-radius: 6px;
    background: #010409;
    color: #c9d1d9;
    font-size: 12px;
    line-height: 1.45;
  }

  .empty {
    margin: 0;
    padding: 16px;
    color: #8b949e;
  }

  @media (max-width: 900px) {
    .topbar,
    .workspace {
      display: block;
    }

    .status-line {
      justify-content: flex-start;
      margin-top: 12px;
    }

    .connect-band,
    .summary-grid,
    .json-grid {
      grid-template-columns: 1fr;
    }

    .entity-list {
      margin-bottom: 20px;
    }
  }
</style>
