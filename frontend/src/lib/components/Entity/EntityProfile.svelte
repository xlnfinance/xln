<script lang="ts">
  import type { EntityReplica, Tab } from '$lib/types/ui';
  import { xlnFunctions } from '../../stores/xlnStore';

  export let replica: EntityReplica | null;
  export let tab: Tab;

  // Safety guard for XLN functions
</script>

<div class="entity-profile-section">
  {#if replica}
    <div class="entity-profile">
      <div class="profile-avatar">
        <img
          src={$xlnFunctions.generateEntityAvatar?.(replica.entityId) || ''}
          alt="Entity Avatar"
          class="avatar-image"
        />
      </div>
      <div class="profile-info">
        <div class="profile-name">
          Entity #{$xlnFunctions.getEntityNumber(replica.entityId)}
        </div>
        <div class="profile-details">
          <img
            src={$xlnFunctions.generateSignerAvatar?.(replica.signerId) || ''}
            alt="Signer Avatar"
            class="signer-avatar"
          />
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

  .profile-avatar {
    flex-shrink: 0;
  }

  .avatar-image {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 2px solid #4a5568;
  }

  .signer-avatar {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
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
