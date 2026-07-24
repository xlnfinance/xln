<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  export let ready = false;
  export let reason: string | null = null;
  export let runtimeId = '';
  export let apiBase = '';

  type Incident = {
    fingerprint?: string;
    code?: string;
  };

  let mounted = false;
  let requestGeneration = 0;
  let loadedSignature = '';
  let incidentFingerprint = '';
  let incidentCode = '';
  let lookupStatus: 'idle' | 'loading' | 'not-found' | 'error' = 'idle';
  let lookupError = '';

  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  const loadIncident = async (signature: string): Promise<void> => {
    const generation = ++requestGeneration;
    incidentFingerprint = '';
    incidentCode = '';
    lookupStatus = 'loading';
    lookupError = '';
    let lastError = '';
    for (const delayMs of [0, 250, 750]) {
      if (delayMs > 0) await wait(delayMs);
      if (!mounted || generation !== requestGeneration) return;
      try {
        const url = new URL('/api/debug/incidents', apiBase || window.location.origin);
        url.searchParams.set('state', 'open');
        url.searchParams.set('runtimeId', runtimeId);
        url.searchParams.set('limit', '1');
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const payload = await response.json() as { ok?: boolean; incidents?: Incident[] };
        if (payload.ok !== true || !Array.isArray(payload.incidents)) {
          throw new Error('DEBUG_INCIDENT_RESPONSE_INVALID');
        }
        const incident = payload.incidents[0];
        if (incident?.fingerprint) {
          incidentFingerprint = String(incident.fingerprint);
          incidentCode = String(incident.code || '');
          lookupStatus = 'idle';
          return;
        }
        lastError = '';
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (generation === requestGeneration) {
      loadedSignature = signature;
      lookupError = lastError;
      lookupStatus = lastError ? 'error' : 'not-found';
    }
  };

  $: signature = ready ? '' : `${runtimeId}|${reason || 'unknown'}|${apiBase}`;
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
    requestGeneration += 1;
  });
</script>

{#if !ready}
  <aside class="command-gate" data-testid="runtime-command-gate" role="status">
    <div class="command-gate-copy">
      <strong>Runtime paused · financial actions disabled</strong>
      <span data-testid="runtime-command-gate-reason">{reason || 'readiness unavailable'}</span>
    </div>
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
