<script lang="ts">
  import type { AccountMachine, EntityReplica, Tab } from '$lib/types/ui';
  import AccountPanel from './AccountPanel.svelte';

  export let selectedAccount: AccountMachine;
  export let selectedAccountId: string;
  export let tab: Tab;
  export let replica: EntityReplica | null = null;
  export let entityNames: Map<string, string> = new Map();
  export let pendingOffchainFaucetKeys: Set<string> = new Set();
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
