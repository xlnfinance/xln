<script lang="ts">
  import type { EntityReplica, Tab } from '../../types';
  
  export let replica: EntityReplica | null;
  export let tab: Tab;
</script>

<div class="entity-profile-section">
  {#if replica}
    <div class="entity-profile">
      <div class="profile-info">
        <div class="profile-name">
          Entity {replica.entityId.slice(-4)}
        </div>
        <div class="profile-details">
          Signer: {replica.signerId}
        </div>
      </div>
    </div>
  {:else}
    <div class="empty-state">- select entity to view profile</div>
  {/if}
</div>

<style>
  .entity-profile-section {
    background: #1e1e1e;
    border: 1px solid #3e3e3e;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
    min-height: 80px;
  }

  .entity-profile {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .profile-info {
    flex: 1;
  }

  .profile-name {
    font-size: 1.1em;
    font-weight: bold;
    color: #ffffff;
    margin-bottom: 4px;
  }

  .profile-details {
    font-size: 0.85em;
    color: #cccccc;
    line-height: 1.4;
  }

  .empty-state {
    text-align: center;
    color: #666;
    font-style: italic;
    padding: 20px;
    font-size: 0.9em;
  }
</style>
