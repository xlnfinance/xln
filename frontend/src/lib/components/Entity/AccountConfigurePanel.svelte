<script lang="ts">
  import type { Env, Profile as GossipProfile, RuntimeInput } from '@xln/runtime/xln-api';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import type { EntityReplica, Tab } from '$lib/types/ui';
  import CollateralForm from './CollateralForm.svelte';
  import ConfigureAccountSelector from './ConfigureAccountSelector.svelte';
  import ConfigureWorkspaceTabs from './ConfigureWorkspaceTabs.svelte';
  import CreditForm from './CreditForm.svelte';
  import LiveRequiredState from './LiveRequiredState.svelte';
  import type { ConfigureWorkspaceTab } from './entity-panel-routing';

  type ConfigureTokenOption = {
    id: number;
    symbol: string;
  };

  type CrossJTargetDisputeRisk = {
    amount: bigint;
    tokenId: number;
  };

  export let replica: EntityReplica | null = null;
  export let tab: Tab;
  export let activeIsLive = false;
  export let liveRuntimeEnv: Env | null = null;
  export let workspaceAccountId = '';
  export let workspaceAccountIds: string[] = [];
  export let entityNames: Map<string, string> = new Map();
  export let profileByEntityId: Map<string, GossipProfile> = new Map();
  export let configureWorkspaceTab: ConfigureWorkspaceTab = 'extend-credit';
  export let configureTokenId = 1;
  export let configureTokenOptions: ConfigureTokenOption[] = [];
  export let unsafeCrossJTargetDisputeAccepted = false;
  export let handleWorkspaceAccountChange: (event: CustomEvent<{ value?: string }>) => void;
  export let selectConfigureTab: (tab: ConfigureWorkspaceTab) => void;
  export let getCrossJTargetDisputeRisk: (counterpartyEntityId: string) => CrossJTargetDisputeRisk | null;
  export let formatCrossJTargetDisputeRisk: (risk: CrossJTargetDisputeRisk) => string;
  export let confirmAndQueueDisputeFinalize: (counterpartyEntityId: string, reason: string) => void | Promise<void>;
  export let confirmAndQueueDisputePrepare: (counterpartyEntityId: string, reason: string, options?: Record<string, unknown>) => void | Promise<void>;
  export let addTokenToAccount: () => void | Promise<void>;
  export let submitRuntimeInput: ((input: RuntimeInput) => Promise<unknown> | unknown) | null = null;

  $: configureAccount = replica?.state?.accounts?.get?.(workspaceAccountId);
  $: crossJTargetRisk = getCrossJTargetDisputeRisk(workspaceAccountId);
  $: profiles = Array.from(profileByEntityId.values());
  $: remoteAdminReady = $runtimeControllerHandle.mode === 'remote' && $runtimeControllerHandle.authLevel === 'admin';
  $: commandReady = activeIsLive && Boolean(liveRuntimeEnv || remoteAdminReady);
  $: commandUnavailableMessage = activeIsLive
    ? 'Account actions require embedded runtime Env or admin remote runtime.'
    : 'Account actions are only available in LIVE mode.';
</script>

<div class="configure-panel">
  <ConfigureAccountSelector
    value={workspaceAccountId}
    accountIds={workspaceAccountIds}
    {profiles}
    excludeId={replica?.state?.entityId || tab.entityId}
    disabled={!activeIsLive || workspaceAccountIds.length === 0}
    on:change={handleWorkspaceAccountChange}
  />
  <ConfigureWorkspaceTabs
    activeTab={configureWorkspaceTab}
    selectTab={selectConfigureTab}
  />

  {#if !workspaceAccountId}
    <LiveRequiredState message="Select workspace account above first." />
  {:else if !commandReady}
    <LiveRequiredState message={commandUnavailableMessage} />
  {:else if configureWorkspaceTab === 'extend-credit'}
    <CreditForm
      entityId={replica?.state?.entityId || tab.entityId}
      actionRuntimeEnv={liveRuntimeEnv}
      isLive={activeIsLive}
      signerId={tab.signerId || null}
      counterpartyId={workspaceAccountId}
      accountIds={workspaceAccountIds}
      {entityNames}
      mode="extend"
      {submitRuntimeInput}
    />
  {:else if configureWorkspaceTab === 'request-credit'}
    <CreditForm
      entityId={replica?.state?.entityId || tab.entityId}
      actionRuntimeEnv={liveRuntimeEnv}
      isLive={activeIsLive}
      signerId={tab.signerId || null}
      counterpartyId={workspaceAccountId}
      accountIds={workspaceAccountIds}
      {entityNames}
      mode="request"
      {submitRuntimeInput}
    />
  {:else if configureWorkspaceTab === 'collateral'}
    <CollateralForm
      entityId={replica?.state?.entityId || tab.entityId}
      actionRuntimeEnv={liveRuntimeEnv}
      isLive={activeIsLive}
      signerId={tab.signerId || null}
      counterpartyId={workspaceAccountId}
      accountIds={workspaceAccountIds}
      {entityNames}
      accountOverride={configureAccount ?? null}
      {submitRuntimeInput}
    />
  {:else if configureWorkspaceTab === 'dispute'}
    <div class="configure-token-card danger-card">
      <h4 class="section-head">Dispute Account</h4>
      <p class="muted">
        One action freezes local account traffic, removes orderbook exposure, and automatically drafts the on-chain dispute when evidence is stable.
      </p>
      {#if configureAccount?.activeDispute}
        <p class="danger-note">
          Active dispute in progress. Finalize only after the timeout passes on-chain.
        </p>
        <button
          class="btn-danger-batch"
          data-testid="configure-dispute-finalize"
          on:click={() => confirmAndQueueDisputeFinalize(workspaceAccountId, 'dispute-finalize-from-configure')}
          disabled={!activeIsLive}
        >
          Add Dispute Finalize To Batch
        </button>
      {:else if configureAccount?.status === 'dispute_preparing'}
        <p class="danger-note">
          Preparing automatically. Normal account traffic is frozen; Dispute Start will appear in the batch after every orderbook removal is confirmed.
        </p>
      {:else}
        <p class="danger-note">
          This removes orders and stops normal account traffic before committing the on-chain dispute hash.
        </p>
        {#if crossJTargetRisk}
          <label class="danger-confirm-row">
            <input
              type="checkbox"
              bind:checked={unsafeCrossJTargetDisputeAccepted}
            />
            <span>
              I accept possible cross-jurisdiction loss up to {formatCrossJTargetDisputeRisk(crossJTargetRisk)}
              if the hub pulls source funds before the target account has pull arguments.
            </span>
          </label>
        {/if}
        <button
          class="btn-danger-batch"
          data-testid="configure-dispute-prepare"
          on:click={() => confirmAndQueueDisputePrepare(
            workspaceAccountId,
            'dispute-prepare-from-configure',
            crossJTargetRisk
              ? {
                  allowUnsafeCrossJTargetDispute: unsafeCrossJTargetDisputeAccepted,
                  acceptedCrossJTargetLossAmount: unsafeCrossJTargetDisputeAccepted
                    ? crossJTargetRisk.amount
                    : 0n,
                }
              : {},
          )}
          disabled={!activeIsLive}
        >
          Prepare & Queue Dispute
        </button>
      {/if}
    </div>
  {:else}
    <div class="configure-token-card">
      <h4 class="section-head">Add Token To Account</h4>
      <p class="muted">
        Adds token delta to selected account (zero credit). Use Extend Credit next to set limit.
      </p>
      <div class="configure-token-row">
        <select class="configure-token-select" bind:value={configureTokenId}>
          {#each configureTokenOptions as token}
            <option value={token.id}>{token.symbol}</option>
          {/each}
        </select>
        <button
          class="btn-add-token"
          data-testid="configure-token-add"
          on:click={addTokenToAccount}
          disabled={!activeIsLive || !workspaceAccountId}
        >
          Add Token
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .configure-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .configure-token-card {
    padding: 14px;
    border-radius: 10px;
    border: 1px solid #27272a;
    background: #101114;
  }

  .danger-card {
    border-color: rgba(244, 63, 94, 0.38);
    background: rgba(127, 29, 29, 0.12);
  }

  .danger-note {
    color: #fecaca;
    font-size: 12px;
    line-height: 1.45;
  }

  .danger-confirm-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 10px 0 14px;
    font-size: 12px;
    line-height: 1.4;
    color: #fee2e2;
  }

  .danger-confirm-row input {
    margin-top: 2px;
    flex: 0 0 auto;
  }

  .configure-token-row {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }

  .configure-token-select {
    min-height: 40px;
    min-width: 140px;
    padding: 0 10px;
    border: 1px solid #2f333b;
    border-radius: 10px;
    background: #111315;
    color: #f5f5f5;
  }

  .btn-add-token,
  .btn-danger-batch {
    min-height: 40px;
    padding: 0 13px;
    border-radius: 10px;
    border: 1px solid rgba(251, 191, 36, 0.28);
    background: rgba(251, 191, 36, 0.14);
    color: #fde68a;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }

  .btn-danger-batch {
    border-color: rgba(248, 113, 113, 0.32);
    background: rgba(127, 29, 29, 0.28);
    color: #fecaca;
  }

  .btn-add-token:disabled,
  .btn-danger-batch:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .section-head {
    margin: 0 0 12px;
    color: #f5f5f5;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.01em;
  }

  .muted {
    color: #52525b;
    line-height: 1.5;
    margin: 0 0 12px;
  }
</style>
