<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { replicas, xlnFunctions } from '../../stores/xlnStore';
  import { visibleReplicas } from '../../stores/timeStore';
  import { settings } from '../../stores/settingsStore';
  import type { Tab } from '../../types';

  export let tab: Tab;

  const dispatch = createEventDispatcher();

  let isOpen = false;
  let dropdownContent: HTMLDivElement;

  // Get dropdown display text
  $: dropdownText = getDropdownText(tab);

  function getDropdownText(tab: Tab): string {
    // SIMPLE: Just show the selected entity (like I fixed in CombinedNavigationDropdown)
    if (tab.entityId) {
      const entityNum = $xlnFunctions?.getEntityNumber(tab.entityId) || '?';
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

    resultsContainer.innerHTML = '';

    console.log(`🔍 EntityDropdown: Total replicas available: ${$replicas.size}`);
    console.log(`🔍 EntityDropdown: Replica keys:`, Array.from($replicas.keys()));

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
      const replicasArray = Array.from($replicas.values());

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
          const entityNum = $xlnFunctions?.getEntityNumber(replica.entityId) || '?';
          const entityDisplay = `Entity #${entityNum}`;

          const entityItem = createDropdownTreeItem(
            `🏢 ${entityDisplay}`,
            `${jurisdiction.name}:${signerId}:${replica.entityId}`,
            2,
            true,
            isLastEntity && isLastSigner,
            _searchTerm
          );

          entityItem.addEventListener('click', () => selectEntity(jurisdiction.name, signerId, replica.entityId));
          resultsContainer.appendChild(entityItem);
        });
      });
    });
  }

  function renderEntityFirstDropdown(jurisdictions: any[], resultsContainer: HTMLDivElement, _searchTerm: string) {
    jurisdictions.forEach((jurisdiction) => {
      // Get all replicas (use time-aware replicas, no jurisdiction filtering)
      const currentReplicas = $visibleReplicas || $replicas;
      const replicasArray = Array.from(currentReplicas.values());

      console.log(`🔍 EntityDropdown: ${jurisdiction.name} has ${replicasArray.length} replicas`);
      replicasArray.forEach((replica: any) => {
        console.log(`  📋 Entity: #${$xlnFunctions?.getEntityNumber(replica.entityId) || '?'} (${replica.signerId})`);
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
        const entityNum = $xlnFunctions?.getEntityNumber(entityId) || '?';
        const entityDisplay = `Entity #${entityNum}`;

        // Add entity
        const entityItem = createDropdownTreeItem(
          `🏢 ${entityDisplay}`,
          '',
          1,
          false,
          isLastEntity,
          _searchTerm
        );
        resultsContainer.appendChild(entityItem);

        // Add signers for this entity
        entitySigners?.forEach((replica, sIndex) => {
          const isLastSigner = sIndex === (entitySigners?.length || 0) - 1;

          const signerItem = createDropdownTreeItem(
            `👤 ${replica.signerId}`,
            `${jurisdiction.name}:${replica.signerId}:${replica.entityId}`,
            2,
            true,
            isLastSigner && isLastEntity,
            _searchTerm
          );

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
    dispatch('entitySelect', {
      jurisdiction,
      signerId: signerId,
      entityId
    });

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
