<script lang="ts">
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { runtimeCommandLatestReceipt } from '$lib/stores/runtimeCommandBus';
  import { refreshRuntimeView, runtimeView } from '$lib/stores/runtimeViewStore';
  import type { RuntimeAdapterViewFrame } from '@xln/runtime/xln-api';
  import { REMOTE_RUNTIME } from '@xln/runtime/constants';
  import type { Tab } from '$lib/types/ui';
  import EntityPanelTabs from './EntityPanelTabs.svelte';
  import {
    buildEntityWorkspaceView,
    type EntityWorkspaceView,
  } from './entity-workspace';
  import {
    emptyEntityWorkspaceRuntimeFrameContext,
    type EntityWorkspaceRuntimeFrameContext,
  } from './runtime-frame-context';
  import {
    emptyEntityWorkspaceEmbeddedRuntimeContext,
    type EntityWorkspaceEmbeddedRuntimeContext,
  } from './embedded-runtime-context';

  export let tab: Tab;
  export let hideHeader: boolean = false;
  export let showJurisdiction: boolean = true;
  export let userModeHeader: boolean = false;
  export let selectedJurisdiction: string | null = null;
  export let allowHeaderAddRuntime: boolean = false;
  export let headerRuntimeAddLabel: string = '+ Add Runtime';
  export let initialAction: 'r2r' | 'r2c' | undefined = undefined;
  export let workspaceView: EntityWorkspaceView | null = null;
  export let runtimeFrameContext: EntityWorkspaceRuntimeFrameContext = emptyEntityWorkspaceRuntimeFrameContext;
  export let embeddedRuntimeContext: EntityWorkspaceEmbeddedRuntimeContext = emptyEntityWorkspaceEmbeddedRuntimeContext;

  let workspaceProjectionFrame: RuntimeAdapterViewFrame | null = null;
  let workspaceProjectionError: string | null = null;
  let workspaceProjectionKey = '';
  let workspaceProjectionRequestId = 0;
  const WORKSPACE_VIEW_PAGE_SIZE = REMOTE_RUNTIME.VIEW_PAGE_SIZE;

  const errorMessage = (value: unknown): string =>
    value instanceof Error ? value.message : String(value || 'Runtime projection failed');

  const projectionFrameEntityId = (frame: RuntimeAdapterViewFrame | null | undefined): string =>
    String(frame?.activeEntityId || frame?.activeEntity?.summary?.entityId || frame?.activeEntity?.core?.entityId || '').trim().toLowerCase();

  const projectionFrameMatchesEntity = (
    frame: RuntimeAdapterViewFrame | null | undefined,
    entityId: string,
  ): boolean => {
    if (!frame?.activeEntity) return false;
    const frameEntityId = projectionFrameEntityId(frame);
    return !!frameEntityId && (!entityId || frameEntityId === entityId);
  };

  async function refreshWorkspaceProjection(key: string, entityId: string): Promise<void> {
    const requestId = ++workspaceProjectionRequestId;
    try {
      const view = await refreshRuntimeView({
        ...(entityId ? { entityId } : {}),
        accountsLimit: WORKSPACE_VIEW_PAGE_SIZE,
        booksLimit: WORKSPACE_VIEW_PAGE_SIZE,
      });
      if (requestId !== workspaceProjectionRequestId || key !== workspaceProjectionKey) return;
      workspaceProjectionFrame = view.frame;
      workspaceProjectionError = null;
    } catch (error) {
      if (requestId !== workspaceProjectionRequestId || key !== workspaceProjectionKey) return;
      workspaceProjectionFrame = null;
      workspaceProjectionError = errorMessage(error);
    }
  }

  $: {
    const tabEntityId = String(tab?.entityId || '').trim().toLowerCase();
    const runtimeActiveEntityId = String($runtimeView.activeEntityId || '').trim().toLowerCase();
    const handle = $runtimeControllerHandle;
    const entityId = handle.mode === 'remote'
      ? (tabEntityId || runtimeActiveEntityId)
      : tabEntityId;
    const nextKey = `${handle.id}|${handle.status}|${entityId}`;
    if (projectionFrameMatchesEntity($runtimeView.frame, entityId)) {
      workspaceProjectionKey = nextKey;
      workspaceProjectionFrame = $runtimeView.frame;
      workspaceProjectionError = null;
    } else if (nextKey !== workspaceProjectionKey) {
      workspaceProjectionKey = nextKey;
      workspaceProjectionFrame = null;
      workspaceProjectionError = null;
      if (handle.status === 'connected' && entityId) {
        void refreshWorkspaceProjection(nextKey, entityId);
      }
    }
  }

  $: workspaceProjectionEntityId = String(
    workspaceProjectionFrame?.activeEntityId ||
      workspaceProjectionFrame?.activeEntity?.summary?.entityId ||
      tab.entityId ||
      '',
  ).trim().toLowerCase();
  $: resolvedWorkspaceView = workspaceView ?? buildEntityWorkspaceView(
    workspaceProjectionFrame ? { ...workspaceProjectionFrame, runtimeId: $runtimeControllerHandle.id } : null,
    workspaceProjectionEntityId || tab.entityId,
  );
  $: frameContext = runtimeFrameContext ?? emptyEntityWorkspaceRuntimeFrameContext;
  $: embeddedFrameContext = embeddedRuntimeContext ?? emptyEntityWorkspaceEmbeddedRuntimeContext;
  $: runtimeFrameEnv = embeddedFrameContext.env;
</script>

<div class="entity-workspace" data-testid="entity-workspace">
  {#if workspaceProjectionError || $runtimeCommandLatestReceipt}
    <div class="workspace-status">
    {#if workspaceProjectionError}
      <span
        class="permission-pill error"
        data-testid="entity-workspace-projection-error"
        title={workspaceProjectionError}
      >Projection error</span>
    {/if}
    {#if $runtimeCommandLatestReceipt}
	      <span
	        class={`command-pill ${$runtimeCommandLatestReceipt.status}`}
	        data-testid="runtime-command-receipt"
	        title={$runtimeCommandLatestReceipt.error || $runtimeCommandLatestReceipt.upstreamReceiptId || $runtimeCommandLatestReceipt.statusUrl || $runtimeCommandLatestReceipt.receiptId}
      >
        {$runtimeCommandLatestReceipt.status}
        {#if $runtimeCommandLatestReceipt.failureKind}
          · {$runtimeCommandLatestReceipt.failureKind}
        {/if}
        {#if $runtimeCommandLatestReceipt.committedAtHeight !== null}
          h{$runtimeCommandLatestReceipt.committedAtHeight}
        {:else if $runtimeCommandLatestReceipt.acceptedAtHeight !== null}
          h{$runtimeCommandLatestReceipt.acceptedAtHeight}
        {/if}
      </span>
    {/if}
    </div>
  {/if}

  {#if runtimeFrameEnv || workspaceProjectionFrame}
    <EntityPanelTabs
      {tab}
      {hideHeader}
      {showJurisdiction}
      {userModeHeader}
      {selectedJurisdiction}
      {allowHeaderAddRuntime}
      {headerRuntimeAddLabel}
      {initialAction}
      runtimeFrameContext={frameContext}
      embeddedRuntimeContext={embeddedFrameContext}
      runtimeProjectionFrame={workspaceProjectionFrame}
      on:signerSelect
      on:addSigner
      on:entitySelect
      on:jurisdictionSelect
      on:addJurisdiction
      on:addEntity
      on:addRuntime
    />
  {:else}
    <section class="action-unavailable" data-testid="entity-workspace-action-unavailable">
      Runtime action surface requires a live runtime frame.
    </section>
  {/if}
</div>

<style>
  .entity-workspace {
    display: flex;
    flex-direction: column;
    min-height: 0;
    width: 100%;
  }

  .workspace-status {
    width: 100%;
    max-width: 1220px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px 0;
  }

  .permission-pill {
    margin-left: auto;
  }

  .command-pill {
    display: inline-flex;
    align-items: center;
    height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 800;
    text-transform: capitalize;
  }

  .permission-pill {
    display: inline-flex;
    align-items: center;
    height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--theme-accent, #fbbf24) 40%, transparent);
    color: var(--theme-accent, #fbbf24);
    font-size: 12px;
    font-weight: 800;
  }

  .permission-pill.error {
    border-color: color-mix(in srgb, #fb7185 46%, transparent);
    color: #fb7185;
  }

  .command-pill.pending,
  .command-pill.accepted {
    border: 1px solid color-mix(in srgb, var(--theme-accent, #fbbf24) 38%, transparent);
    color: var(--theme-accent, #fbbf24);
  }

  .command-pill.observed {
    border: 1px solid color-mix(in srgb, #38bdf8 42%, transparent);
    color: #38bdf8;
  }

  .command-pill.committed {
    border: 1px solid color-mix(in srgb, #22c55e 42%, transparent);
    color: #22c55e;
  }

  .command-pill.error {
    border: 1px solid color-mix(in srgb, #fb7185 46%, transparent);
    color: #fb7185;
  }

  .action-unavailable {
    width: 100%;
    max-width: 1220px;
    margin: 24px auto;
    padding: 18px 16px;
    border: 1px solid color-mix(in srgb, #fb7185 38%, transparent);
    border-radius: 8px;
    color: #fecaca;
    background: rgba(127, 29, 29, 0.16);
    font-weight: 700;
  }
</style>
