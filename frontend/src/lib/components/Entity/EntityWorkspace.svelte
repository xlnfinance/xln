<script lang="ts">
  import type { ComponentType } from 'svelte';
  import { Wallet, Activity, LineChart, Search } from 'lucide-svelte';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { runtimeCommandLatestReceipt } from '$lib/stores/runtimeCommandBus';
  import { refreshRuntimeView, runtimeView } from '$lib/stores/runtimeViewStore';
  import type { RuntimeAdapterViewFrame } from '@xln/runtime/xln-api';
  import { REMOTE_RUNTIME } from '@xln/runtime/constants';
  import type { Tab } from '$lib/types/ui';
  import EntityAuditPanel from './EntityAuditPanel.svelte';
  import EntityPanelTabs from './EntityPanelTabs.svelte';
  import {
    buildEntityWorkspaceView,
    defaultLensForCapabilities,
    resolveEntityWorkspaceCapabilities,
    type EntityWorkspaceLensId,
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
  import ContextSwitcher from './ContextSwitcher.svelte';

  export let tab: Tab;
  export let hideHeader: boolean = false;
  export let showJurisdiction: boolean = true;
  export let userModeHeader: boolean = false;
  export let selectedJurisdiction: string | null = null;
  export let allowHeaderAddRuntime: boolean = false;
  export let allowHeaderDeleteRuntime: boolean = false;
  export let headerRuntimeAddLabel: string = '+ Add Runtime';
  export let initialAction: 'r2r' | 'r2c' | undefined = undefined;
  export let workspaceView: EntityWorkspaceView | null = null;
  export let runtimeFrameContext: EntityWorkspaceRuntimeFrameContext = emptyEntityWorkspaceRuntimeFrameContext;
  export let embeddedRuntimeContext: EntityWorkspaceEmbeddedRuntimeContext = emptyEntityWorkspaceEmbeddedRuntimeContext;

  type LensView = {
    id: EntityWorkspaceLensId;
    label: string;
    icon: ComponentType;
    enabled: boolean;
    title: string;
  };

  let selectedLens: EntityWorkspaceLensId | null = null;
  let lensNavigationVersion = 0;
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
    const nextKey = `${handle.id}|${handle.status}|${handle.authLevel ?? ''}|${entityId}`;
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
  $: capabilities = resolveEntityWorkspaceCapabilities({
    mode: $runtimeControllerHandle.mode,
    authLevel: $runtimeControllerHandle.authLevel,
  }, resolvedWorkspaceView);
  $: if (!selectedLens || !capabilities.lenses.some((lens) => lens.id === selectedLens && lens.enabled)) {
    selectedLens = defaultLensForCapabilities(capabilities);
  }
  $: lensItems = capabilities.lenses.map((lens): LensView => ({
    id: lens.id,
    label: lens.id === 'wallet' ? 'Wallet' : lens.id === 'ops' ? 'Ops' : lens.id === 'liquidity' ? 'Liquidity' : 'Audit',
    icon: lens.id === 'wallet' ? Wallet : lens.id === 'ops' ? Activity : lens.id === 'liquidity' ? LineChart : Search,
    enabled: lens.enabled,
    title: lens.reason || (lens.canWrite ? 'Read/write' : 'Read only'),
  }));
  $: frameContext = runtimeFrameContext ?? emptyEntityWorkspaceRuntimeFrameContext;
  $: embeddedFrameContext = embeddedRuntimeContext ?? emptyEntityWorkspaceEmbeddedRuntimeContext;
  $: runtimeFrameEnv = embeddedFrameContext.env;
</script>

<div class="entity-workspace" data-testid="entity-workspace" data-lens={selectedLens}>
  <div class="lens-bar" role="tablist" aria-label="Entity workspace lenses">
    {#if userModeHeader && selectedLens === 'audit'}
      <div class="workspace-context-switcher">
        <ContextSwitcher
          {tab}
          allowAddRuntime={allowHeaderAddRuntime}
          allowDeleteRuntime={allowHeaderDeleteRuntime}
          allowAddJurisdiction={true}
          allowAddEntity={true}
          addRuntimeLabel={headerRuntimeAddLabel}
          on:addRuntime
          on:deleteRuntime
          on:addJurisdiction
          on:addEntity
          on:entitySelect
        />
      </div>
    {/if}
    {#each lensItems as lens}
      <button
        type="button"
        class="lens-button"
        class:active={selectedLens === lens.id}
        disabled={!lens.enabled}
        title={lens.title}
        data-testid={`entity-lens-${lens.id}`}
        on:click={() => {
          if (lens.enabled) {
            selectedLens = lens.id;
            lensNavigationVersion += 1;
          }
        }}
      >
        <svelte:component this={lens.icon} size={14} />
        <span>{lens.label}</span>
      </button>
    {/each}
    {#if capabilities.readOnlyReason}
      <span class="permission-pill" data-testid="entity-workspace-readonly">Read only</span>
    {/if}
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
        {#if $runtimeCommandLatestReceipt.committedAtHeight !== null}
          h{$runtimeCommandLatestReceipt.committedAtHeight}
        {:else if $runtimeCommandLatestReceipt.acceptedAtHeight !== null}
          h{$runtimeCommandLatestReceipt.acceptedAtHeight}
        {/if}
      </span>
    {/if}
  </div>

  {#if selectedLens === 'audit'}
    <EntityAuditPanel
      entityId={resolvedWorkspaceView.entityId || tab.entityId}
    />
  {:else if runtimeFrameEnv || workspaceProjectionFrame}
    <EntityPanelTabs
      {tab}
      {hideHeader}
      {showJurisdiction}
      {userModeHeader}
      {selectedJurisdiction}
      {allowHeaderAddRuntime}
      {allowHeaderDeleteRuntime}
      {headerRuntimeAddLabel}
      {initialAction}
      runtimeFrameContext={frameContext}
      embeddedRuntimeContext={embeddedFrameContext}
      workspaceLens={selectedLens || 'wallet'}
      workspaceLensNavigationVersion={lensNavigationVersion}
      runtimeProjectionFrame={workspaceProjectionFrame}
      on:signerSelect
      on:addSigner
      on:entitySelect
      on:jurisdictionSelect
      on:addJurisdiction
      on:addEntity
      on:addRuntime
      on:deleteRuntime
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

  .lens-bar {
    width: 100%;
    max-width: 1220px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px 0;
  }

  .workspace-context-switcher {
    min-width: min(420px, 42vw);
    max-width: 520px;
  }

  .workspace-context-switcher :global(.context-switcher) {
    width: 100%;
  }

  .lens-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    height: 34px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 82%, transparent);
    background: color-mix(in srgb, var(--theme-card-bg, #111113) 88%, transparent);
    color: var(--theme-text-secondary, #a1a1aa);
    font-weight: 700;
    cursor: pointer;
  }

  .lens-button.active {
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 52%, transparent);
    color: var(--theme-text-primary, #f4f4f5);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 12%, var(--theme-card-bg, #111113));
  }

  .lens-button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
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
