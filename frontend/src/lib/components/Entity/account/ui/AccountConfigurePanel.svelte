<script lang="ts">
import type { EntityReadView } from '#lib/components/Entity/core/entity-panel-types.ts';

  import type { RuntimeReplica, Profile as GossipProfile, RuntimeInput } from '@xln/core/api/public/runtime-module';
  import { runtimeControllerHandle } from '#lib/stores/runtimeControllerStore.ts';
  import type { Tab } from '#lib/types/ui.ts';
  import CollateralForm from './CollateralForm.svelte';
  import ConfigureAccountSelector from './ConfigureAccountSelector.svelte';
  import ConfigureWorkspaceTabs from '../../workspace/shell/ConfigureWorkspaceTabs.svelte';
  import CreditForm from './CreditForm.svelte';
  import LiveRequiredState from '../../workspace/shell/LiveRequiredState.svelte';
  import LoadTestingController from './load-testing/LoadTestingController.svelte';
  import type { ConfigureWorkspaceTab } from '../../workspace/entity-panel-routing';
  import type { PaymentPanelView } from '../../payments/payment-panel-view';
  import type { SwapPanelRuntimeView } from '../../swap/swap-panel-helpers';

  type ConfigureTokenOption = {
    id: number;
    symbol: string;
  };

  export let replica: EntityReadView | null = null;
  export let tab: Tab;
  export let activeIsLive = false;
  export let liveRuntimeEnv: RuntimeReplica | null = null;
  export let workspaceAccountId = '';
  export let workspaceAccountIds: string[] = [];
  export let entityNames: Map<string, string> = new Map();
  export let profileByEntityId: Map<string, GossipProfile> = new Map();
  export let configureWorkspaceTab: ConfigureWorkspaceTab = 'extend-credit';
  export let configureTokenId = 1;
  export let configureTokenOptions: ConfigureTokenOption[] = [];
  export let handleWorkspaceAccountChange: (event: CustomEvent<{ value?: string }>) => void;
  export let selectConfigureTab: (tab: ConfigureWorkspaceTab) => void;
  export let queueDisputeFinalize: (counterpartyEntityId: string, reason: string) => void | Promise<void>;
  export let queueDisputePrepare: (counterpartyEntityId: string, reason: string) => void | Promise<void>;
  export let addTokenToAccount: () => void | Promise<void>;
  export let submitRuntimeInput: ((input: RuntimeInput) => Promise<unknown> | unknown) | null = null;
  export let paymentView: PaymentPanelView;
  export let swapRuntimeView: SwapPanelRuntimeView | null = null;

  $: configureAccount = replica?.state?.accounts?.get?.(workspaceAccountId);
  $: dispute = configureAccount?.activeDispute;
  $: signedDisputeConfig = configureAccount && configureAccount.currentFrame.height > 0 ? configureAccount.state.disputeConfig : null;
  $: viewerIsLeft = configureAccount?.state.leftEntity === (replica?.state.entityId || tab.entityId);
  const responseDuration = (seconds: number): string => seconds > 0 && seconds % 3600 === 0
    ? `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`
    : `${seconds} seconds`;
  $: finalizationReady = Boolean(dispute?.observedOnChain && dispute.disputeTimeout > 0 && Number(replica?.state.timestamp ?? 0) >= dispute.disputeTimeout * 1000 && !dispute.finalizeQueued);
  $: profiles = Array.from(profileByEntityId.values());
  $: remoteAdminReady = $runtimeControllerHandle.mode === 'remote' && $runtimeControllerHandle.authLevel === 'admin';
  $: commandReady = activeIsLive && Boolean(liveRuntimeEnv || remoteAdminReady);
  $: commandUnavailableMessage = activeIsLive
    ? 'Account actions require embedded runtime RuntimeReplica or admin remote runtime.'
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
      accountOverride={configureAccount ?? null}
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
      accountOverride={configureAccount ?? null}
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
  {:else if configureWorkspaceTab === 'load-testing'}
    <LoadTestingController
      entityId={replica?.state?.entityId || tab.entityId}
      {workspaceAccountId}
      {replica}
      {liveRuntimeEnv}
      {activeIsLive}
      {paymentView}
      {swapRuntimeView}
      {submitRuntimeInput}
    />
  {:else if configureWorkspaceTab === 'dispute'}
    <div class="configure-token-card danger-card">
      <h4 class="section-head">Dispute Account</h4>
      <p class="muted">
        One action freezes local account traffic, removes orderbook exposure, and automatically drafts the on-chain dispute when evidence is stable.
      </p>
      {#if configureAccount?.status === 'disputed' && !dispute}
        <p class="muted" data-testid="configure-dispute-closed">Dispute finalized. This account is permanently closed. The settlement returned funds to your reserve.</p>
      {:else if configureAccount?.activeDispute}
        <p class="danger-note">
          Active dispute in progress. {dispute?.disputeTimeout ? `Challenge window closes ${new Date(dispute.disputeTimeout * 1000).toLocaleString()}.` : 'Waiting for on-chain confirmation.'}
        </p>
        <p class="muted">While this wallet is unlocked and online, it automatically submits finalization after the challenge window. If it locks, unlock it to resume. The chain releases the winning balance to your reserve; gas is required.</p>
        <button
          class="btn-danger-batch"
          data-testid="configure-dispute-finalize"
          on:click={() => queueDisputeFinalize(workspaceAccountId, 'dispute-finalize-from-configure')}
          disabled={!activeIsLive || !finalizationReady}
        >
          {dispute?.finalizeQueued ? 'Finalization queued' : !finalizationReady ? 'Waiting for challenge window' : 'Queue finalization'}
        </button>
      {:else if configureAccount?.status === 'dispute_preparing'}
        <p class="danger-note">
          Preparing automatically. Normal account traffic is frozen; Dispute Start will appear in the batch after every orderbook removal is confirmed.
        </p>
      {:else}
        <p class="danger-note">
          This removes orders and stops normal account traffic before committing the on-chain dispute hash. The account will close permanently.
        </p>
        {#if signedDisputeConfig}
          <p class="muted" data-testid="configure-dispute-window"
            data-total-seconds={signedDisputeConfig.leftResponseSeconds + signedDisputeConfig.rightResponseSeconds}>
            Signed response windows: you have {responseDuration(viewerIsLeft ? signedDisputeConfig.leftResponseSeconds : signedDisputeConfig.rightResponseSeconds)};
            the counterparty has {responseDuration(viewerIsLeft ? signedDisputeConfig.rightResponseSeconds : signedDisputeConfig.leftResponseSeconds)}.
            The total challenge period is {responseDuration(signedDisputeConfig.leftResponseSeconds + signedDisputeConfig.rightResponseSeconds)} from the confirmed on-chain start.
            Batch confirmation and finalization take additional time and gas. Keep this wallet unlocked and online to finalize.
          </p>
        {:else}
          <p class="muted" data-testid="configure-dispute-window">Signed response windows are unavailable. Wait for the signed account state before reviewing the deadline.</p>
        {/if}
        <p class="muted">Finalization releases the winning collateral to your reserve. It cannot guarantee repayment of unsecured promises.</p>
        <button
          class="btn-danger-batch"
          data-testid="configure-dispute-prepare"
          on:click={() => queueDisputePrepare(
            workspaceAccountId,
            'dispute-prepare-from-configure',
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
