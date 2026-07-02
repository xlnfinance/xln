<script lang="ts">
  import { RefreshCw } from 'lucide-svelte';
  import type {
    RuntimeAdapterActivityPage,
    RuntimeActivityEvent,
  } from '@xln/runtime/xln-api';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
  import { refreshRuntimeView, runtimeView } from '$lib/stores/runtimeViewStore';

  export let entityId: string;

  let activity: RuntimeAdapterActivityPage | null = null;
  let loading = false;
  let error: string | null = null;
  let lastKey = '';
  let requestId = 0;

  const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();

  const shortId = (value: unknown, headChars = 10): string => {
    const text = String(value || '').trim();
    if (!text) return '-';
    return text.length <= headChars + 6 ? text : `${text.slice(0, headChars)}...${text.slice(-4)}`;
  };

  const formatCount = (value: unknown): string => {
    const count = Math.max(0, Math.floor(Number(value ?? 0)));
    return Number.isFinite(count) ? count.toLocaleString('en-US') : '0';
  };

  const formatTimestamp = (value: unknown): string => {
    const timestamp = Number(value || 0);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  };

  const errorMessage = (value: unknown): string =>
    value instanceof Error ? value.message : String(value || 'Audit projection failed');

  async function refreshAudit(key: string, targetEntityId: string): Promise<void> {
    if (!targetEntityId) return;
    const currentRequest = ++requestId;
    loading = true;
    error = null;
    try {
      const [_nextView, nextActivity] = await Promise.all([
        refreshRuntimeView({
          entityId: targetEntityId,
          accountsLimit: 8,
          booksLimit: 8,
        }),
        runtimeQueryClient.readActivity({
          entityId: targetEntityId,
          limit: 12,
          scanLimit: 180,
        }),
      ]);
      if (currentRequest !== requestId || key !== lastKey) return;
      activity = nextActivity;
    } catch (err) {
      if (currentRequest !== requestId || key !== lastKey) return;
      error = errorMessage(err);
      activity = null;
    } finally {
      if (currentRequest === requestId) loading = false;
    }
  }

  $: normalizedEntityId = normalizeEntityId(entityId);
  $: head = $runtimeView.head;
  $: projectedEntityId = normalizeEntityId(
    $runtimeView.activeEntityId || $runtimeView.frame?.activeEntity?.summary?.entityId,
  );
  $: frame = projectedEntityId === normalizedEntityId ? $runtimeView.frame : null;
  $: activeEntity = frame?.activeEntity ?? null;
  $: activeSummary = activeEntity?.summary ?? null;
  $: accounts = activeEntity?.accounts?.items ?? [];
  $: books = activeEntity?.books?.items ?? [];
  $: events = (activity?.events ?? []) as RuntimeActivityEvent[];
  $: busy = loading || $runtimeView.loading;
  $: effectiveError = error ?? $runtimeView.error;
  $: statusLabel = $runtimeControllerHandle.authLevel ?? ($runtimeControllerHandle.mode === 'embedded' ? 'embedded' : 'inspect');

  $: {
    const handle = $runtimeControllerHandle;
    const nextKey = `${handle.id}|${handle.status}|${handle.height}|${normalizedEntityId}`;
    if (nextKey !== lastKey) {
      lastKey = nextKey;
      activity = null;
      error = null;
      if (handle.status === 'connected' && normalizedEntityId) {
        void refreshAudit(nextKey, normalizedEntityId);
      }
    }
  }
</script>

<section class="audit-panel" data-testid="entity-audit-panel">
  <header class="audit-head">
    <div>
      <p class="eyebrow">Audit</p>
      <h2>{activeSummary?.label || shortId(normalizedEntityId, 14)}</h2>
    </div>
    <button
      type="button"
      class="icon-button"
      title="Refresh audit projection"
      disabled={busy || !normalizedEntityId}
      on:click={() => void refreshAudit(lastKey, normalizedEntityId)}
    >
      <RefreshCw size={16} />
    </button>
  </header>

  <div class="status-strip">
    <span>{$runtimeControllerHandle.mode}</span>
    <span>{statusLabel}</span>
    <span>h{$runtimeControllerHandle.height}</span>
    {#if head}
      <span>snapshot h{head.latestSnapshotHeight ?? 0}</span>
    {/if}
  </div>

  {#if effectiveError}
    <div class="audit-error" data-testid="entity-audit-error">{effectiveError}</div>
  {:else if busy && !frame}
    <div class="audit-empty">Loading projection</div>
  {:else if !normalizedEntityId}
    <div class="audit-empty">No entity selected</div>
  {:else}
    <div class="audit-grid">
      <section class="audit-section">
        <div class="section-title">Entity</div>
        <dl>
          <div><dt>ID</dt><dd title={normalizedEntityId}>{shortId(normalizedEntityId, 18)}</dd></div>
          <div><dt>Runtime</dt><dd title={$runtimeControllerHandle.id}>{shortId($runtimeControllerHandle.id, 18)}</dd></div>
          <div><dt>Height</dt><dd>{formatCount(frame?.height ?? $runtimeControllerHandle.height)}</dd></div>
          <div><dt>Hub</dt><dd>{activeSummary?.isHub ? 'yes' : 'no'}</dd></div>
        </dl>
      </section>

      <section class="audit-section">
        <div class="section-title">Accounts</div>
        <dl>
          <div><dt>Shown</dt><dd data-testid="entity-audit-accounts-shown">{formatCount(accounts.length)}</dd></div>
          <div><dt>Total</dt><dd data-testid="entity-audit-accounts-total">{formatCount(activeEntity?.accounts?.totalItems ?? accounts.length)}</dd></div>
          <div><dt>Cursor</dt><dd>{activeEntity?.accounts?.nextCursor ? 'more' : 'end'}</dd></div>
        </dl>
      </section>

      <section class="audit-section">
        <div class="section-title">Books</div>
        <dl>
          <div><dt>Shown</dt><dd data-testid="entity-audit-books-shown">{formatCount(books.length)}</dd></div>
          <div><dt>Total</dt><dd data-testid="entity-audit-books-total">{formatCount(activeEntity?.books?.totalItems ?? books.length)}</dd></div>
          <div><dt>Cursor</dt><dd>{activeEntity?.books?.nextCursor ? 'more' : 'end'}</dd></div>
        </dl>
      </section>

      <section class="audit-section">
        <div class="section-title">Activity</div>
        <dl>
          <div><dt>Events</dt><dd data-testid="entity-audit-events-total">{formatCount(events.length)}</dd></div>
          <div><dt>Scanned</dt><dd data-testid="entity-audit-activity-scanned">{formatCount(activity?.scannedFrames ?? 0)}</dd></div>
          <div><dt>Latest</dt><dd data-testid="entity-audit-activity-latest">h{formatCount(activity?.latestHeight ?? 0)}</dd></div>
        </dl>
      </section>
    </div>

    <div class="activity-list" data-testid="entity-audit-activity">
      {#each events as event}
        <article class="activity-row">
          <div>
            <strong>{event.title || event.rawType || event.type}</strong>
            <span>{event.source || 'runtime'}</span>
          </div>
          <div class="activity-meta">
            <span>h{event.height}</span>
            <span>{formatTimestamp(event.timestamp)}</span>
          </div>
        </article>
      {:else}
        <div class="audit-empty">No activity</div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .audit-panel {
    width: 100%;
    max-width: 1220px;
    margin: 0 auto;
    padding: 18px 16px 32px;
    color: var(--theme-text-primary, #f4f4f5);
  }

  .audit-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 12px;
  }

  .eyebrow {
    margin: 0 0 4px;
    color: var(--theme-accent, #fbbf24);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    font-size: 24px;
    letter-spacing: 0;
  }

  .icon-button {
    width: 36px;
    height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 80%, transparent);
    background: color-mix(in srgb, var(--theme-card-bg, #111113) 88%, transparent);
    color: inherit;
    cursor: pointer;
  }

  .icon-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .status-strip,
  .audit-grid,
  .activity-list {
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 78%, transparent);
    background: color-mix(in srgb, var(--theme-card-bg, #111113) 82%, transparent);
  }

  .status-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 8px;
    margin-bottom: 12px;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 13px;
    font-weight: 700;
  }

  .audit-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border-radius: 8px;
    overflow: hidden;
  }

  .audit-section {
    padding: 14px;
    border-right: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 60%, transparent);
  }

  .audit-section:last-child {
    border-right: 0;
  }

  .section-title {
    margin-bottom: 10px;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
  }

  dl,
  dt,
  dd {
    margin: 0;
  }

  dl {
    display: grid;
    gap: 8px;
  }

  dl div,
  .activity-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }

  dt {
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 12px;
  }

  dd {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--theme-text-primary, #f4f4f5);
    font-size: 13px;
    font-weight: 800;
    text-align: right;
  }

  .activity-list {
    display: grid;
    gap: 0;
    margin-top: 12px;
    border-radius: 8px;
    overflow: hidden;
  }

  .activity-row {
    padding: 12px 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 58%, transparent);
  }

  .activity-row:last-child {
    border-bottom: 0;
  }

  .activity-row strong,
  .activity-row span {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .activity-row span,
  .activity-meta {
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 12px;
  }

  .activity-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .audit-empty,
  .audit-error {
    padding: 18px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 78%, transparent);
    background: color-mix(in srgb, var(--theme-card-bg, #111113) 82%, transparent);
    color: var(--theme-text-secondary, #a1a1aa);
  }

  .audit-error {
    border-color: color-mix(in srgb, #fb7185 48%, transparent);
    color: #fb7185;
  }

  @media (max-width: 860px) {
    .audit-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .audit-section:nth-child(2) {
      border-right: 0;
    }
  }

  @media (max-width: 560px) {
    .audit-grid {
      grid-template-columns: 1fr;
    }

    .audit-section {
      border-right: 0;
      border-bottom: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 60%, transparent);
    }

    .audit-section:last-child {
      border-bottom: 0;
    }
  }
</style>
