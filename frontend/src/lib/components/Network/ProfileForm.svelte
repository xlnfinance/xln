<script lang="ts">
  import { getXLN, xlnEnvironment } from '../../stores/xlnStore';
  import { tabs } from '../../stores/tabStore';
  import MultiSelect from 'svelte-multiselect';

  // Callback prop for profile announcement
  let { onProfileAnnounced }: { onProfileAnnounced?: (profile: any) => void } = $props();

  let selectedCapabilities = $state<string[]>([]);
  let isHub = $state(false);
  let metadataInput = $state('');
  let isExpanded = $state(false);
  let isAnnouncing = $state(false);
  let announceError = $state<string | null>(null);

  // Hub metadata fields
  let hubName = $state('');
  let hubAvatar = $state('');
  let hubBio = $state('');
  let hubWebsite = $state('');

  // Predefined capability options
  const availableCapabilities = [
    'trading',
    'liquidity',
    'settlement',
    'custody',
    'market-making',
    'routing',
    'bridging',
    'lending',
    'borrowing',
    'staking',
    'governance',
    'analytics',
    'risk-management',
    'compliance',
  ];

  // Get current active entity
  let activeTab = $derived($tabs.find(tab => tab.isActive));
  let currentEntityId = $derived(activeTab?.entityId);
  let currentSignerId = $derived(activeTab?.signerId);

  // Profile loading state
  let isLoadingProfile = $state(false);
  let existingProfile: any = $state(null);

  function parseMetadata(input: string): any {
    if (!input.trim()) return undefined;

    try {
      return JSON.parse(input);
    } catch (err) {
      throw new Error('Invalid JSON metadata');
    }
  }

  async function announceProfile() {
    if (!currentEntityId) {
      announceError = 'No active entity selected';
      return;
    }
    
    if (!currentSignerId) {
      announceError = 'No signer available for current tab';
      return;
    }

    try {
      isAnnouncing = true;
      announceError = null;

      const capabilities = [...selectedCapabilities];

      // Add 'hub' capability if checkbox is checked
      if (isHub && !capabilities.includes('hub')) {
        capabilities.push('hub');
      }

      // Build metadata from individual fields if hub is selected, otherwise use JSON input
      const metadata = isHub
        ? {
            name: hubName,
            avatar: hubAvatar,
            bio: hubBio,
            website: hubWebsite,
          }
        : parseMetadata(metadataInput);

      const xln = await getXLN();
      const env = $xlnEnvironment;

      if (!env) {
        throw new Error('XLN environment not ready');
      }

      // Create profile update transaction for consensus layer
      const profileUpdateTx = {
        type: 'profile-update' as const,
        data: {
          profile: {
            entityId: currentEntityId,
            name: metadata?.name || '',
            avatar: metadata?.avatar || '',
            bio: metadata?.bio || '',
            website: metadata?.website || '',
            capabilities: capabilities,
            hubs: [],
            hankoSignature: '', // TODO: Add actual Hanko signature
          },
        },
      };

      // Submit transaction through consensus
      const entityInput = {
        entityId: currentEntityId,
        signerId: currentSignerId, // Use the active tab's signer
        entityTxs: [profileUpdateTx],
        timestamp: Date.now(),
        signature: '', // TODO: Add proper signature
      };

      await xln.applyRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [entityInput],
      });

      console.log('📡 Submitted profile update transaction:', profileUpdateTx);

      // Call the callback prop if provided
      onProfileAnnounced?.({
        entityId: currentEntityId,
        capabilities: capabilities,
        hubs: [],
        metadata: {
          name: metadata?.name,
          avatar: metadata?.avatar,
          bio: metadata?.bio,
          website: metadata?.website,
        },
      });

      // Clear form and collapse section after successful announcement
      selectedCapabilities = [];
      isHub = false;
      metadataInput = '';
      hubName = '';
      hubAvatar = '';
      hubBio = '';
      hubWebsite = '';
      isExpanded = false; // Collapse the profile form
    } catch (err) {
      console.error('❌ Failed to submit profile update:', err);
      announceError = err instanceof Error ? err.message : 'Failed to submit profile update';
    } finally {
      isAnnouncing = false;
    }
  }

  function toggleExpanded() {
    isExpanded = !isExpanded;
    
    // Reload existing profile when expanding
    if (isExpanded && currentEntityId) {
      loadExistingProfile(currentEntityId);
    }
  }

  // Load existing profile for current entity
  async function loadExistingProfile(entityId: string) {
    console.log("🚀 ~ loadExistingProfile ~ entityId:", entityId)
    if (!entityId) {
      existingProfile = null;
      clearForm();
      return;
    }

    try {
      isLoadingProfile = true;
      await getXLN();
      const env = $xlnEnvironment;

      if (!env || !env.gossip) {
        existingProfile = null;
        return;
      }

      // Get profiles from gossip layer
      const profiles = env.gossip.getProfiles();
      const profile = profiles.find((p: any) => p.entityId === entityId);

      if (profile) {
        existingProfile = profile;
        populateFormFromProfile(profile);
        console.log('📝 Loaded existing profile for entity:', entityId, profile);
      } else {
        existingProfile = null;
        clearForm();
        console.log('📝 No existing profile found for entity:', entityId);
      }
    } catch (err) {
      console.error('❌ Failed to load existing profile:', err);
      existingProfile = null;
    } finally {
      isLoadingProfile = false;
    }
  }

  // Populate form fields from existing profile
  function populateFormFromProfile(profile: any) {
    // Set capabilities (exclude 'hub' as it's handled separately)
    selectedCapabilities = (profile.capabilities || []).filter((cap: string) => cap !== 'hub');

    // Set hub checkbox if 'hub' capability exists
    isHub = (profile.capabilities || []).includes('hub');

    // Set metadata fields
    if (profile.metadata) {
      if (isHub) {
        // If it's a hub, populate individual fields
        hubName = profile.metadata.name || '';
        hubAvatar = profile.metadata.avatar || '';
        hubBio = profile.metadata.bio || '';
        hubWebsite = profile.metadata.website || '';
        metadataInput = ''; // Clear JSON input when hub is selected
      } else {
        // For non-hub profiles, put metadata in JSON field
        // Handle BigInt serialization
        metadataInput = JSON.stringify(profile.metadata, (_, value) => {
          if (typeof value === 'bigint') {
            return value.toString();
          }
          return value;
        }, 2);
        hubName = '';
        hubAvatar = '';
        hubBio = '';
        hubWebsite = '';
      }
    } else {
      clearMetadataFields();
    }
  }

  // Clear all form fields
  function clearForm() {
    selectedCapabilities = [];
    isHub = false;
    clearMetadataFields();
  }

  // Clear metadata fields
  function clearMetadataFields() {
    metadataInput = '';
    hubName = '';
    hubAvatar = '';
    hubBio = '';
    hubWebsite = '';
  }

  // Watch for entity changes and load profile
  $effect(() => {
    if (currentEntityId) {
      loadExistingProfile(currentEntityId);
    }
  });
</script>

<div class="profile-form-container" data-testid="profile-form">
  <div class="profile-form-header">
    <button class="toggle-btn" onclick={toggleExpanded}>
      <span class="toggle-icon">{isExpanded ? '▼' : '▶'}</span>
      <h3>👤 My Profile</h3>
    </button>
  </div>

  {#if isExpanded}
    <div class="profile-form-content">
      {#if isLoadingProfile}
        <div class="loading-indicator">
          <span class="loading-spinner">🔄</span>
          <span>Loading profile...</span>
        </div>
      {/if}

      {#if existingProfile}
        <div class="existing-profile-notice">
          <span class="notice-icon">ℹ️</span>
          <span>Editing existing profile for <strong>{existingProfile.entityId}</strong></span>
        </div>
      {/if}
      <div class="form-group">
        <div>
          <label for="capabilities-select">Capabilities:</label>
          <MultiSelect
            id="capabilities-select"
            options={availableCapabilities}
            bind:selected={selectedCapabilities}
            placeholder="Select capabilities..."
            searchable={true}
            liMaxHeight="200px"
            --sms-border="1px solid #3e3e3e"
            --sms-bg="#1e1e1e"
            --sms-text-color="#d4d4d4"
            --sms-focus-border="#007acc"
            --sms-selected-bg="#007acc"
            --sms-options-bg="#1e1e1e"
            --sms-options-text="#d4d4d4"
            --sms-options-hover-bg="rgba(255, 255, 255, 0.05)"
            data-testid="capabilities-multiselect"
          />
        </div>
      </div>

      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={isHub} class="form-checkbox" data-testid="hub-checkbox" />
          <span class="checkbox-text">🌟 Register as Hub</span>
        </label>
        <small class="form-hint">Automatically adds "hub" to your capabilities</small>
      </div>

      {#if isHub}
        <div class="hub-details-section">
          <h4 class="hub-details-header">🏢 Hub Details</h4>

          <div class="form-group">
            <label for="hub-name">Hub Name:</label>
            <input id="hub-name" type="text" bind:value={hubName} placeholder="Hub name" class="form-input" />
          </div>

          <div class="form-group">
            <label for="hub-avatar">Avatar URL:</label>
            <input id="hub-avatar" type="url" bind:value={hubAvatar} placeholder="Avatar URL" class="form-input" />
          </div>

          <div class="form-group">
            <label for="hub-bio">Description / Bio:</label>
            <textarea id="hub-bio" bind:value={hubBio} placeholder="Description / bio" class="form-textarea" rows="3"
            ></textarea>
          </div>

          <div class="form-group">
            <label for="hub-website">Website:</label>
            <input id="hub-website" type="url" bind:value={hubWebsite} placeholder="Website" class="form-input" />
          </div>
        </div>
      {/if}

      {#if !isHub}
        <div class="form-group">
          <label for="metadata">📋 Metadata (optional JSON)</label>
          <textarea
            id="metadata"
            bind:value={metadataInput}
            placeholder="Enter JSON metadata here..."
            class="form-textarea"
            rows="3"
          ></textarea>
          <small class="form-hint">Optional JSON metadata for additional information</small>
        </div>
      {/if}

      <div class="form-actions">
        <button
          class="announce-btn"
          data-testid="announce-profile-button"
          onclick={announceProfile}
          disabled={isAnnouncing || !currentEntityId || !currentSignerId}
        >
          {#if isAnnouncing}
            🔄 Announcing...
          {:else}
            📡 Announce Profile
          {/if}
        </button>

        {#if !currentEntityId}
          <small class="action-hint">Select an entity first</small>
        {:else if !currentSignerId}
          <small class="action-hint">No signer available for current tab</small>
        {/if}
      </div>

      {#if announceError}
        <div class="announce-error">❌ {announceError}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .profile-form-container {
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 8px;
    margin-bottom: 20px;
    overflow: hidden;
  }

  .profile-form-header {
    border-bottom: 1px solid #3e3e3e;
  }

  .toggle-btn {
    width: 100%;
    background: none;
    border: none;
    color: #d4d4d4;
    padding: 16px 20px;
    text-align: left;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 12px;
    transition: background-color 0.2s ease;
  }

  .toggle-btn:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .toggle-icon {
    font-size: 12px;
    color: #007acc;
    transition: transform 0.2s ease;
  }

  .toggle-btn h3 {
    margin: 0;
    font-size: 1.2em;
    color: #007acc;
    font-weight: 500;
  }

  .profile-form-content {
    padding: 20px;
  }

  .form-group {
    margin-bottom: 20px;
  }

  .form-group label {
    display: block;
    margin-bottom: 8px;
    font-weight: 500;
    color: #d4d4d4;
    font-size: 0.9em;
  }

  .form-textarea {
    width: 100%;
    background: #1e1e1e;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    padding: 10px 12px;
    color: #d4d4d4;
    font-size: 14px;
    font-family: inherit;
    transition: border-color 0.2s ease;
    box-sizing: border-box;
  }

  .form-textarea:focus {
    outline: none;
    border-color: #007acc;
  }

  .form-textarea {
    resize: vertical;
    font-family: monospace;
    font-size: 13px;
  }

  .form-input {
    width: 100%;
    background: #1e1e1e;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    padding: 10px 12px;
    color: #d4d4d4;
    font-size: 14px;
    font-family: inherit;
    transition: border-color 0.2s ease;
    box-sizing: border-box;
  }

  .form-input:focus {
    outline: none;
    border-color: #007acc;
  }

  .hub-details-section {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid #3e3e3e;
  }

  .hub-details-header {
    margin: 0 0 16px 0;
    font-size: 1.1em;
    color: #007acc;
    font-weight: 500;
  }

  .checkbox-label {
    display: flex !important;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    margin-bottom: 0 !important;
  }

  .form-checkbox {
    width: auto !important;
    margin: 0;
  }

  .checkbox-text {
    font-size: 0.9em;
    color: #d4d4d4;
  }

  .form-hint {
    display: block;
    margin-top: 4px;
    font-size: 0.8em;
    color: #9d9d9d;
    line-height: 1.3;
  }

  .form-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .announce-btn {
    background: #007acc;
    color: white;
    border: none;
    padding: 12px 20px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 1em;
    font-weight: 500;
    transition: background-color 0.2s ease;
    align-self: flex-start;
  }

  .announce-btn:hover:not(:disabled) {
    background: #0086e6;
  }

  .announce-btn:disabled {
    background: #666;
    cursor: not-allowed;
  }

  .action-hint {
    color: #9d9d9d;
    font-size: 0.8em;
  }

  .announce-error {
    padding: 12px;
    background: rgba(220, 53, 69, 0.1);
    border: 1px solid rgba(220, 53, 69, 0.3);
    border-radius: 4px;
    color: #dc3545;
    font-size: 0.9em;
    margin-top: 12px;
  }

  .loading-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    background: rgba(0, 122, 204, 0.1);
    border: 1px solid rgba(0, 122, 204, 0.3);
    border-radius: 4px;
    color: #007acc;
    font-size: 0.9em;
    margin-bottom: 16px;
  }

  .loading-spinner {
    animation: spin 1s linear infinite;
  }

  .existing-profile-notice {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    background: rgba(40, 167, 69, 0.1);
    border: 1px solid rgba(40, 167, 69, 0.3);
    border-radius: 4px;
    color: #28a745;
    font-size: 0.9em;
    margin-bottom: 16px;
  }

  .notice-icon {
    font-size: 16px;
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
