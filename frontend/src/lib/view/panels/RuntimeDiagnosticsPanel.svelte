<script lang="ts">
  import type { RuntimeAdapterTimelineIndexPage, StorageHead } from '@xln/runtime/xln-api';
  import type { RuntimeSecurityIncident } from '@xln/runtime/types';
  import { safeStringify } from '@xln/runtime/protocol/serialization';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { getRuntimeControllerAdapter } from '$lib/stores/runtimeControllerStore';
  import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
  import { activeRuntime } from '$lib/stores/vaultStore';

  let head: StorageHead | null = null;
  let checkpoints: Array<{ height?: number }> = [];
  let timeline: RuntimeAdapterTimelineIndexPage | null = null;
  let verification: unknown = null;
  let loading = false;
  let verifying = false;
  let error = '';
  let securityIncidents: RuntimeSecurityIncident[] = [];
  let activeSecurityIncidents: RuntimeSecurityIncident[] = [];

  $: securityIncidents = Array.from(
    $activeRuntime?.env?.runtimeState?.securityIncidents?.values() ?? [],
  ).sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.id.localeCompare(right.id));
  $: activeSecurityIncidents = securityIncidents.filter((incident) => incident.status === 'active');

  async function refresh(): Promise<void> {
    loading = true;
    error = '';
    try {
      [head, checkpoints, timeline] = await Promise.all([
        runtimeQueryClient.readHead(),
        runtimeQueryClient.readCheckpoints(),
        runtimeQueryClient.readTimelineIndex({ limit: 40, scanLimit: 160 }),
      ]);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  async function verify(): Promise<void> {
    verifying = true;
    error = '';
    try {
	  const adapter = getRuntimeControllerAdapter();
	  if (!adapter || adapter.status !== 'connected') throw new Error('Runtime adapter is not connected.');
	  verification = await adapter.control('verify-chain');
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      verification = null;
    } finally {
      verifying = false;
    }
  }

  $: if ($runtimeControllerHandle.status === 'connected') void refresh();
</script>

<section class="diagnostics" data-testid="runtime-diagnostics-panel">
  <header><div><small>Storage integrity</small><h2>Runtime Diagnostics</h2></div><div><button disabled={loading} on:click={() => void refresh()}>Refresh</button><button disabled={verifying} on:click={() => void verify()}>{verifying ? 'Verifying…' : 'Verify chain'}</button></div></header>
  {#if error}<div class="error">{error}</div>{/if}
  <div class="metrics">
    <article><small>Adapter</small><strong>{$runtimeControllerHandle.mode === 'embedded' ? 'browser' : 'remote'}</strong></article>
    <article><small>Live height</small><strong>{$runtimeControllerHandle.height}</strong></article>
    <article><small>Persisted</small><strong>{head?.latestHeight ?? '—'}</strong></article>
    <article><small>Security</small><strong class:critical={activeSecurityIncidents.length > 0}>{activeSecurityIncidents.length > 0 ? `${activeSecurityIncidents.length} active` : 'clear'}</strong></article>
  </div>
  <section data-testid="runtime-security-status">
    <h3>Security status</h3>
    <div class="incidents">
      {#each securityIncidents.slice(0, 20) as incident}
        <article class:active={incident.status === 'active'} data-testid="runtime-security-incident">
          <div><strong>{incident.code}</strong><span>{incident.status}</span></div>
          <p>{incident.summary}</p>
          <small>{incident.entityId || 'runtime'} · seen {incident.occurrences}× · {new Date(incident.lastSeenAt).toISOString()}</small>
        </article>
      {:else}
        <div class="empty" data-testid="runtime-security-clear">No active security incidents.</div>
      {/each}
    </div>
  </section>
  <section><h3>Recent timeline index</h3><div class="frames">{#each timeline?.entries ?? [] as frame}<article><code>{frame.runtimeId}</code><span>h{frame.height}</span><span>{new Date(frame.timestamp).toISOString()}</span><span>{frame.graphChanged ? 'graph' : frame.materialized ? 'snapshot' : 'frame'}</span></article>{:else}<div class="empty">No persisted frame index.</div>{/each}</div></section>
  {#if verification}<details open><summary>Verification result</summary><pre>{safeStringify(verification, 2)}</pre></details>{/if}
</section>

<style>
  .diagnostics{height:100%;overflow:auto;box-sizing:border-box;padding:16px;background:#080d12;color:#e4edf3}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{margin:3px 0 0;font-size:18px}h3{font-size:13px;color:#91aaba}small{color:#7890a3}button{margin-left:6px;padding:7px 9px;border:1px solid #28475d;border-radius:6px;background:#0e1b25;color:#c6edff}.error{margin:10px 0;padding:9px;border:1px solid #5e2c36;color:#ff91a3}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:12px 0}.metrics article{display:grid;gap:5px;padding:10px;border:1px solid #182b38;border-radius:7px;background:#0b141b}.critical{color:#ff6b7d}.incidents{display:grid;gap:7px;margin-bottom:14px}.incidents article{padding:10px;border:1px solid #203746;border-radius:7px;background:#0b141b}.incidents article.active{border-color:#8a3846;background:#1b1015}.incidents article>div{display:flex;justify-content:space-between;gap:8px}.incidents p{margin:6px 0;color:#c4d4df;font-size:12px}.incidents span{color:#ff91a3;font-size:11px;text-transform:uppercase}.frames{border:1px solid #182b38;border-radius:7px;overflow:hidden}.frames article{display:grid;grid-template-columns:minmax(110px,1fr) auto 180px auto;gap:9px;padding:8px;border-bottom:1px solid #142631;font:11px ui-monospace,monospace}.frames article:last-child{border:0}.frames code{overflow:hidden;text-overflow:ellipsis;color:#72d4ff}.empty{padding:14px;color:#7890a3}details{margin-top:12px}pre{max-height:360px;overflow:auto;white-space:pre-wrap;font:11px/1.4 ui-monospace,monospace;color:#a8c6d8}
</style>
