<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { operatorDiagnosticsAllowed } from '#lib/debug/operator-diagnostics.ts';
  import { loadRuntimeIncident } from '#lib/debug/runtime-incident.ts';

  export let ready = false;
  export let reason: string | null = null;
  export let runtimeId = '';
  export let apiBase = '';

  let mounted = false;
  let requestGeneration = 0;
  let loadedSignature = '';
  let incidentFingerprint = '';
  let incidentCode = '';
  let lookupStatus: 'idle' | 'loading' | 'not-found' | 'error' = 'idle';
  let lookupError = '';

  let controller: AbortController | null = null;
  const loadIncident = async (signature: string): Promise<void> => {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    const generation = ++requestGeneration;
    incidentFingerprint = '';
    incidentCode = '';
    lookupStatus = 'loading';
    lookupError = '';
    try {
      const result = await loadRuntimeIncident(apiBase || window.location.origin, runtimeId, request.signal);
      if (!mounted || generation !== requestGeneration) return;
      loadedSignature = signature;
      if (result.status === 'found') {
        incidentFingerprint = result.fingerprint;
        incidentCode = result.code;
        lookupStatus = 'idle';
      } else {
        lookupStatus = result.status;
        lookupError = result.status === 'error' ? result.error : '';
      }
    } catch (error) {
      if (!request.signal.aborted) throw error;
    }
  };

  $: operatorDiagnostics = $operatorDiagnosticsAllowed;
  $: signature = ready || !operatorDiagnostics ? '' : `${runtimeId}|${reason || 'unknown'}|${apiBase}`;
  $: if (!signature) {
    controller?.abort();
    loadedSignature = '';
    incidentFingerprint = '';
    incidentCode = '';
  }
  $: if (mounted && signature && signature !== loadedSignature) {
    loadedSignature = signature;
    void loadIncident(signature);
  }

  onMount(() => {
    mounted = true;
    if (signature) {
      loadedSignature = signature;
      void loadIncident(signature);
    }
  });

  onDestroy(() => {
    mounted = false;
    controller?.abort();
    requestGeneration += 1;
  });
</script>

{#if !ready}
  <aside class="command-gate" data-testid="runtime-command-gate" role="status">
    <div class="command-gate-copy">
      <strong>Runtime paused · financial actions disabled</strong>
      <span data-testid="runtime-command-gate-reason">{reason || 'readiness unavailable'}</span>
    </div>
    {#if operatorDiagnostics}
    <div class="command-gate-incident">
      {#if incidentFingerprint}
        <span>{incidentCode || 'Incident'}</span>
        <code data-testid="runtime-command-gate-incident">{incidentFingerprint}</code>
      {:else if lookupStatus === 'error'}
        <span data-testid="runtime-command-gate-incident-unavailable">
          Incident registry unavailable · {lookupError}
        </span>
      {:else if lookupStatus === 'not-found'}
        <span data-testid="runtime-command-gate-incident-pending">Root incident is not indexed yet</span>
      {:else}
        <span>Resolving root incident…</span>
      {/if}
      <a href={`/qa?runtimeId=${encodeURIComponent(runtimeId)}#system-health`}>Open QA</a>
    </div>
    {/if}
  </aside>
{/if}

<style>
  .command-gate {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin: 12px 16px 0;
    padding: 12px 14px;
    border: 1px solid color-mix(in srgb, #ffb020 45%, transparent);
    border-radius: 12px;
    background: color-mix(in srgb, #ffb020 9%, var(--theme-surface, #111));
    color: var(--theme-text-primary, #f5f5f5);
  }

  .command-gate-copy,
  .command-gate-incident {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .command-gate-copy span,
  .command-gate-incident span {
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 12px;
  }

  code {
    max-width: 260px;
    overflow: hidden;
    color: #ffcb6b;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  a {
    flex: none;
    color: #ffcb6b;
    font-size: 12px;
    font-weight: 650;
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }

  @media (max-width: 720px) {
    .command-gate,
    .command-gate-copy,
    .command-gate-incident {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
