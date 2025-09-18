<script lang="ts">
  import { onMount } from 'svelte';
  import { getXLN, xlnEnvironment } from '../../stores/xlnStore';
  import ProfileCard from './ProfileCard.svelte';
  
  let profiles: any[] = [];
  let isLoading = true;
  let error: string | null = null;

  async function loadProfiles() {
    try {
      isLoading = true;
      error = null;
      
      const xln = await getXLN();
      const env = $xlnEnvironment;
      
      
      if (!env) {
        throw new Error('XLN environment not ready');
      }

      // Access gossip layer from environment
      const gossipProfiles = env.gossip?.getProfiles() || [];
      profiles = gossipProfiles;
      
      console.log('📡 Loaded gossip profiles:', profiles);
    } catch (err) {
      console.error('❌ Failed to load gossip profiles:', err);
      error = err instanceof Error ? err.message : 'Failed to load profiles';
      profiles = [];
    } finally {
      isLoading = false;
    }
  }

  onMount(() => {
    loadProfiles();
  });

  // Reactive reload when environment changes
  $: if ($xlnEnvironment) {
    loadProfiles();
  }

</script>

<div class="network-directory">
  <div class="directory-header">
    <h3>🌐 Network Directory</h3>
    <button class="refresh-btn" on:click={loadProfiles} disabled={isLoading}>
      {isLoading ? '🔄' : '↻'} Refresh
    </button>
  </div>

  {#if isLoading}
    <div class="loading-state">
      <div class="loading-spinner">🔄</div>
      <p>Loading network profiles...</p>
    </div>
  {:else if error}
    <div class="error-state">
      <div class="error-icon">❌</div>
      <p>Failed to load profiles: {error}</p>
      <button class="retry-btn" on:click={loadProfiles}>Retry</button>
    </div>
  {:else if profiles.length === 0}
    <div class="empty-state">
      <div class="empty-icon">📭</div>
      <p>No network profiles available</p>
      <small>Profiles will appear here when entities announce themselves to the gossip layer</small>
    </div>
  {:else}
    <div class="profiles-grid">
      {#each profiles as profile (profile.entityId)}
        <ProfileCard {profile} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .network-directory {
    padding: 20px;
    color: #d4d4d4;
  }

  .directory-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    border-bottom: 1px solid #3e3e3e;
    padding-bottom: 15px;
  }

  .directory-header h3 {
    margin: 0;
    font-size: 1.4em;
    color: #007acc;
  }

  .refresh-btn {
    background: #007acc;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    transition: background-color 0.2s ease;
  }

  .refresh-btn:hover:not(:disabled) {
    background: #0086e6;
  }

  .refresh-btn:disabled {
    background: #666;
    cursor: not-allowed;
  }

  .loading-state,
  .error-state,
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    text-align: center;
  }

  .loading-spinner {
    font-size: 24px;
    animation: spin 2s linear infinite;
    margin-bottom: 10px;
  }

  .error-icon,
  .empty-icon {
    font-size: 48px;
    margin-bottom: 15px;
  }

  .error-state {
    background: rgba(220, 53, 69, 0.1);
    border: 1px solid rgba(220, 53, 69, 0.3);
    border-radius: 8px;
    margin: 20px 0;
  }

  .empty-state {
    background: rgba(108, 117, 125, 0.1);
    border: 1px solid rgba(108, 117, 125, 0.3);
    border-radius: 8px;
    margin: 20px 0;
  }

  .retry-btn {
    background: #dc3545;
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 4px;
    cursor: pointer;
    margin-top: 10px;
  }

  .retry-btn:hover {
    background: #c82333;
  }

  .profiles-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 20px;
    margin-top: 20px;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
