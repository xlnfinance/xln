<script lang="ts">
  import {
    connectRuntimeAdapter,
    disconnectRuntimeAdapter,
    runtimeControllerHandle,
  } from '$lib/stores/runtimeControllerStore';
  import { refreshRuntimeView, runtimeView } from '$lib/stores/runtimeViewStore';
  import { makeQaSeveritySignal, type QaSeveritySignal } from '@xln/runtime/qa/severity';

  let wsUrl = $state('');
  let authKey = $state('');
  let selectedEntityId = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);

  const head = $derived($runtimeView.head);
  const viewFrame = $derived($runtimeView.frame);
  const entities = $derived(viewFrame?.entities ?? []);
  const activeEntity = $derived(viewFrame?.activeEntity ?? null);
  const activeAccounts = $derived(activeEntity?.accounts?.items ?? []);
  const activeAccountSummary = $derived(activeEntity?.accounts?.summary ?? null);
  const activeBooks = $derived(activeEntity?.books?.items ?? []);
  const busy = $derived(loading || $runtimeView.loading);
  const effectiveError = $derived(error ?? $runtimeView.error);
  const adapterSeverity = $derived.by<QaSeveritySignal>(() => {
    if (effectiveError) {
      return makeQaSeveritySignal({
        severity: 'FAIL',
        reason: effectiveError,
        since: Date.now(),
        owner: 'remote-adapter',
        evidence: [{ label: 'status', value: $runtimeControllerHandle.status }],
      });
    }
    if (busy) {
      return makeQaSeveritySignal({
        severity: 'UNKNOWN',
        reason: 'Runtime adapter request is in flight',
        since: Date.now(),
        owner: 'remote-adapter',
        evidence: [{ label: 'status', value: $runtimeControllerHandle.status }],
      });
    }
    if ($runtimeControllerHandle.status === 'connected') {
      return makeQaSeveritySignal({
        severity: viewFrame ? 'OK' : 'WARN',
        reason: viewFrame ? 'Remote runtime compact frame is loaded' : 'Remote adapter is connected; compact frame not loaded yet',
        since: Date.now(),
        owner: 'remote-adapter',
        evidence: [
          { label: 'height', value: $runtimeControllerHandle.height },
          { label: 'auth', value: $runtimeControllerHandle.authLevel ?? 'none' },
          { label: 'entities', value: entities.length },
        ],
      });
    }
    if ($runtimeControllerHandle.status === 'error') {
      return makeQaSeveritySignal({
        severity: 'FAIL',
        reason: 'Remote adapter connection failed',
        since: Date.now(),
        owner: 'remote-adapter',
        evidence: [{ label: 'status', value: $runtimeControllerHandle.status }],
      });
    }
    return makeQaSeveritySignal({
      severity: 'UNKNOWN',
      reason: 'Remote adapter is not connected',
      since: 0,
      owner: 'remote-adapter',
      evidence: [{ label: 'status', value: $runtimeControllerHandle.status }],
    });
  });

  function errorMessage(value: unknown): string {
    return value instanceof Error ? value.message : String(value || 'Runtime adapter error');
  }

  function short(value?: string | null, len = 10): string {
    const text = String(value || '');
    if (!text) return '-';
    return text.length <= len ? text : `${text.slice(0, len)}...${text.slice(-4)}`;
  }

  function formatCount(value: unknown): string {
    const count = Math.max(0, Math.floor(Number(value ?? 0)));
    return Number.isFinite(count) ? count.toLocaleString('en-US') : '0';
  }

  function formatPageLabel(pageIndex?: number | null, pageCount?: number | null): string {
    const current = pageIndex === null || pageIndex === undefined ? 1 : Math.max(1, Math.floor(pageIndex) + 1);
    const total = pageCount === null || pageCount === undefined ? null : Math.max(1, Math.floor(pageCount));
    return total ? `${current}/${formatCount(total)}` : `${current}`;
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
      const nextView = await refreshRuntimeView({
        limit: 12,
        accountsLimit: 10,
        booksLimit: 10,
        ...(selectedEntityId ? { entityId: selectedEntityId } : {}),
      });
      selectedEntityId = nextView.activeEntityId || nextView.entities[0]?.entityId || selectedEntityId;
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

</script>

<section id="runtime-adapter" class="runtime-adapter-panel">
  <div class="panel-head">
    <div>
      <h2>Runtime Adapter</h2>
      <p class="sub">Remote runtime frame reader for health debugging</p>
    </div>
    <a class="panel-link" href="/app">Open app</a>
  </div>

  <div class="status-line">
    <span class:ok={adapterSeverity.severity === 'OK'} class:bad={adapterSeverity.severity === 'FAIL'}>{adapterSeverity.severity}</span>
    <span title={adapterSeverity.reason}>{adapterSeverity.reason}</span>
    <span class:ok={$runtimeControllerHandle.status === 'connected'} class:bad={$runtimeControllerHandle.status === 'error'}>{$runtimeControllerHandle.status}</span>
    <span>height {$runtimeControllerHandle.height}</span>
    <span>{$runtimeControllerHandle.authLevel ?? 'no auth'}</span>
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
    <button onclick={connect} disabled={busy}>{busy ? 'Loading' : 'Connect'}</button>
    <button class="secondary" onclick={refresh} disabled={busy || $runtimeControllerHandle.status !== 'connected'}>Refresh</button>
    <button class="secondary" onclick={disconnectRuntimeAdapter}>Disconnect</button>
  </div>

  {#if effectiveError}
    <div class="error-band">{effectiveError}</div>
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
            <strong data-testid="radapter-account-visible">{formatCount(activeAccountSummary?.visibleItems ?? activeAccounts.length)}</strong>
            <small>limit {activeAccountSummary?.limit ?? activeEntity.accounts.limit ?? 10}</small>
          </article>
          <article>
            <span>Accounts total</span>
            <strong data-testid="radapter-account-total">{formatCount(activeAccountSummary?.totalItems ?? activeEntity.accounts.totalItems ?? activeAccounts.length)}</strong>
            <small data-testid="radapter-account-has-more">{activeAccountSummary?.hasMore || activeEntity.accounts.nextCursor ? 'cursor available' : 'complete page'}</small>
          </article>
          <article>
            <span>Account page</span>
            <strong data-testid="radapter-account-page">{formatPageLabel(activeAccountSummary?.pageIndex ?? activeEntity.accounts.pageIndex, activeAccountSummary?.pageCount ?? activeEntity.accounts.pageCount)}</strong>
            <small>{activeEntity.accounts.nextCursor ? 'more accounts' : 'no next cursor'}</small>
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

        {#if activeAccountSummary}
          <div class="aggregate-strip" data-testid="radapter-account-aggregate">
            <div>
              <span>Sample IDs</span>
              <strong>{activeAccountSummary.sampleIds.map((id) => short(id, 12)).join(' · ') || '-'}</strong>
            </div>
            <div>
              <span>Page hashes</span>
              <strong>
                {#each activeAccountSummary.pageStateHashes.slice(0, 3) as hash}
                  <code data-testid="radapter-state-hash">{short(hash, 12)}</code>
                {/each}
                {#if activeAccountSummary.pageStateHashes.length === 0}-{/if}
              </strong>
            </div>
            <div>
              <span>Top deltas</span>
              <strong>
                {#each activeAccountSummary.visibleTopDeltas.slice(0, 3) as delta}
                  <code data-testid="radapter-top-delta">T{delta.tokenId}:{delta.delta}</code>
                {/each}
                {#if activeAccountSummary.visibleTopDeltas.length === 0}-{/if}
              </strong>
            </div>
          </div>
        {/if}

        <div class="table">
          <div class="table-head">
            <span>Counterparty</span>
            <span>Status</span>
            <span>Height</span>
          </div>
          {#each activeAccounts as account}
            <div class="table-row" data-testid="radapter-account-row">
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

  .panel-head,
  .status-line,
  .detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

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

  h2,
  h3 {
    margin: 0;
    letter-spacing: 0;
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

  .aggregate-strip {
    display: grid;
    grid-template-columns: 1.2fr 1fr 1fr;
    gap: 10px;
    margin: -2px 0 14px;
  }

  .aggregate-strip div {
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    padding: 10px;
    background: rgba(0, 0, 0, 0.18);
  }

  .aggregate-strip span {
    display: block;
    color: #8b949e;
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .aggregate-strip strong {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 7px;
    color: #f8fafc;
    font-size: 12px;
    font-weight: 700;
  }

  .aggregate-strip code {
    border: 1px solid rgba(125, 167, 247, 0.2);
    border-radius: 5px;
    padding: 3px 5px;
    color: #dbeafe;
    background: rgba(125, 167, 247, 0.08);
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
    .bounded-grid,
    .aggregate-strip {
      grid-template-columns: 1fr;
    }

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
