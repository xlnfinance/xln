<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { replicas } from '../../stores/xlnStore';
  import { settings } from '../../stores/settingsStore';
  import { XLNServer } from '../../utils/xlnServer';
  import { jurisdictions, jurisdictionService } from '../../services/jurisdictionService';
  import { entityService, entities } from '../../services/entityService';
  import type { Tab } from '../../types';

  export let tab: Tab;

  const dispatch = createEventDispatcher();

  let isOpen = false;
  let searchTerm = '';
  let dropdownContent: HTMLDivElement;
  let isLoading = false;
  let error: string | null = null;

  // Initialize services on component mount
  onMount(async () => {
    try {
      isLoading = true;
      console.log('🔄 Initializing EntityDropdown services...');
      
      // Initialize jurisdiction service if not already done
      if ($jurisdictions.size === 0) {
        await jurisdictionService.initialize();
      }
      
      // Initialize entity service if not already done
      if ($entities.size === 0) {
        // Entity service doesn't have initialize method, just load entities
        console.log('📋 Loading existing entities...');
      }
      
      console.log('✅ EntityDropdown services initialized');
      isLoading = false;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to initialize services';
      isLoading = false;
      console.error('❌ EntityDropdown initialization failed:', err);
    }
  });

  // Get dropdown display text
  $: dropdownText = getDropdownText(tab);

  function getDropdownText(tab: Tab): string {
    if (tab.entityId && tab.signer && tab.jurisdiction) {
      return `${tab.jurisdiction} → ${tab.signer} → ${tab.entityId.slice(-4)}`;
    } else if (tab.signer && tab.jurisdiction) {
      return `${tab.jurisdiction} → ${tab.signer} → Select Entity`;
    } else if (tab.jurisdiction) {
      return `${tab.jurisdiction} → Select Signer → Entity`;
    } else {
      return 'Select Jurisdiction → Signer → Entity';
    }
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
      <div class="dropdown-header">
        <div class="dropdown-search-container">
          <input type="text" class="dropdown-search-input" placeholder="🔍 Search jurisdictions, signers, entities..." />
        </div>
        <button class="refresh-btn" title="Refresh jurisdictions" onclick="this.dispatchEvent(new CustomEvent('refresh'))">
          🔄
        </button>
      </div>
      <div class="dropdown-results" id="dropdownResults">
        <!-- Results will be populated here -->
      </div>
    `;

    // Add refresh button event listener
    const refreshBtn = dropdownContent.querySelector('.refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        refreshJurisdictions();
      });
    }

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

  function updateDropdownResults(resultsContainer: HTMLDivElement, searchTerm: string) {
    if (!resultsContainer) return;

    resultsContainer.innerHTML = '';

    // Get dynamic jurisdictions from jurisdiction service
    const jurisdictionsData = getJurisdictionsData();

    if (jurisdictionsData.length === 0) {
      resultsContainer.innerHTML = '<div class="dropdown-item">Loading jurisdictions...</div>';
      return;
    }

    const dropdownMode = $settings.dropdownMode;

    if (dropdownMode === 'signer-first') {
      renderSignerFirstDropdown(jurisdictionsData, resultsContainer, searchTerm);
    } else {
      renderEntityFirstDropdown(jurisdictionsData, resultsContainer, searchTerm);
    }
  }

  function getJurisdictionsData() {
    return Array.from($jurisdictions.values()).map(status => ({
      name: status.name,
      id: status.name.toLowerCase(),
      connected: status.connected,
      error: status.error
    }));
  }

  function renderSignerFirstDropdown(jurisdictions: any[], resultsContainer: HTMLDivElement, searchTerm: string) {
    jurisdictions.forEach((jurisdiction, jIndex) => {
      // Get replicas for this jurisdiction
      const replicasArray = Array.from($replicas.values()).filter(replica => 
        replica.state?.config?.jurisdiction?.name === jurisdiction.name
      );

      if (replicasArray.length === 0) return;

      // Group replicas by signer
      const signerGroups: { [key: string]: any[] } = {};
      replicasArray.forEach(replica => {
        const signerId = replica.signerId;
        if (!signerGroups[signerId]) {
          signerGroups[signerId] = [];
        }
        signerGroups[signerId].push(replica);
      });

      // Add jurisdiction header with connection status
      const statusIcon = jurisdiction.connected ? '✅' : '❌';
      const statusText = jurisdiction.connected ? 'Connected' : jurisdiction.error || 'Disconnected';
      const jurisdictionItem = createDropdownTreeItem(
        `🏛️ ${jurisdiction.name} ${statusIcon}`, 
        '', 
        0, 
        false, 
        false,
        searchTerm
      );
      
      // Add status info as subtitle
      if (!jurisdiction.connected) {
        const statusSubtitle = document.createElement('div');
        statusSubtitle.className = 'dropdown-item indent-1';
        statusSubtitle.style.color = '#ff6b6b';
        statusSubtitle.style.fontSize = '12px';
        statusSubtitle.innerHTML = `<span class="tree-prefix" style="color: #666; font-family: monospace;">├─ </span>⚠️ ${statusText}`;
        resultsContainer.appendChild(jurisdictionItem);
        resultsContainer.appendChild(statusSubtitle);
      } else {
        resultsContainer.appendChild(jurisdictionItem);
      }

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
          searchTerm
        );
        resultsContainer.appendChild(signerItem);

        // Add entities for this signer
        signerEntities.forEach((replica, eIndex) => {
          const isLastEntity = eIndex === signerEntities.length - 1;
          const entityDisplay = replica.entityId.slice(-4);
          
          const entityItem = createDropdownTreeItem(
            `🏢 ${entityDisplay}`, 
            `${jurisdiction.name}:${signerId}:${replica.entityId}`, 
            2, 
            true, 
            isLastEntity && isLastSigner,
            searchTerm
          );
          
          entityItem.addEventListener('click', () => selectEntity(jurisdiction.name, signerId, replica.entityId));
          resultsContainer.appendChild(entityItem);
        });
      });
    });
  }

  function renderEntityFirstDropdown(jurisdictions: any[], resultsContainer: HTMLDivElement, searchTerm: string) {
    jurisdictions.forEach((jurisdiction, jIndex) => {
      // Get replicas for this jurisdiction
      const replicasArray = Array.from($replicas.values()).filter(replica => 
        replica.state?.config?.jurisdiction?.name === jurisdiction.name
      );

      if (replicasArray.length === 0) return;

      // Group replicas by entity
      const entityGroups: { [key: string]: any[] } = {};
      replicasArray.forEach(replica => {
        const entityId = replica.entityId;
        if (!entityGroups[entityId]) {
          entityGroups[entityId] = [];
        }
        entityGroups[entityId].push(replica);
      });

      // Add jurisdiction header with connection status
      const statusIcon = jurisdiction.connected ? '✅' : '❌';
      const statusText = jurisdiction.connected ? 'Connected' : jurisdiction.error || 'Disconnected';
      const jurisdictionItem = createDropdownTreeItem(
        `🏛️ ${jurisdiction.name} ${statusIcon}`, 
        '', 
        0, 
        false, 
        false,
        searchTerm
      );
      
      // Add status info as subtitle
      if (!jurisdiction.connected) {
        const statusSubtitle = document.createElement('div');
        statusSubtitle.className = 'dropdown-item indent-1';
        statusSubtitle.style.color = '#ff6b6b';
        statusSubtitle.style.fontSize = '12px';
        statusSubtitle.innerHTML = `<span class="tree-prefix" style="color: #666; font-family: monospace;">├─ </span>⚠️ ${statusText}`;
        resultsContainer.appendChild(jurisdictionItem);
        resultsContainer.appendChild(statusSubtitle);
      } else {
        resultsContainer.appendChild(jurisdictionItem);
      }

      // Add entities and their signers
      const entityKeys = Object.keys(entityGroups);
      entityKeys.forEach((entityId, eIndex) => {
        const entitySigners = entityGroups[entityId];
        const isLastEntity = eIndex === entityKeys.length - 1;
        const entityDisplay = entityId.slice(-4);

        // Add entity
        const entityItem = createDropdownTreeItem(
          `🏢 ${entityDisplay} (${entitySigners.length} signers)`, 
          '', 
          1, 
          false, 
          isLastEntity,
          searchTerm
        );
        resultsContainer.appendChild(entityItem);

        // Add signers for this entity
        entitySigners.forEach((replica, sIndex) => {
          const isLastSigner = sIndex === entitySigners.length - 1;
          
          const signerItem = createDropdownTreeItem(
            `👤 ${replica.signerId}`, 
            `${jurisdiction.name}:${replica.signerId}:${replica.entityId}`, 
            2, 
            true, 
            isLastSigner && isLastEntity,
            searchTerm
          );
          
          signerItem.addEventListener('click', () => selectEntity(jurisdiction.name, replica.signerId, replica.entityId));
          resultsContainer.appendChild(signerItem);
        });
      });
    });
  }

  function createDropdownTreeItem(text: string, value: string, level: number, isSelectable: boolean, isLast: boolean, searchTerm: string): HTMLDivElement {
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
      item.dataset.value = value;
    } else {
      item.style.cursor = 'default';
      item.style.color = '#9d9d9d';
    }

    // Apply search highlighting if needed
    if (searchTerm && text.toLowerCase().includes(searchTerm.toLowerCase())) {
      highlightSearchTerm(item, searchTerm);
    }
    
    return item;
  }

  function highlightSearchTerm(element: HTMLElement, searchTerm: string) {
    // Simple highlighting implementation
    const textSpan = element.querySelector('.item-text');
    if (textSpan && searchTerm) {
      const text = textSpan.textContent || '';
      const regex = new RegExp(`(${searchTerm})`, 'gi');
      textSpan.innerHTML = text.replace(regex, '<mark style="background: #ffd700; color: #000; padding: 2px;">$1</mark>');
    }
  }

  function selectEntity(jurisdiction: string, signerId: string, entityId: string) {
    dispatch('entitySelect', {
      jurisdiction,
      signer: signerId,
      entityId
    });
    
    isOpen = false;
  }

  async function refreshJurisdictions() {
    try {
      isLoading = true;
      error = null;
      console.log('🔄 Refreshing jurisdictions...');
      await jurisdictionService.refreshJurisdictionStatus();
      console.log('✅ Jurisdictions refreshed');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to refresh jurisdictions';
      console.error('❌ Failed to refresh jurisdictions:', err);
    } finally {
      isLoading = false;
    }
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
  <button class="unified-dropdown-btn" on:click={toggleDropdown} style="width: 100%;" disabled={isLoading}>
    <span class="dropdown-icon">
      {#if isLoading}🔄{:else}🏛️{/if}
    </span>
    <span class="dropdown-text">
      {#if isLoading}
        Initializing...
      {:else if error}
        Error: {error}
      {:else}
        {dropdownText}
      {/if}
    </span>
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

  .unified-dropdown-btn:hover:not(:disabled) {
    background: #404040;
    border-color: #007acc;
  }

  .unified-dropdown-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
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
    max-height: 300px;
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

  :global(.dropdown-header) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border-bottom: 2px solid #555;
    background: #252525;
  }

  :global(.dropdown-search-container) {
    flex: 1;
  }

  :global(.refresh-btn) {
    background: #007acc;
    border: none;
    border-radius: 4px;
    color: white;
    padding: 6px 8px;
    cursor: pointer;
    font-size: 14px;
    transition: background-color 0.2s ease;
  }

  :global(.refresh-btn:hover) {
    background: #0086e6;
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
