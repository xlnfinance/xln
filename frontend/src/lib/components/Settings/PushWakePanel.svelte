<script lang="ts">
  import type { Env } from '@xln/runtime/xln-api';
  import type { RecoveryTowerConfig, Runtime } from '$lib/stores/vaultStore';
  import { vaultOperations } from '$lib/stores/vaultStore';
  import {
    buildPushWakeRegistrationPayload,
    buildPushWakeRegistrationRequest,
    buildPushWakeUnregisterPayload,
    buildPushWakeUnregisterRequest,
    buildWatchtowerPushRequestUrl,
    readPushWakeRegistrationRecords,
    removePushWakeRegistrationRecord,
    requestPushWakeDeviceToken,
    resolvePushWakeTarget,
    upsertPushWakeRegistrationRecord,
    type PushWakeRegistrationRecord,
  } from '$lib/utils/pushWakeRegistration';
  import { normalizeTowerMode } from '$lib/utils/recoverySettings';
  import { Bell, BellOff, Check, LoaderCircle } from 'lucide-svelte';
  import { onMount } from 'svelte';

  export let runtime: Runtime | null = null;
  export let env: Env | null = null;
  export let entityId = '';
  export let jurisdictionName = '';
  export let towers: RecoveryTowerConfig[] = [];
  export let activeIsLive = true;

  let records: PushWakeRegistrationRecord[] = [];
  let busy = false;
  let status = '';
  let tone: 'neutral' | 'ok' | 'error' = 'neutral';

  const normalizeTowerUrl = (value: string): string => new URL(value.trim()).toString().replace(/\/+$/, '');

  const configuredTowers = (
    draftTowers: RecoveryTowerConfig[],
    persistedTowers: RecoveryTowerConfig[],
  ): RecoveryTowerConfig[] => {
    const deduped = new Map<string, RecoveryTowerConfig>();
    const sourceTowers = draftTowers.length > 0 ? draftTowers : persistedTowers;
    for (const tower of sourceTowers) {
      try {
        if (tower.enabled === false) continue;
        const url = normalizeTowerUrl(tower.url);
        deduped.set(url, { ...tower, url });
      } catch {
        // Invalid draft URLs are shown by the recovery editor; push registration
        // should only attempt normalized tower URLs.
      }
    }
    return [...deduped.values()];
  };

  const refreshRecords = (): void => {
    if (!runtime?.id || !effectiveEntityId) {
      records = [];
      return;
    }
    records = readPushWakeRegistrationRecords(runtime.id, effectiveEntityId);
  };

  const parseJson = async (response: Response): Promise<Record<string, unknown>> => {
    const text = await response.text();
    if (!text.trim()) return {};
    return JSON.parse(text) as Record<string, unknown>;
  };

  $: towerList = configuredTowers(towers || [], runtime?.recovery?.towers || []);
  $: activeSignerEntityId = String(runtime?.signers?.[runtime.activeSignerIndex || 0]?.entityId || '').trim();
  $: firstSignerEntityId = String((runtime?.signers || []).find((signer) => signer.entityId)?.entityId || '').trim();
  $: effectiveEntityId = String(entityId || activeSignerEntityId || firstSignerEntityId || '').trim();
  $: activeRecords = records.filter((record) =>
    towerList.some((tower) => tower.url === record.towerUrl),
  );
  $: registeredCount = activeRecords.length;
  $: canRegister = Boolean(runtime?.id && env && effectiveEntityId && activeIsLive && towerList.length > 0 && !busy);
  $: canUnregister = Boolean(runtime?.id && activeIsLive && activeRecords.length > 0 && !busy);
  $: if (runtime?.id || effectiveEntityId) refreshRecords();

  onMount(refreshRecords);

  async function registerPushWake(): Promise<void> {
    if (!runtime?.id || !env || !effectiveEntityId) return;
    busy = true;
    status = '';
    tone = 'neutral';
    try {
      const target = resolvePushWakeTarget(env, {
        runtimeId: runtime.id,
        entityId: effectiveEntityId,
        jurisdictionName,
      });
      const device = await requestPushWakeDeviceToken();
      const signedAt = Date.now();
      const registrationPayload = buildPushWakeRegistrationPayload(target, device, signedAt);
      const ownerSignature = await vaultOperations.signRuntimeOwnerMessage(runtime.id, registrationPayload.message);
      const request = buildPushWakeRegistrationRequest(target, device, signedAt, ownerSignature);
      const errors: string[] = [];
      let accepted = 0;

      for (const tower of towerList) {
        try {
          const response = await fetch(buildWatchtowerPushRequestUrl(tower.url, '/api/push/register'), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          });
          const payload = await parseJson(response);
          if (!response.ok || payload['ok'] !== true) {
            throw new Error(String(payload['error'] || `HTTP_${response.status}`));
          }
          upsertPushWakeRegistrationRecord({
            ...target,
            towerUrl: tower.url,
            tokenHash: registrationPayload.tokenHash,
            platform: device.platform,
            updatedAt: Math.max(0, Math.floor(Number(payload['updatedAt'] || Date.now()))),
          });
          accepted += 1;
        } catch (error) {
          errors.push(`${tower.url}:${error instanceof Error ? error.message : String(error)}`);
        }
      }

      refreshRecords();
      if (accepted === 0) throw new Error(errors.join(' | ') || 'PUSH_REGISTER_REJECTED');
      status = `Registered ${accepted}/${towerList.length} tower${towerList.length === 1 ? '' : 's'}`;
      tone = errors.length > 0 ? 'error' : 'ok';
      if (errors.length > 0) status += `; ${errors.join(' | ')}`;
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
      tone = 'error';
    } finally {
      busy = false;
    }
  }

  async function unregisterPushWake(): Promise<void> {
    if (!runtime?.id || activeRecords.length === 0) return;
    busy = true;
    status = '';
    tone = 'neutral';
    try {
      const errors: string[] = [];
      const total = activeRecords.length;
      let removed = 0;
      for (const record of activeRecords) {
        try {
          const signedAt = Date.now();
          const unregisterPayload = buildPushWakeUnregisterPayload(runtime.id, record.tokenHash, signedAt);
          const ownerSignature = await vaultOperations.signRuntimeOwnerMessage(runtime.id, unregisterPayload.message);
          const request = buildPushWakeUnregisterRequest(runtime.id, record.tokenHash, signedAt, ownerSignature);
          const response = await fetch(buildWatchtowerPushRequestUrl(record.towerUrl, '/api/push/unregister'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          });
          const payload = await parseJson(response);
          if (!response.ok || payload['ok'] !== true) {
            throw new Error(String(payload['error'] || `HTTP_${response.status}`));
          }
          removePushWakeRegistrationRecord(record);
          removed += Number(payload['removed'] || 0) > 0 ? 1 : 0;
        } catch (error) {
          errors.push(`${record.towerUrl}:${error instanceof Error ? error.message : String(error)}`);
        }
      }
      refreshRecords();
      if (errors.length > 0) throw new Error(errors.join(' | '));
      status = `Revoked ${removed}/${total}`;
      tone = 'ok';
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
      tone = 'error';
    } finally {
      busy = false;
    }
  }
</script>

<section class="section-card push-wake-panel" data-testid="push-wake-panel">
  <div class="section-head">
    <div>
      <h3>Dispute Wake</h3>
      <p class="section-desc">Signed device wake registration for the active entity.</p>
    </div>
    <span class="wake-state" class:ok={registeredCount > 0} data-testid="push-wake-state">
      {registeredCount > 0 ? 'registered' : 'not registered'}
    </span>
  </div>

  {#if runtime && env && effectiveEntityId}
    <div class="wake-summary">
      <div>
        <span class="summary-label">Entity</span>
        <span class="summary-value mono">{effectiveEntityId.slice(0, 10)}...{effectiveEntityId.slice(-6)}</span>
      </div>
      <div>
        <span class="summary-label">Services</span>
        <span class="summary-value">{registeredCount}/{towerList.length}</span>
      </div>
      <div>
        <span class="summary-label">Mode</span>
        <span class="summary-value">{activeIsLive ? 'live' : 'historical'}</span>
      </div>
    </div>

    {#if towerList.length === 0}
      <div class="empty-card">No recovery services configured.</div>
    {:else}
      <div class="wake-towers">
        {#each towerList as tower}
          {@const record = activeRecords.find((entry) => entry.towerUrl === tower.url)}
          <div class="wake-tower-row">
            <div>
              <span class="tower-mode">{normalizeTowerMode(tower.towerMode) === 'delayed_last_resort' ? 'last resort' : 'backup'}</span>
              <span class="tower-url mono">{tower.url}</span>
            </div>
            <span class="tower-status" class:on={!!record}>
              {#if record}
                <Check size={13} /> {record.platform}
              {:else}
                off
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {/if}

    <div class="wake-actions">
      <button
        class="primary-btn"
        type="button"
        data-testid="push-wake-register"
        disabled={!canRegister}
        on:click={registerPushWake}
      >
        {#if busy}
          <LoaderCircle size={15} />
        {:else}
          <Bell size={15} />
        {/if}
        <span>Register Device</span>
      </button>
      <button
        class="compact-btn"
        type="button"
        data-testid="push-wake-unregister"
        disabled={!canUnregister}
        on:click={unregisterPushWake}
      >
        <BellOff size={15} />
        <span>Revoke</span>
      </button>
    </div>

    {#if status}
      <p class:error-text={tone === 'error'} class:success-text={tone === 'ok'} class:helper-note={tone === 'neutral'} data-testid="push-wake-status">
        {status}
      </p>
    {/if}
  {:else}
    <div class="empty-card">Select a live entity before registering device wakes.</div>
  {/if}
</section>

<style>
  .section-card {
    background: var(--surface, rgba(24, 24, 27, 0.72));
    border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    padding: 16px;
  }

  .section-head {
    align-items: flex-start;
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }

  h3 {
    color: var(--text-primary, #f4f4f5);
    font-size: 15px;
    margin: 0;
  }

  .section-desc,
  .helper-note,
  .error-text {
    color: var(--text-secondary, #a1a1aa);
    font-size: 12px;
    margin: 4px 0 0;
  }

  .error-text {
    color: #fca5a5;
  }

  .empty-card {
    border: 1px dashed var(--surface-border, rgba(255, 255, 255, 0.14));
    border-radius: 8px;
    color: var(--text-secondary, #a1a1aa);
    font-size: 13px;
    padding: 12px;
  }

  .primary-btn,
  .compact-btn {
    border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.14));
    border-radius: 8px;
    color: var(--text-primary, #f4f4f5);
    cursor: pointer;
    font-size: 13px;
    min-height: 36px;
    padding: 8px 12px;
  }

  .primary-btn {
    background: var(--accent-color, #2563eb);
    border-color: color-mix(in srgb, var(--accent-color, #2563eb) 70%, white 12%);
  }

  .compact-btn {
    background: var(--surface-elevated, rgba(39, 39, 42, 0.88));
  }

  .primary-btn:disabled,
  .compact-btn:disabled {
    cursor: not-allowed;
    opacity: 0.46;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }

  .push-wake-panel {
    gap: 14px;
  }

  .wake-state,
  .tower-status,
  .tower-mode {
    border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.12));
    border-radius: 999px;
    color: var(--text-secondary, #a1a1aa);
    font-size: 11px;
    font-weight: 700;
    padding: 4px 8px;
    text-transform: uppercase;
  }

  .wake-state.ok,
  .tower-status.on {
    border-color: rgba(16, 185, 129, 0.36);
    color: #6ee7b7;
  }

  .wake-summary {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .summary-label,
  .tower-mode {
    display: block;
    color: var(--text-muted, #71717a);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .summary-value {
    display: block;
    color: var(--text-primary, #f4f4f5);
    font-size: 13px;
    margin-top: 3px;
  }

  .wake-towers {
    display: grid;
    gap: 8px;
  }

  .wake-tower-row {
    align-items: center;
    border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    display: flex;
    gap: 12px;
    justify-content: space-between;
    padding: 10px 12px;
  }

  .tower-url {
    color: var(--text-secondary, #a1a1aa);
    display: block;
    font-size: 12px;
    margin-top: 4px;
    overflow-wrap: anywhere;
  }

  .tower-status {
    align-items: center;
    display: inline-flex;
    gap: 5px;
    white-space: nowrap;
  }

  .wake-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .wake-actions button {
    align-items: center;
    display: inline-flex;
    gap: 8px;
  }

  .success-text {
    color: #6ee7b7;
    font-size: 12px;
  }

  @media (max-width: 720px) {
    .wake-summary {
      grid-template-columns: 1fr;
    }

    .wake-tower-row {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
