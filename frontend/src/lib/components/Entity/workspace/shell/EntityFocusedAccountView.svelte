<script lang="ts">
import type { AccountReadView, EntityReadView } from '#lib/components/Entity/core/entity-panel-types.ts';

  import type { Tab } from '#lib/types/ui.ts';
  import AccountPanel from '../../account/ui/AccountPanel.svelte';

  export let selectedAccount: AccountReadView;
  export let selectedAccountId: string;
  export let tab: Tab;
  export let replica: EntityReadView | null = null;
  export let entityNames: Map<string, string> = new Map();
  export let pendingOffchainFaucetKeys: Set<string> = new Set();
  export let commandsReady = false;
  export let handleBackToAccounts: () => void = () => {};
  export let handleAccountFaucet: (event: CustomEvent<{ counterpartyId: string; tokenId: number }>) => void = () => {};
  export let handleAccountPanelGoToOpenAccounts: () => void = () => {};
</script>

<div class="focused-view">
  {#key selectedAccountId}
    <AccountPanel
      account={selectedAccount}
      counterpartyId={selectedAccountId}
      entityId={tab.entityId}
      {replica}
      {entityNames}
      {commandsReady}
      pendingFaucetKeys={pendingOffchainFaucetKeys}
      on:back={handleBackToAccounts}
      on:faucet={handleAccountFaucet}
      on:goToOpenAccounts={handleAccountPanelGoToOpenAccounts}
    />
  {/key}
</div>

<style>
  .focused-view {
    min-height: 0;
  }
</style>
