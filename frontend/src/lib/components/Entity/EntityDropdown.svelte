<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { replicas, xlnFunctions } from '../../stores/xlnStore';
  import { visibleReplicas } from '../../stores/timeStore';
  import { settings } from '../../stores/settingsStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import type { Tab } from '$lib/types/ui';

  export let tab: Tab;

  const dispatch = createEventDispatcher();

  let isOpen = false;
  let dropdownContent: HTMLDivElement;

  // Get environment from context (for /view route) or use global stores (for / route)
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;

  // Extract the stores from entityEnv (or use global stores as fallback)
  const contextReplicas = entityEnv?.eReplicas;
  const contextXlnFunctions = entityEnv?.xlnFunctions;

  // Use context stores if available, otherwise fall back to global
  $: activeReplicas = contextReplicas ? $contextReplicas : ($visibleReplicas || $replicas);
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;

  // Helper: Get entity name from gossip/profile
  function getEntityName(replica: any): string {
    // Try gossip profiles first
    const envData = entityEnv?.env ? (entityEnv.env as any) : null;
    if (envData?.gossip) {
      const profiles = typeof envData.gossip.getProfiles === 'function' ? envData.gossip.getProfiles() : (envData.gossip.profiles || []);
      const profile = profiles.find((p: any) => p.entityId === replica.entityId);
      if (profile?.metadata?.name) {
        return profile.metadata.name;
      }
    }
    // Fallback to replica state
    return replica.state?.name || '';
  }

  // Get dropdown display text - explicitly track ALL dependencies
  $: dropdownText = getDropdownText(tab, activeReplicas, activeXlnFunctions);

  function getDropdownText(tab: Tab, replicas: any, xlnFuncs: any): string {
    if (tab.entityId && xlnFuncs && replicas) {
      // Find replica to get name
      const replicaKey = `${tab.entityId}:${tab.signerId}`;
      const replica = replicas.get(replicaKey);
      const entityNum = xlnFuncs.getEntityShortId(tab.entityId);

      if (replica) {
        const name = getEntityName(replica);
        return name ? `${name} (#${entityNum})` : `Entity #${entityNum}`;
      }
      return `Entity #${entityNum}`;
    }
    return 'Select Entity';
  }

  function toggleDropdown() {
    isOpen = !isOpen;
    if (isOpen) {
      populateDropdown();
    }
  }

  function populateDropdown() {
    if (!dropdownContent) return;

    dropdownContent.innerHTML = `
      <div class="dropdown-search-container">
        <input type="text" class="dropdown-search-input" placeholder="🔍 Search jurisdictions, signers, entities..." />
      </div>
      <div class="dropdown-results" id="dropdownResults">
        <!-- Results will be populated here -->
      </div>
    `;

    const searchInput = dropdownContent.querySelector('.dropdown-search-input') as HTMLInputElement;
    const resultsContainer = dropdownContent.querySelector('.dropdown-results') as HTMLDivElement;

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        updateDropdownResults(resultsContainer, target.value);
      });

      searchInput.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    updateDropdownResults(resultsContainer, '');
  }

  function updateDropdownResults(resultsContainer: HTMLDivElement, _searchTerm: string) {
    if (!resultsContainer) return;
    if (!activeXlnFunctions) {
      resultsContainer.innerHTML = '<div class="dropdown-item">Loading XLN functions...</div>';
      return;
    }

    resultsContainer.innerHTML = '';

    console.log(`🔍 EntityDropdown: Total replicas available: ${activeReplicas?.size || 0}`);
    console.log(`🔍 EntityDropdown: Replica keys:`, Array.from(activeReplicas?.keys() || []));

    // For now, show all entities regardless of jurisdiction
    // TODO: Later we can filter by jurisdiction ID when we have multiple networks
    const jurisdictions = [
      { name: '', id: 'all' }
    ];

    const dropdownMode = $settings.dropdownMode;

    if (dropdownMode === 'signer-first') {
      renderSignerFirstDropdown(jurisdictions, resultsContainer, _searchTerm);
    } else {
      renderEntityFirstDropdown(jurisdictions, resultsContainer, _searchTerm);
    }
  }

  function renderSignerFirstDropdown(jurisdictions: any[], resultsContainer: HTMLDivElement, _searchTerm: string) {
    jurisdictions.forEach((jurisdiction) => {
      // Get all replicas (no jurisdiction filtering for now)
      const replicasArray = Array.from(activeReplicas?.values() || []);

      if (replicasArray.length === 0) return;

      // Group replicas by signer
      const signerGroups: { [key: string]: any[] } = {};
      replicasArray.forEach((replica: any) => {
        const signerId = replica.signerId;
        if (!signerGroups[signerId]) {
          signerGroups[signerId] = [];
        }
        signerGroups[signerId].push(replica);
      });

      // Skip jurisdiction header for cleaner UX - go straight to signers

      // Add signers and their entities
      const signerKeys = Object.keys(signerGroups);
      signerKeys.forEach((signerId, sIndex) => {
        const signerEntities = signerGroups[signerId];
        const isLastSigner = sIndex === signerKeys.length - 1;

        // Add signer
        const signerItem = createDropdownTreeItem(
          `👤 ${signerId}`,
          '',
          1,
          false,
          isLastSigner,
          _searchTerm
        );
        resultsContainer.appendChild(signerItem);

        // Add entities for this signer
        signerEntities?.forEach((replica, eIndex) => {
          const isLastEntity = eIndex === (signerEntities?.length || 0) - 1;
          if (!activeXlnFunctions) return; // Safety guard
          const entityNum = activeXlnFunctions.getEntityShortId(replica.entityId);
          const name = getEntityName(replica);
          const entityDisplay = name ? `${name} (#${entityNum})` : `Entity #${entityNum}`;

          const entityItem = createDropdownTreeItem(
            entityDisplay,
            `${jurisdiction.name}:${signerId}:${replica.entityId}`,
            2,
            true,
            isLastEntity && isLastSigner,
            _searchTerm
          );

          // Add identicon before text
          if ((activeXlnFunctions as any)?.generateEntityAvatar) {
            const avatarUrl = (activeXlnFunctions as any).generateEntityAvatar(replica.entityId);
            const img = document.createElement('img');
            img.src = avatarUrl;
            img.className = 'entity-avatar';
            img.style.cssText = 'width: 20px; height: 20px; border-radius: 4px; margin-right: 8px; vertical-align: middle;';
            entityItem.querySelector('.item-label')?.prepend(img);
          }

          entityItem.addEventListener('click', () => selectEntity(jurisdiction.name, signerId, replica.entityId));
          resultsContainer.appendChild(entityItem);
        });
      });
    });
  }

  function renderEntityFirstDropdown(jurisdictions: any[], resultsContainer: HTMLDivElement, _searchTerm: string) {
    jurisdictions.forEach((jurisdiction) => {
      // Get all replicas (use time-aware replicas, no jurisdiction filtering)
      const replicasArray = Array.from(activeReplicas?.values() || []);

      console.log(`🔍 EntityDropdown: ${jurisdiction.name} has ${replicasArray.length} replicas`);
      replicasArray.forEach((replica: any) => {
        if (!activeXlnFunctions) return; // Safety guard
        console.log(`  📋 Entity: #${activeXlnFunctions.getEntityShortId(replica.entityId)} (${replica.signerId})`);
      });

      if (replicasArray.length === 0) return;

      // Group replicas by entity
      const entityGroups: { [key: string]: any[] } = {};
      replicasArray.forEach((replica: any) => {
        const entityId = replica.entityId;
        if (!entityGroups[entityId]) {
          entityGroups[entityId] = [];
        }
        entityGroups[entityId].push(replica);
      });

      // Skip jurisdiction header for cleaner UX - go straight to entities

      // Add entities and their signers
      const entityKeys = Object.keys(entityGroups);
      entityKeys.forEach((entityId, eIndex) => {
        const entitySigners = entityGroups[entityId];
        const isLastEntity = eIndex === entityKeys.length - 1;
        if (!activeXlnFunctions) return; // Safety guard
        const entityNum = activeXlnFunctions.getEntityShortId(entityId);

        // Get name from first replica of this entity
        const firstReplica = entitySigners?.[0];
        const name = firstReplica ? getEntityName(firstReplica) : '';
        const entityDisplay = name ? `${name} (#${entityNum})` : `Entity #${entityNum}`;

        // Add entity with identicon
        const entityItem = createDropdownTreeItem(
          entityDisplay,
          '',
          1,
          false,
          isLastEntity,
          _searchTerm
        );

        // Add identicon
        if ((activeXlnFunctions as any)?.generateEntityAvatar) {
          const avatarUrl = activeXlnFunctions.generateEntityAvatar(entityId);
          const img = document.createElement('img');
          img.src = avatarUrl;
          img.className = 'entity-avatar';
          img.style.cssText = 'width: 20px; height: 20px; border-radius: 4px; margin-right: 8px; vertical-align: middle;';
          entityItem.querySelector('.item-label')?.prepend(img);
        }

        resultsContainer.appendChild(entityItem);

        // Add signers for this entity
        entitySigners?.forEach((replica, sIndex) => {
          const isLastSigner = sIndex === (entitySigners?.length || 0) - 1;

          const signerItem = createDropdownTreeItem(
            replica.signerId,
            `${jurisdiction.name}:${replica.signerId}:${replica.entityId}`,
            2,
            true,
            isLastSigner && isLastEntity,
            _searchTerm
          );

          // Add signer identicon
          if ((activeXlnFunctions as any)?.generateSignerAvatar) {
            const avatarUrl = activeXlnFunctions.generateSignerAvatar(replica.signerId);
            const img = document.createElement('img');
            img.src = avatarUrl;
            img.className = 'signer-avatar';
            img.style.cssText = 'width: 16px; height: 16px; border-radius: 3px; margin-right: 6px; vertical-align: middle;';
            signerItem.querySelector('.item-label')?.prepend(img);
          }

          signerItem.addEventListener('click', () => selectEntity(jurisdiction.name, replica.signerId, replica.entityId));
          resultsContainer.appendChild(signerItem);
        });
      });
    });
  }

  function createDropdownTreeItem(text: string, value: string, level: number, isSelectable: boolean, _isLast: boolean, __searchTerm: string): HTMLDivElement {
    const item = document.createElement('div');
    item.className = `dropdown-item ${level > 0 ? `indent-${level}` : ''}`;

    // Create ASCII tree structure
    let prefix = '';
    if (level === 1) {
      prefix = '├─ ';
    } else if (level === 2) {
      prefix = '│  └─ ';
    }

    item.innerHTML = `
      <span class="tree-prefix" style="color: #666; font-family: monospace;">${prefix}</span>
      <span class="item-text">${text}</span>
    `;

    if (isSelectable) {
      item.style.cursor = 'pointer';
      item.dataset['value'] = value;
    } else {
      item.style.cursor = 'default';
      item.style.color = '#9d9d9d';
    }

    // TODO: Apply search highlighting if needed
    // if (_searchTerm && text.toLowerCase().includes(_searchTerm.toLowerCase())) {
    //   highlightSearchTerm(item, _searchTerm);
    // }

    return item;
  }


  function selectEntity(jurisdiction: string, signerId: string, entityId: string) {
    console.log('🎯 EntityDropdown.selectEntity called:', { jurisdiction, signerId, entityId: entityId.slice(0, 10) });
    console.log('🎯 Current tab before dispatch:', { tabEntityId: tab.entityId?.slice(0, 10), tabSignerId: tab.signerId });

    dispatch('entitySelect', {
      jurisdiction,
      signerId: signerId,
      entityId
    });

    console.log('🎯 Event dispatched, closing dropdown');
    isOpen = false;
  }

  // Close dropdown when clicking outside
  function handleClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.unified-dropdown')) {
      isOpen = false;
    }
  }
</script>

<svelte:window on:click={handleClickOutside} />

<div class="unified-dropdown" class:open={isOpen}>
  <button class="unified-dropdown-btn" on:click={toggleDropdown} style="width: 100%;">
    <span class="dropdown-icon">🏛️</span>
    <span class="dropdown-text">{dropdownText}</span>
    <span class="dropdown-arrow">▼</span>
  </button>
  <div class="unified-dropdown-content" class:show={isOpen} bind:this={dropdownContent}>
    <!-- Tree structure will be populated here -->
  </div>
</div>

<style>
  /* Unified Hierarchical Dropdown */
  .unified-dropdown {
    position: relative;
    display: inline-block;
    flex: 1;
  }

  .unified-dropdown-btn {
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 6px;
    color: #d4d4d4;
    padding: 8px 16px;
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 300px;
    transition: all 0.2s ease;
  }

  .unified-dropdown-btn:hover {
    background: #404040;
    border-color: #007acc;
  }

  .dropdown-icon {
    font-size: 16px;
  }

  .dropdown-text {
    flex: 1;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dropdown-arrow {
    transition: transform 0.2s ease;
    color: #9d9d9d;
  }

  .unified-dropdown.open .dropdown-arrow {
    transform: rotate(180deg);
  }

  .unified-dropdown-content {
    display: none;
    position: absolute;
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 1000;
    width: 350px;
    max-height: 500px;
    overflow-y: auto;
    top: 100%;
    left: 0;
    margin-top: 4px;
  }

  /* Dark theme scrollbar */
  .unified-dropdown-content::-webkit-scrollbar {
    width: 8px;
  }

  .unified-dropdown-content::-webkit-scrollbar-track {
    background: #1e1e1e;
    border-radius: 4px;
  }

  .unified-dropdown-content::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 4px;
  }

  .unified-dropdown-content::-webkit-scrollbar-thumb:hover {
    background: #666;
  }

  .unified-dropdown-content.show {
    display: block;
  }

  :global(.dropdown-item) {
    padding: 8px 12px;
    cursor: pointer;
    border-bottom: 1px solid #3e3e3e;
    transition: background-color 0.2s ease;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :global(.dropdown-item:hover) {
    background: #404040;
  }

  :global(.dropdown-item:last-child) {
    border-bottom: none;
  }

  :global(.dropdown-item.indent-1) {
    padding-left: 24px;
  }

  :global(.dropdown-item.indent-2) {
    padding-left: 36px;
  }

  :global(.dropdown-search-container) {
    padding: 8px;
    border-bottom: 2px solid #555;
    background: #252525;
  }

  :global(.dropdown-search-input) {
    width: 100%;
    padding: 6px 8px;
    background: #1a1a1a;
    border: 1px solid #444;
    border-radius: 4px;
    color: #d4d4d4;
    font-size: 13px;
    outline: none;
  }

  :global(.dropdown-search-input:focus) {
    border-color: #007acc;
    background: #1e1e1e;
  }
</style>
