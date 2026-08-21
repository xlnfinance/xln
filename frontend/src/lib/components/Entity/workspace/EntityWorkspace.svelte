<script lang="ts">
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { runtimeCommandLatestReceipt } from '$lib/stores/commands/runtimeCommandBus';
  import {
    runtimeView,
    runtimeViewAccountsPage,
    runtimeViewBooksPage,
    runtimeViewFrameMatchesAtHeight,
    runtimeViewQueryAtHeight,
  } from '$lib/stores/runtimeViewStore';
  import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
  import type { RuntimeAdapterViewFrame } from '@xln/core/api/public/runtime-module';
  import { REMOTE_RUNTIME } from '@xln/core/config/constants';
  import type { Tab } from '$lib/types/ui';
  import EntityPanelTabs from './shell/EntityPanelTabs.svelte';
  import { runtimeProjectionMatchesRuntime } from '../core/entity-workspace';
  import {
    emptyEntityWorkspaceRuntimeFrameContext,
    type EntityWorkspaceRuntimeFrameContext,
  } from '../core/runtime-frame-context';
  import {
    emptyEntityWorkspaceEmbeddedRuntimeContext,
    type EntityWorkspaceEmbeddedRuntimeContext,
  } from '../core/embedded-runtime-context';

  export let tab: Tab;
  export let hideHeader: boolean = false;
  export let showJurisdiction: boolean = true;
  export let userModeHeader: boolean = false;
  export let selectedJurisdiction: string | null = null;
  export let allowHeaderAddRuntime: boolean = false;
  export let headerRuntimeAddLabel: string = '+ Add Runtime';
  import type { EntityOpenAction } from '$lib/view/utils/panelBridge';
  export let initialAction: EntityOpenAction | undefined = undefined;
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

  const projectionFrameMatchesPages = (
    frame: RuntimeAdapterViewFrame | null | undefined,
    accountsPage: number,
    booksPage: number,
  ): boolean => !!frame?.activeEntity &&
    (frame.activeEntity.accounts.pageIndex ?? 0) === accountsPage &&
    (frame.activeEntity.books.pageIndex ?? 0) === booksPage;

  const isActionableRuntimeReceipt = (status: string | null | undefined): boolean =>
    status === 'pending' || status === 'error';

  async function refreshWorkspaceProjection(
    key: string,
    entityId: string,
    atHeight: number | null,
    minimumLiveHeight: number,
    accountsPage: number,
    booksPage: number,
  ): Promise<void> {
    const requestId = ++workspaceProjectionRequestId;
    try {
      const frame = await runtimeQueryClient.readViewFrame(runtimeViewQueryAtHeight({
        ...(entityId ? { entityId } : {}),
        accountsLimit: WORKSPACE_VIEW_PAGE_SIZE,
        booksLimit: WORKSPACE_VIEW_PAGE_SIZE,
        accountsPage,
        booksPage,
      }, atHeight));
      if (requestId !== workspaceProjectionRequestId || key !== workspaceProjectionKey) return;
      if (!projectionFrameMatchesEntity(frame, entityId)) {
        throw new Error(`Entity workspace projection mismatch: expected ${entityId || 'default'}`);
      }
      if (!runtimeViewFrameMatchesAtHeight(frame, atHeight)) {
        throw new Error(`Entity workspace height mismatch: expected ${atHeight ?? 'LIVE'}, received ${frame.height}`);
      }
      const frameHeight = Math.max(0, Math.floor(Number(frame.height || 0)));
      if (atHeight === null && frameHeight < minimumLiveHeight) {
        throw new Error(`Entity workspace stale live projection: expected >= h${minimumLiveHeight}, received h${frameHeight}`);
      }
      if (!projectionFrameMatchesPages(frame, accountsPage, booksPage)) {
        throw new Error(`Entity workspace page mismatch: expected accounts=${accountsPage}, books=${booksPage}`);
      }
      workspaceProjectionFrame = frame;
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
    const selectedRuntimeId = String(handle.runtimeId || handle.id || '').trim().toLowerCase();
    const entityId = handle.mode === 'remote'
      ? (tabEntityId || runtimeActiveEntityId)
      : tabEntityId;
    const selectedAtHeight = $runtimeView.atHeight;
    const minimumLiveHeight = selectedAtHeight === null
      ? Math.max(0, Math.floor(Number(handle.height || 0)))
      : selectedAtHeight;
    const accountsPage = $runtimeViewAccountsPage;
    const booksPage = $runtimeViewBooksPage;
    // Connection state is not projection identity. Keep the last certified
    // frame mounted while the adapter reconnects so the command gate can
    // disable mutations without erasing the user's workspace.
    const nextKey = `${selectedRuntimeId}|${entityId}|h:${minimumLiveHeight}|a:${accountsPage}|b:${booksPage}`;
    if (
      runtimeProjectionMatchesRuntime($runtimeView.runtimeId, selectedRuntimeId)
      && projectionFrameMatchesEntity($runtimeView.frame, entityId)
      && runtimeViewFrameMatchesAtHeight($runtimeView.frame, selectedAtHeight)
      && (
        selectedAtHeight !== null ||
        Math.max(0, Math.floor(Number($runtimeView.frame?.height || 0))) >= minimumLiveHeight
      )
      && projectionFrameMatchesPages($runtimeView.frame, accountsPage, booksPage)
    ) {
      if (workspaceProjectionKey !== nextKey || workspaceProjectionFrame !== $runtimeView.frame) {
        // Adopting the canonical frame supersedes any detached read that is
        // still resolving for this workspace context.
        workspaceProjectionRequestId += 1;
      }
      workspaceProjectionKey = nextKey;
      workspaceProjectionFrame = $runtimeView.frame;
      workspaceProjectionError = null;
    } else if (nextKey !== workspaceProjectionKey) {
      workspaceProjectionKey = nextKey;
      workspaceProjectionFrame = null;
      workspaceProjectionError = null;
      if (handle.status === 'connected' && entityId) {
        void refreshWorkspaceProjection(nextKey, entityId, selectedAtHeight, minimumLiveHeight, accountsPage, booksPage);
      }
    }
  }

  $: frameContext = runtimeFrameContext ?? emptyEntityWorkspaceRuntimeFrameContext;
  $: embeddedFrameContext = embeddedRuntimeContext ?? emptyEntityWorkspaceEmbeddedRuntimeContext;
  $: runtimeFrameEnv = embeddedFrameContext.env;
</script>

<div class="entity-workspace" data-testid="entity-workspace">
  {#if workspaceProjectionError || isActionableRuntimeReceipt($runtimeCommandLatestReceipt?.status)}
    <div class="workspace-status">
    {#if workspaceProjectionError}
      <span
        class="permission-pill error"
        data-testid="entity-workspace-projection-error"
        title={workspaceProjectionError}
      >Projection error</span>
    {/if}
    {#if $runtimeCommandLatestReceipt && isActionableRuntimeReceipt($runtimeCommandLatestReceipt.status)}
	      <span
	        class={`command-pill ${$runtimeCommandLatestReceipt.status}`}
	        data-testid="runtime-command-receipt"
	        title={$runtimeCommandLatestReceipt.error || $runtimeCommandLatestReceipt.receiptId}
      >
        {$runtimeCommandLatestReceipt.status}
        {#if $runtimeCommandLatestReceipt.failureKind}
          · {$runtimeCommandLatestReceipt.failureKind}
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
      Runtime action surface requires a runtime frame.
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
