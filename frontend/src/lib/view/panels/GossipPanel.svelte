<script lang="ts">
  /**
   * GossipPanel - Shows all gossip profiles with full metadata
   * For debugging and inspection of entity discovery
   */
  import type { Writable } from 'svelte/store';

  export let isolatedEnv: Writable<any> | undefined = undefined;
  export let isolatedHistory: Writable<any[]> | undefined = undefined;
  export let isolatedTimeIndex: Writable<number> | undefined = undefined;

  $: env = isolatedEnv ? $isolatedEnv : null;
  $: profiles = env?.gossip?.getProfiles?.() || [];

  function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }

  function formatEntityId(id: string): string {
    return id;
  }
</script>

<div class="gossip-panel">
  <div class="panel-header">
    <h2>📡 Gossip Network</h2>
    <div class="profile-count">{profiles.length} profiles</div>
  </div>

  <div class="profiles-container">
    {#if profiles.length === 0}
      <div class="empty-state">
        <div class="empty-icon">📡</div>
        <div class="empty-text">No gossip profiles yet</div>
        <div class="empty-hint">Profiles appear when entities announce to the network</div>
      </div>
    {:else}
      {#each profiles as profile (profile.entityId)}
        <div class="profile-card">
          <div class="profile-header">
            <div class="entity-id">{formatEntityId(profile.entityId)}</div>
            <div class="timestamp">{formatTimestamp(profile.timestamp)}</div>
          </div>

          <div class="profile-body">
            <!-- Name -->
            {#if profile.metadata?.name}
              <div class="field">
                <div class="field-label">Name</div>
                <div class="field-value">{profile.metadata.name}</div>
              </div>
            {/if}

            <!-- Entity Public Key -->
            {#if profile.metadata?.entityPublicKey}
              <div class="field">
                <div class="field-label">Public Key</div>
                <div class="field-value mono">{profile.metadata.entityPublicKey.slice(0, 20)}...</div>
              </div>
            {/if}

            <!-- Board -->
            {#if profile.metadata?.board}
              <div class="field">
                <div class="field-label">Board</div>
                <div class="field-value">
                  {#if Array.isArray(profile.metadata.board)}
                    {profile.metadata.board.length} validators
                  {:else}
                    {JSON.stringify(profile.metadata.board)}
                  {/if}
                </div>
              </div>
            {/if}

            <!-- Accounts -->
            <div class="field">
              <div class="field-label">Accounts</div>
              <div class="field-value">{profile.accounts} bilateral channels</div>
            </div>

            <!-- Full Metadata (expandable) -->
            <details class="metadata-details">
              <summary>Full Metadata</summary>
              <pre class="metadata-json">{JSON.stringify(profile.metadata, (key, value) =>
                typeof value === 'bigint' ? value.toString() + 'n' : value
              , 2)}</pre>
            </details>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .gossip-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #1e1e1e;
    color: rgba(255, 255, 255, 0.9);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    background: #252526;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .panel-header h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
  }

  .profile-count {
    font-size: 12px;
    color: rgba(0, 122, 255, 0.8);
    background: rgba(0, 122, 255, 0.1);
    padding: 4px 10px;
    border-radius: 12px;
  }

  .profiles-container {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
    padding: 40px;
    text-align: center;
  }

  .empty-icon {
    font-size: 48px;
    opacity: 0.2;
  }

  .empty-text {
    font-size: 16px;
    color: rgba(255, 255, 255, 0.6);
  }

  .empty-hint {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.4);
    max-width: 300px;
  }

  .profile-card {
    background: rgba(30, 30, 30, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    overflow: hidden;
    transition: border-color 0.2s;
  }

  .profile-card:hover {
    border-color: rgba(0, 122, 255, 0.3);
  }

  .profile-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }

  .entity-id {
    font-family: 'SF Mono', monospace;
    font-size: 14px;
    font-weight: 600;
    color: rgba(0, 122, 255, 0.9);
  }

  .timestamp {
    font-family: 'SF Mono', monospace;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
  }

  .profile-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: rgba(255, 255, 255, 0.5);
    font-weight: 500;
  }

  .field-value {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.9);
  }

  .field-value.mono {
    font-family: 'SF Mono', monospace;
    font-size: 12px;
  }

  .metadata-details {
    margin-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    padding-top: 12px;
  }

  .metadata-details summary {
    cursor: pointer;
    font-size: 12px;
    color: rgba(0, 122, 255, 0.8);
    user-select: none;
    padding: 4px 0;
  }

  .metadata-details summary:hover {
    color: rgba(0, 122, 255, 1);
  }

  .metadata-json {
    margin: 8px 0 0 0;
    padding: 12px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 4px;
    font-family: 'SF Mono', monospace;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    overflow-x: auto;
    max-height: 300px;
    overflow-y: auto;
  }

  .profiles-container::-webkit-scrollbar {
    width: 8px;
  }

  .profiles-container::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.2);
  }

  .profiles-container::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
    border-radius: 4px;
  }

  .metadata-json::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  .metadata-json::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
  }
</style>
