<script lang="ts">
  import { getXLN, xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
  import { tabs } from '../../stores/tabStore';

  export let profile: any;

  let isJoining = false;
  let joinError: string | null = null;

  // Use central safeStringify from xlnFunctions
  $: safeStringify = $xlnFunctions.safeStringify;

  // Check if this profile is a hub/router
  $: isHub = (profile.capabilities?.includes('hub') || profile.capabilities?.includes('router')) ?? false;

  // Get current active entity and signer
  $: activeTab = $tabs.find(tab => tab.isActive);
  $: currentEntityId = activeTab?.entityId;
  $: currentSignerId = activeTab?.signerId;

  // Check if already joined this hub (has channel)
  $: hasExistingChannel = (() => {
    if (!currentEntityId || !$xlnEnvironment) return false;
    
    // Find current entity's replica
    const replicaKey = `${currentEntityId}:${currentSignerId}`;
    const replica = $xlnEnvironment.eReplicas?.get(replicaKey);
    
    if (!replica?.state?.accounts) return false;

    // Check if there's an account with this hub
    return replica.state.accounts.has(profile.entityId);
  })();

  async function joinHub(targetEntityId: string = profile.entityId) {
    if (!currentEntityId || !currentSignerId) {
      joinError = 'No active entity/signer selected';
      return;
    }

    if (!targetEntityId) {
      joinError = 'Invalid target entityId';
      return;
    }

    // Prevent self-joins
    if (currentEntityId === targetEntityId) {
      joinError = 'Cannot join own hub';
      return;
    }

    // Validate hub capability
    if (!isHub) {
      joinError = 'Target is not a hub';
      return;
    }

    try {
      isJoining = true;
      joinError = null;

      console.log(`🚀 Joining hub: ${currentEntityId} → ${targetEntityId}`);

      const xln = await getXLN();
      const env = $xlnEnvironment;

      if (!env) {
        throw new Error('XLN environment not ready');
      }

      // Send accountInput transaction through runtime ingress queue
      xln.enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [
          {
            entityId: currentEntityId,
            signerId: currentSignerId,
            entityTxs: [
              {
                type: 'accountInput',
                data: {
                  fromEntityId: currentEntityId,
                  toEntityId: targetEntityId,
                  metadata: {
                    purpose: 'hub_connection',
                    description: `Joining hub ${targetEntityId}`,
                  },
                },
              },
            ],
          },
        ],
      });

      console.log(`✅ Successfully sent join request to ${targetEntityId}`);
    } catch (err) {
      console.error('❌ Failed to join hub:', err);
      joinError = err instanceof Error ? err.message : 'Failed to join hub';
    } finally {
      isJoining = false;
    }
  }
</script>

<div class="profile-card" data-testid="profile-card">
  <div class="profile-header">
    <div class="entity-id">
      <strong
        >🏢 {isHub ? profile.metadata?.name || `Hub ${$xlnFunctions!.formatEntityId(profile.entityId)}` : `Entity ${$xlnFunctions!.formatEntityId(profile.entityId)}`}</strong
      >
    </div>
    {#if isHub}
      <div class="hub-badge">🌟 Hub</div>
    {/if}
  </div>

  <div class="profile-content">
    {#if profile.capabilities && profile.capabilities.length > 0}
      <div class="capabilities-section">
        <h4>🔧 Capabilities</h4>
        <div class="capabilities-list">
          {#each profile.capabilities as capability}
            <span class="capability-tag">{capability}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if profile.hubs && profile.hubs.length > 0}
      <div class="hubs-section">
        <h4>🔗 Connected Hubs</h4>
        <div class="hubs-list">
          {#each profile.hubs as hub}
            <span class="hub-tag">{hub}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if profile.metadata}
      <div class="metadata-section">
        <h4>📋 Metadata</h4>
        <div class="metadata-content">
          {#each Object.entries(profile.metadata) as [key, value]}
            <div class="metadata-item">
              <span class="metadata-key">{key}:</span>
              <span class="metadata-value">{safeStringify(value)}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <div class="profile-actions">
    {#if profile.entityId === currentEntityId}
      <span class="text-muted your-hub">Your Hub</span>
    {:else if isHub}
      {#if hasExistingChannel}
        <span class="text-muted already-joined">✅ Already joined this hub</span>
      {:else}
        <button
          class="join-hub-btn"
          data-testid="join-hub-button"
          on:click={() => joinHub(profile.entityId)}
          disabled={isJoining || !currentEntityId || !currentSignerId}
        >
          {#if isJoining}
            🔄 Joining...
          {:else}
            🤝 Join Hub
          {/if}
        </button>

        {#if !currentEntityId || !currentSignerId}
          <small class="action-hint">Select an entity first</small>
        {/if}
      {/if}
    {/if}

    {#if joinError}
      <div class="join-error">❌ {joinError}</div>
    {/if}
  </div>
</div>

<style>
  .profile-card {
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 8px;
    padding: 16px;
    transition: all 0.2s ease;
  }

  .profile-card:hover {
    border-color: #007acc;
    box-shadow: 0 2px 8px rgba(0, 122, 204, 0.1);
  }

  .profile-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid #3e3e3e;
  }

  .entity-id {
    font-size: 1.1em;
    color: #007acc;
  }

  .hub-badge {
    background: #28a745;
    color: white;
    padding: 4px 8px;
    border-radius: 12px;
    font-size: 0.8em;
    font-weight: 500;
  }

  .profile-content h4 {
    margin: 0 0 8px 0;
    font-size: 0.9em;
    color: #9d9d9d;
    font-weight: 500;
  }

  .capabilities-section,
  .hubs-section,
  .metadata-section {
    margin-bottom: 16px;
  }

  .capabilities-list,
  .hubs-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .capability-tag,
  .hub-tag {
    background: #007acc;
    color: white;
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 0.8em;
  }

  .hub-tag {
    background: #6f42c1;
  }

  .metadata-content {
    font-size: 0.85em;
  }

  .metadata-item {
    margin-bottom: 4px;
  }

  .metadata-key {
    color: #9d9d9d;
    margin-right: 8px;
  }

  .metadata-value {
    color: #d4d4d4;
    font-family: monospace;
  }

  .profile-actions {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid #3e3e3e;
  }

  .join-hub-btn {
    background: #28a745;
    color: white;
    border: none;
    padding: 10px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 500;
    transition: background-color 0.2s ease;
    width: 100%;
  }

  .join-hub-btn:hover:not(:disabled) {
    background: #218838;
  }

  .join-hub-btn:disabled {
    background: #6c757d;
    cursor: not-allowed;
  }

  .action-hint {
    display: block;
    margin-top: 8px;
    color: #9d9d9d;
    font-size: 0.8em;
    text-align: center;
  }

  .join-error {
    margin-top: 8px;
    padding: 8px;
    background: rgba(220, 53, 69, 0.1);
    border: 1px solid rgba(220, 53, 69, 0.3);
    border-radius: 4px;
    color: #dc3545;
    font-size: 0.85em;
  }

  .text-muted {
    text-align: center;
    color: #9d9d9d;
    font-size: 0.9em;
    padding: 10px;
  }

  .your-hub {
    display: block;
  }

  .already-joined {
    display: block;
    color: #28a745;
    background: rgba(40, 167, 69, 0.1);
    border: 1px solid rgba(40, 167, 69, 0.3);
    border-radius: 4px;
    padding: 8px 12px;
  }
</style>
