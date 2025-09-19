<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { EntityReplica } from '../../types';

  export let replica: EntityReplica | null;

  const dispatch = createEventDispatcher();

  let isOpen = false;
  let searchTerm = '';
  let dropdownContent: HTMLDivElement;

  // Get all accounts from the current entity
  $: availableAccounts = replica?.state?.accounts 
    ? Array.from(replica.state.accounts.entries()).map(([entityId, account]) => ({
        entityId,
        shortId: entityId.slice(-4),
        displayName: `Entity ${entityId.slice(-4)}`,
        account
      }))
    : [];

  // Debug logging
  $: {
    console.log(`🔍 AccountDropdown: replica exists: ${!!replica}`);
    console.log(`🔍 AccountDropdown: replica.state exists: ${!!replica?.state}`);
    console.log(`🔍 AccountDropdown: replica.state.accounts exists: ${!!replica?.state?.accounts}`);
    if (replica?.state?.accounts) {
      console.log(`🔍 AccountDropdown: accounts size: ${replica.state.accounts.size}`);
      console.log(`🔍 AccountDropdown: account keys:`, Array.from(replica.state.accounts.keys()));
    }
    console.log(`🔍 AccountDropdown: availableAccounts length: ${availableAccounts.length}`);
  }

  // Get dropdown display text
  $: dropdownText = availableAccounts.length > 0 
    ? `📋 Accounts (${availableAccounts.length})`
    : '📋 No Accounts';

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
        <input type="text" class="dropdown-search-input" placeholder="🔍 Search accounts..." />
      </div>
      <div class="dropdown-results" id="dropdownResults">
        <!-- Results will be populated here -->
      </div>
    `;

    const searchInput = dropdownContent.querySelector('.dropdown-search-input') as HTMLInputElement;
    const resultsContainer = dropdownContent.querySelector('#dropdownResults') as HTMLDivElement;

    if (searchInput && resultsContainer) {
      // Initial population
      updateResults('');

      // Search functionality
      searchInput.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        updateResults(target.value);
      });
    }
  }

  function updateResults(search: string) {
    const resultsContainer = dropdownContent.querySelector('#dropdownResults') as HTMLDivElement;
    if (!resultsContainer) return;

    const filteredAccounts = availableAccounts.filter(acc => 
      acc.displayName.toLowerCase().includes(search.toLowerCase()) ||
      acc.entityId.toLowerCase().includes(search.toLowerCase())
    );

    if (filteredAccounts.length === 0) {
      resultsContainer.innerHTML = '<div class="dropdown-no-results">No accounts found</div>';
      return;
    }

    resultsContainer.innerHTML = filteredAccounts.map(acc => {
      const summary = getAccountSummary(acc.account);
      return `
        <div class="dropdown-option" data-entity-id="${acc.entityId}">
          <div class="option-content">
            <div class="option-main">
              <span class="option-icon">🏢</span>
              <span class="option-text">${acc.displayName}</span>
            </div>
            <div class="option-details">
              <span class="account-status ${summary.status.toLowerCase()}">${summary.status}</span>
              <small>${summary.tokenCount} tokens • Frame #${acc.account.currentFrame?.frameId || 0}</small>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Add click handlers
    resultsContainer.querySelectorAll('.dropdown-option').forEach((option: HTMLElement) => {
      option.addEventListener('click', () => {
        const entityId = option.dataset.entityId;
        if (entityId) {
          selectAccount(entityId, availableAccounts.find(acc => acc.entityId === entityId)?.account);
        }
      });
    });
  }

  function selectAccount(entityId: string, account: any) {
    isOpen = false;
    
    // Dispatch account selection event to parent
    dispatch('accountSelect', { entityId, account });
  }

  function getAccountSummary(account: any) {
    const tokenCount = account.deltas ? account.deltas.size : 0;
    const mempoolSize = account.mempool ? account.mempool.length : 0;
    const status = mempoolSize > 0 ? 'Pending' : 'Synced';
    
    return { tokenCount, mempoolSize, status };
  }

  // Close dropdown when clicking outside
  function handleClickOutside(event: MouseEvent) {
    const target = event.target as Element;
    if (!target.closest('.unified-dropdown')) {
      isOpen = false;
    }
  }

  $: if (typeof window !== 'undefined') {
    if (isOpen) {
      window.addEventListener('click', handleClickOutside);
    } else {
      window.removeEventListener('click', handleClickOutside);
    }
  }
</script>

<div class="unified-dropdown" class:open={isOpen}>
  <button class="unified-dropdown-btn" on:click={toggleDropdown} disabled={availableAccounts.length === 0} style="width: 100%;">
    <span class="dropdown-icon">📋</span>
    <span class="dropdown-text">{dropdownText}</span>
    <span class="dropdown-arrow">▼</span>
  </button>
  <div class="unified-dropdown-content" class:show={isOpen} bind:this={dropdownContent}>
    <!-- Content populated by JavaScript -->
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
    min-width: 200px;
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

  .unified-dropdown-content.show {
    display: block;
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

  :global(.dropdown-option) {
    padding: 8px 12px;
    cursor: pointer;
    border-bottom: 1px solid #3e3e3e;
    transition: background-color 0.2s ease;
    font-size: 14px;
  }

  :global(.dropdown-option:hover) {
    background: #404040;
  }

  :global(.dropdown-option:last-child) {
    border-bottom: none;
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

  :global(.dropdown-no-results) {
    padding: 12px;
    text-align: center;
    color: #9d9d9d;
    font-style: italic;
  }

  :global(.option-content) {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
  }

  :global(.option-main) {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  :global(.option-icon) {
    font-size: 16px;
  }

  :global(.option-text) {
    font-weight: 500;
  }

  :global(.option-details) {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  :global(.account-status) {
    font-size: 0.8em;
    padding: 2px 6px;
    border-radius: 3px;
    background: #28a745;
    color: white;
  }

  :global(.account-status.pending) {
    background: #ffc107;
    color: black;
  }
</style>