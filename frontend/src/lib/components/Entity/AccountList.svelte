<script lang="ts">
  import type { EntityReplica } from '$lib/types/ui';
  import { createEventDispatcher } from 'svelte';
  import { getXLN, replicas, xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
  import AccountPreview from './AccountPreview.svelte';

  export let replica: EntityReplica | null;

  // View state (for new account creation only)
  const dispatch = createEventDispatcher();
  let selectedNewEntityId = '';

  // Get accounts from entity state
  // Safari requires explicit Map check before calling .entries()
  $: accounts = (replica?.state?.accounts && replica.state.accounts instanceof Map)
    ? Array.from(replica.state.accounts.entries()).map(([counterpartyId, account]) => ({
        counterpartyId,
        ...account,
      }))
    : [];


  // Safety guard for XLN functions

  // Get ALL entities in the system (excluding self) - reactive to accounts changes
  // This will recompute whenever accounts or replicas change
  $: allEntities = replica && $replicas && accounts ? getAllEntities() : [];

  function getAllEntities() {
    if (!replica || !$replicas || !$xlnFunctions) return [];

    const currentEntityId = replica.entityId;
    const existingAccountIds = new Set((replica.state?.accounts && replica.state.accounts instanceof Map) ? Array.from(replica.state.accounts.keys()) : []);

    // Get unique entities from replicas, excluding only current entity
    const entitySet = new Set<string>();
    for (const [replicaKey] of $replicas.entries()) {
      const [entityId] = replicaKey.split(':');
      if (entityId !== currentEntityId) {
        entitySet.add(entityId);
      }
    }

    return Array.from(entitySet).map(entityId => {
      // Try to get a human-readable name for the entity
      const shortId = $xlnFunctions!.getEntityShortId(entityId);
      const hasAccount = existingAccountIds.has(entityId);
      return {
        entityId,
        displayName: $xlnFunctions!.formatEntityId(entityId),
        shortId,
        hasAccount
      };
    }).sort((a, b) => {
      const aId = $xlnFunctions!.getEntityShortId(a.entityId);
      const bId = $xlnFunctions!.getEntityShortId(b.entityId);
      // Try numeric sort first
      const aNum = parseInt(aId, 10);
      const bNum = parseInt(bId, 10);
      if (!isNaN(aNum) && !isNaN(bNum) && aId === aNum.toString() && bId === bNum.toString()) {
        return aNum - bNum;
      }
      // Fall back to string sort for hash-based IDs
      return aId.localeCompare(bId);
    }); // Sort by entity ID
  }

  async function openAccountWith(targetEntityId: string) {
    if (!replica) return;

    try {
      console.log(`💳 NEW-FLOW: Opening account with Entity ${$xlnFunctions!.formatEntityId(targetEntityId)} via entity transaction`);

      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('XLN environment not ready');

      // NEW FLOW: Send account_request as EntityTx to local e-machine
      const accountRequestInput = {
        entityId: replica.entityId,
        signerId: replica.signerId,
        entityTxs: [{
          type: 'openAccount' as const,
          data: {
            targetEntityId
          }
        }]
      };

      await xln.processUntilEmpty(env, [accountRequestInput]);
      console.log(`✅ Account request sent to local e-machine for Entity ${$xlnFunctions!.formatEntityId(targetEntityId)}`);
    } catch (error) {
      console.error('Failed to send account request:', error);
      alert(`Failed to send account request: ${(error as Error)?.message || 'Unknown error'}`);
    }
  }

  function selectAccount(event: CustomEvent) {
    // Forward the selection to parent (EntityPanel) for focused navigation
    dispatch('select', event.detail);
  }



</script>

<div class="account-channels" data-testid="account-channels">
  <!-- Account List View (Always show previews, never full panel) -->
  <div class="accounts-list-view">


      {#if accounts.length === 0}
        <div class="no-accounts">
          <p>No accounts established</p>
          <small>Select an entity below to open an account</small>
        </div>
      {:else}
        <div class="scrollable-component accounts-list">
          {#each accounts as account (account.counterpartyId)}
            <AccountPreview
              account={account}
              counterpartyId={account.counterpartyId}
              entityId={replica?.entityId || ''}
              isSelected={false}
              on:select={selectAccount}
            />
          {/each}
        </div>

      <!-- Add Account Section -->
      <div class="add-account-section">
        <h5>➕ Open New Account</h5>
        <select class="entity-select" bind:value={selectedNewEntityId}>
          <option value="">Select an entity...</option>
          {#each allEntities.filter(e => !e.hasAccount) as entity}
            <option value={entity.entityId}>
              {entity.displayName} ({entity.shortId})
            </option>
          {/each}
        </select>
        <button
          class="open-account-button"
          on:click={() => {
            if (selectedNewEntityId) {
              openAccountWith(selectedNewEntityId);
              selectedNewEntityId = ''; // Reset selection after opening
            }
          }}
        >
          📝 Open Account
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .account-channels {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .accounts-list-view {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .scrollable-component {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }


  .no-accounts {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 30px 20px;
    text-align: center;
    background: rgba(108, 117, 125, 0.1);
    border: 1px solid rgba(108, 117, 125, 0.3);
    border-radius: 6px;
  }

  .empty-icon {
    font-size: 36px;
    margin-bottom: 12px;
  }

  .no-accounts p {
    margin: 0 0 8px 0;
    color: #d4d4d4;
  }

  .no-accounts small {
    color: #9d9d9d;
  }

  .accounts-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .add-account-section {
    padding: 12px;
    background: #1e1e1e;
    border-top: 1px solid #3e3e3e;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .add-account-section h5 {
    margin: 0;
    font-size: 0.9em;
    color: #007acc;
  }

  .entity-select {
    flex: 1;
    padding: 6px;
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    color: #d4d4d4;
    font-size: 0.85em;
  }

  .entity-select:focus {
    border-color: #007acc;
    outline: none;
  }

  .open-account-button {
    padding: 6px 12px;
    background: #007acc;
    border: none;
    border-radius: 4px;
    color: white;
    font-size: 0.85em;
    cursor: pointer;
    transition: background 0.2s ease;
  }

  .open-account-button:hover {
    background: #0086e6;
  }





</style>
