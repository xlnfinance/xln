<script lang="ts">
  import type { RuntimeAdapterActivityPage, RuntimeActivityEvent } from '@xln/runtime/xln-api';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
  import { refreshRuntimeView, runtimeView } from '$lib/stores/runtimeViewStore';

  export let entityId: string;

  let activity: RuntimeAdapterActivityPage | null = null;
  let loading = false;
  let error = '';
  let lastKey = '';
  let requestId = 0;

  const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();
  const count = (value: unknown): string => Math.max(0, Math.floor(Number(value || 0))).toLocaleString('en-US');
  const short = (value: unknown): string => {
    const text = String(value || '');
    return text.length > 24 ? `${text.slice(0, 14)}…${text.slice(-6)}` : text || '-';
  };
  const message = (value: unknown): string => value instanceof Error ? value.message : String(value || 'Audit failed');

  async function refreshAudit(key: string, targetEntityId: string): Promise<void> {
    if (!targetEntityId) return;
    const currentRequest = ++requestId;
    loading = true;
    error = '';
    try {
      const [, nextActivity] = await Promise.all([
        refreshRuntimeView({ entityId: targetEntityId, accountsLimit: 16, booksLimit: 16 }),
        runtimeQueryClient.readActivity({ entityId: targetEntityId, limit: 20, scanLimit: 240 }),
      ]);
      if (currentRequest !== requestId || key !== lastKey) return;
      activity = nextActivity;
    } catch (cause) {
      if (currentRequest !== requestId || key !== lastKey) return;
      activity = null;
      error = message(cause);
    } finally {
      if (currentRequest === requestId) loading = false;
    }
  }

  $: normalizedEntityId = normalizeId(entityId);
  $: projectedEntityId = normalizeId($runtimeView.activeEntityId || $runtimeView.frame?.activeEntityId);
  $: frame = projectedEntityId === normalizedEntityId ? $runtimeView.frame : null;
  $: active = frame?.activeEntity ?? null;
  $: accounts = active?.accounts.items ?? [];
  $: books = active?.books.items ?? [];
  $: events = (activity?.events ?? []) as RuntimeActivityEvent[];
  $: effectiveError = error || $runtimeView.error || '';
  $: {
    const nextKey = `${$runtimeControllerHandle.id}|${$runtimeControllerHandle.status}|${$runtimeControllerHandle.height}|${$runtimeView.atHeight ?? 'live'}|${normalizedEntityId}`;
    if (nextKey !== lastKey) {
      lastKey = nextKey;
      activity = null;
      error = '';
      if ($runtimeControllerHandle.status === 'connected' && normalizedEntityId) void refreshAudit(nextKey, normalizedEntityId);
    }
  }
</script>

<section class="audit" data-testid="entity-audit-panel">
  <header>
    <div><small>Reference entity audit</small><h2>{active?.summary.label || short(normalizedEntityId)}</h2></div>
    <button disabled={loading || !normalizedEntityId} on:click={() => void refreshAudit(lastKey, normalizedEntityId)}>Refresh</button>
  </header>

  <div class="status">
    <span>{$runtimeControllerHandle.mode}</span>
    <span>{$runtimeControllerHandle.authLevel || 'embedded'}</span>
    <span>{$runtimeView.atHeight === null ? 'LIVE' : `h${$runtimeView.atHeight}`}</span>
    <span title={$runtimeControllerHandle.id}>{short($runtimeControllerHandle.id)}</span>
  </div>

  {#if effectiveError}
    <div class="message error" data-testid="entity-audit-error">{effectiveError}</div>
  {:else if loading && !frame}
    <div class="message">Loading projection…</div>
  {:else if !normalizedEntityId}
    <div class="message">Select a reference entity in Main Wallet.</div>
  {:else}
    <div class="metrics">
      <article><small>Entity height</small><strong>{count(active?.core.height ?? frame?.height)}</strong></article>
      <article><small>Accounts</small><strong>{count(accounts.length)} / {count(active?.accounts.totalItems ?? accounts.length)}</strong></article>
      <article><small>Books</small><strong>{count(books.length)} / {count(active?.books.totalItems ?? books.length)}</strong></article>
      <article><small>Activity scan</small><strong>{count(events.length)} / {count(activity?.scannedFrames)}</strong></article>
    </div>
    <div class="coverage">
      <span>accounts cursor: {active?.accounts.nextCursor ? 'more' : 'end'}</span>
      <span>books cursor: {active?.books.nextCursor ? 'more' : 'end'}</span>
      <span>latest scanned: h{count(activity?.latestHeight)}</span>
    </div>
    <div class="events" data-testid="entity-audit-activity">
      {#each events as event}
        <article><div><strong>{event.title || event.rawType || event.type}</strong><small>{event.source || 'runtime'}</small></div><code>h{event.height}</code></article>
      {:else}
        <div class="message">No activity in the scanned window.</div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .audit { height: 100%; overflow: auto; box-sizing: border-box; padding: 16px; color: #e5edf3; background: #080d12; }
  header, .status, .coverage, .events article { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  header { margin-bottom: 12px; } h2 { margin: 3px 0 0; font-size: 18px; } small { color: #7890a3; }
  button { border: 1px solid #28445a; border-radius: 6px; background: #0e1b26; color: #bcecff; padding: 7px 10px; }
  button:disabled { opacity: .45; }
  .status, .coverage { flex-wrap: wrap; justify-content: flex-start; padding: 9px 10px; border: 1px solid #182b3a; border-radius: 7px; color: #8fb0c6; font: 11px ui-monospace, monospace; }
  .metrics { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 8px; margin: 10px 0; }
  .metrics article { display: grid; gap: 6px; padding: 12px; border: 1px solid #182b3a; border-radius: 7px; background: #0b141c; }
  .metrics strong { font: 700 15px ui-monospace, monospace; }
  .events { margin-top: 10px; border: 1px solid #182b3a; border-radius: 7px; overflow: hidden; }
  .events article { padding: 9px 11px; border-bottom: 1px solid #142431; } .events article:last-child { border-bottom: 0; }
  .events article div { display: grid; gap: 2px; min-width: 0; } code { color: #75d7ff; }
  .message { padding: 18px; color: #7890a3; } .message.error { color: #ff8fa2; border: 1px solid #5f2631; }
  @media (max-width: 800px) { .metrics { grid-template-columns: repeat(2, minmax(0,1fr)); } }
</style>
