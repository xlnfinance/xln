<script lang="ts">
  import type { RuntimeAdapterTimelineIndexPage, StorageHead } from '@xln/runtime/xln-api';
  import { safeStringify } from '@xln/runtime/serialization-utils';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
  import { activeRuntime, vaultOperations } from '$lib/stores/vaultStore';

  let head: StorageHead | null = null;
  let checkpoints: Array<{ height?: number }> = [];
  let timeline: RuntimeAdapterTimelineIndexPage | null = null;
  let verification: unknown = null;
  let loading = false;
  let verifying = false;
  let error = '';

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
    if ($runtimeControllerHandle.mode !== 'embedded') {
      error = 'Remote chain verification requires a dedicated admin projection; inspect mode remains read-only.';
      return;
    }
    if (!$activeRuntime?.seed) {
      error = 'Active browser runtime seed is unavailable for verification.';
      return;
    }
    verifying = true;
    error = '';
    try {
      verification = await vaultOperations.verifyRuntimeChain($runtimeControllerHandle.id, $activeRuntime.seed);
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
    <article><small>Checkpoints</small><strong>{checkpoints.length}</strong></article>
  </div>
  <section><h3>Recent timeline index</h3><div class="frames">{#each timeline?.entries ?? [] as frame}<article><code>{frame.runtimeId}</code><span>h{frame.height}</span><span>{new Date(frame.timestamp).toISOString()}</span><span>{frame.graphChanged ? 'graph' : frame.materialized ? 'snapshot' : 'frame'}</span></article>{:else}<div class="empty">No persisted frame index.</div>{/each}</div></section>
  {#if verification}<details open><summary>Verification result</summary><pre>{safeStringify(verification, 2)}</pre></details>{/if}
</section>

<style>
  .diagnostics{height:100%;overflow:auto;box-sizing:border-box;padding:16px;background:#080d12;color:#e4edf3}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{margin:3px 0 0;font-size:18px}h3{font-size:13px;color:#91aaba}small{color:#7890a3}button{margin-left:6px;padding:7px 9px;border:1px solid #28475d;border-radius:6px;background:#0e1b25;color:#c6edff}.error{margin:10px 0;padding:9px;border:1px solid #5e2c36;color:#ff91a3}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:12px 0}.metrics article{display:grid;gap:5px;padding:10px;border:1px solid #182b38;border-radius:7px;background:#0b141b}.frames{border:1px solid #182b38;border-radius:7px;overflow:hidden}.frames article{display:grid;grid-template-columns:minmax(110px,1fr) auto 180px auto;gap:9px;padding:8px;border-bottom:1px solid #142631;font:11px ui-monospace,monospace}.frames article:last-child{border:0}.frames code{overflow:hidden;text-overflow:ellipsis;color:#72d4ff}.empty{padding:14px;color:#7890a3}details{margin-top:12px}pre{max-height:360px;overflow:auto;white-space:pre-wrap;font:11px/1.4 ui-monospace,monospace;color:#a8c6d8}
</style>
