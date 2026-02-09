<!--
  EntityInput.svelte - Reusable entity selector with universal ID parsing

  Features:
  - Dropdown with known entities from gossip profiles
  - Universal entity ID parsing (numbered, named, short ID, provider-scoped)
  - Contact integration
  - Auto profile lookup from gossip cache
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { xlnFunctions, xlnEnvironment } from '../../stores/xlnStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';

  export let value: string = '';
  export let placeholder: string = 'Select or enter entity...';
  export let entities: string[] = [];
  export let contacts: Array<{ name: string; entityId: string }> = [];
  export let excludeId: string = ''; // Exclude current entity
  export let disabled: boolean = false;
  export let label: string = '';

  const dispatch = createEventDispatcher();

  // Context
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  const contextEnv = entityEnv?.env;
  $: activeFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
  $: activeEnv = contextEnv ? $contextEnv : $xlnEnvironment;

  // Gossip profile lookup
  function lookupEntityFromGossip(query: string): string | null {
    const env = activeEnv;
    if (!env?.gossip?.getProfiles) return null;

    const profiles = env.gossip.getProfiles();
    const queryLower = query.toLowerCase();

    // Search by short ID (first 4 hex chars)
    for (const profile of profiles) {
      const entityId = profile.entityId;
      if (!entityId) continue;
      const shortId = entityId.slice(2, 6).toLowerCase(); // First 4 hex chars
      if (shortId === queryLower) return entityId;
    }

    // Search by name
    for (const profile of profiles) {
      const name = profile.metadata?.name?.toLowerCase();
      if (name === queryLower) return profile.entityId;
    }

    return null;
  }

  // Universal entity ID parser (simplified version)
  function parseEntityInput(input: string): { entityId: string; shortId: string; resolved: boolean } {
    const trimmed = input.trim();
    if (!trimmed) return { entityId: '', shortId: '', resolved: false };

    // Full 32-byte hex
    if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
      return {
        entityId: trimmed.toLowerCase(),
        shortId: getShortIdFromHex(trimmed),
        resolved: true
      };
    }

    // Short hex (4 chars) with optional #
    const shortMatch = trimmed.match(/^#?([0-9a-fA-F]{4})$/i);
    if (shortMatch) {
      const short = shortMatch[1]!.toLowerCase();
      const found = lookupEntityFromGossip(short);
      if (found) {
        return { entityId: found, shortId: short.toUpperCase(), resolved: true };
      }
      // Also check entities list
      const match = entities.find(id => id.slice(2, 6).toLowerCase() === short);
      if (match) {
        return { entityId: match, shortId: short.toUpperCase(), resolved: true };
      }
      return { entityId: '', shortId: short.toUpperCase(), resolved: false };
    }

    // Numbered entity: #5 or just 5
    const numMatch = trimmed.match(/^#?(\d+)$/);
    if (numMatch) {
      const num = BigInt(numMatch[1]!);
      const THRESHOLD = BigInt(256 ** 6);
      if (num >= 0n && num < THRESHOLD) {
        const entityId = '0x' + num.toString(16).padStart(64, '0');
        return { entityId, shortId: num.toString(), resolved: true };
      }
    }

    // Named entity: @alice or alice
    const nameMatch = trimmed.match(/^@?([a-zA-Z][a-zA-Z0-9_.-]*)$/);
    if (nameMatch) {
      const name = nameMatch[1]!.toLowerCase();
      const found = lookupEntityFromGossip(name);
      if (found) {
        return { entityId: found, shortId: name, resolved: true };
      }
      // Check contacts
      const contact = contacts.find(c => c.name.toLowerCase() === name);
      if (contact) {
        return { entityId: contact.entityId, shortId: name, resolved: true };
      }
      return { entityId: '', shortId: name, resolved: false };
    }

    // Partial hex (less than 64 chars)
    if (/^0x[0-9a-fA-F]+$/.test(trimmed) && trimmed.length >= 6) {
      return {
        entityId: trimmed.toLowerCase().padEnd(66, '0'),
        shortId: trimmed.slice(2, 6).toUpperCase(),
        resolved: true
      };
    }

    return { entityId: trimmed, shortId: '', resolved: false };
  }

  function getShortIdFromHex(hex: string): string {
    const clean = hex.replace('0x', '').toLowerCase();
    // Check if numbered entity
    try {
      const value = BigInt('0x' + clean);
      const THRESHOLD = BigInt(256 ** 6);
      if (value >= 0n && value < THRESHOLD) {
        return value.toString();
      }
    } catch { /* ignore */ }
    return clean.slice(0, 4).toUpperCase();
  }

  // Track unresolved input for display
  let unresolvedInput = '';

  // UI state
  let showDropdown = false;
  let inputValue = '';
  let inputRef: HTMLInputElement;

  // Format entity ID consistently: #XXXX (last 4 hex chars)
  function formatShortId(id: string): string {
    return id || '';
  }

  // Get display name for entity (contact name or short ID)
  function getDisplayName(id: string): string {
    const contact = contacts.find(c => c.entityId === id || c.entityId.toLowerCase() === id.toLowerCase());
    if (contact) return `${contact.name} (${id})`;
    return formatShortId(id);
  }

  // Filtered options
  $: filteredEntities = entities
    .filter(id => id !== excludeId)
    .map(id => ({
      id,
      display: getDisplayName(id),
      isContact: contacts.some(c => c.entityId === id)
    }));

  // Contact-only options (for entities not in the network)
  $: contactOnlyOptions = contacts
    .filter(c => !entities.includes(c.entityId) && c.entityId !== excludeId)
    .map(c => ({
      id: c.entityId,
      display: c.name,
      isContact: true
    }));

  // All options
  $: allOptions = [...filteredEntities, ...contactOnlyOptions];

  // Filter by search
  $: visibleOptions = inputValue
    ? allOptions.filter(opt =>
        opt.display.toLowerCase().includes(inputValue.toLowerCase()) ||
        opt.id.toLowerCase().includes(inputValue.toLowerCase())
      )
    : allOptions;

  // Handle selection
  function selectEntity(id: string) {
    value = id;
    inputValue = '';
    showDropdown = false;
    dispatch('change', { value: id });
  }

  // Handle custom input with universal parsing
  function handleInputChange(e: Event) {
    const target = e.target as HTMLInputElement;
    inputValue = target.value;

    // Use universal parser
    const parsed = parseEntityInput(inputValue);

    if (parsed.resolved && parsed.entityId) {
      value = parsed.entityId;
      unresolvedInput = '';
      dispatch('change', { value: parsed.entityId, shortId: parsed.shortId, resolved: true });
    } else if (parsed.shortId) {
      // Store unresolved for display, don't set value yet
      unresolvedInput = parsed.shortId;
      // Still dispatch with unresolved flag so parent can show status
      dispatch('change', { value: '', shortId: parsed.shortId, resolved: false });
    }
  }

  function handleFocus() {
    showDropdown = true;
  }

  function handleBlur() {
    // Delay to allow click on dropdown
    setTimeout(() => showDropdown = false, 150);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      showDropdown = false;
      inputRef?.blur();
    }
    if (e.key === 'Enter' && visibleOptions.length > 0 && visibleOptions[0]) {
      selectEntity(visibleOptions[0].id);
    }
  }

  // Display value
  $: displayValue = value ? getDisplayName(value) : '';
</script>

<div class="entity-input" class:disabled>
  {#if label}
    <label class="input-label">{label}</label>
  {/if}

  <div class="input-wrapper">
    <input
      bind:this={inputRef}
      type="text"
      value={showDropdown ? inputValue : displayValue}
      {placeholder}
      {disabled}
      on:focus={handleFocus}
      on:blur={handleBlur}
      on:input={handleInputChange}
      on:keydown={handleKeydown}
    />

    {#if unresolvedInput && !showDropdown && !value}
      <span class="selected-badge unresolved" title="Entity not found in gossip">?{unresolvedInput}</span>
    {/if}

    <button
      class="dropdown-toggle"
      type="button"
      on:click={() => { showDropdown = !showDropdown; inputRef?.focus(); }}
      {disabled}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
  </div>

  {#if showDropdown && !disabled}
    <div class="dropdown">
      {#if visibleOptions.length === 0}
        <div class="dropdown-empty">
          {inputValue ? 'No matches' : 'No entities available'}
        </div>
      {:else}
        {#each visibleOptions as opt}
          <button
            class="dropdown-item"
            class:contact={opt.isContact}
            class:selected={opt.id === value}
            on:mousedown|preventDefault={() => selectEntity(opt.id)}
          >
            <span class="item-name">{opt.display}</span>
            {#if opt.isContact}
              <span class="contact-badge">Contact</span>
            {/if}
          </button>
        {/each}
      {/if}

      <div class="dropdown-hint">
        #5 (numbered) · #ABCD (short) · @name · 0x... (full)
      </div>
    </div>
  {/if}
</div>

<style>
  .entity-input {
    position: relative;
    width: 100%;
  }

  .entity-input.disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .input-label {
    display: block;
    font-size: 11px;
    font-weight: 500;
    color: #78716c;
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  input {
    width: 100%;
    padding: 12px 80px 12px 14px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
    color: #e7e5e4;
    font-size: 14px;
    font-family: inherit;
    transition: border-color 0.15s;
  }

  input:focus {
    outline: none;
    border-color: #fbbf24;
  }

  input::placeholder {
    color: #57534e;
  }

  .selected-badge {
    position: absolute;
    right: 36px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #fbbf24;
    background: #422006;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .selected-badge.unresolved {
    color: #f97316;
    background: #431407;
    border: 1px dashed #c2410c;
  }

  .dropdown-toggle {
    position: absolute;
    right: 4px;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: #78716c;
    cursor: pointer;
    border-radius: 4px;
  }

  .dropdown-toggle:hover {
    background: #292524;
    color: #a8a29e;
  }

  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 4px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 100;
    max-height: 240px;
    overflow-y: auto;
  }

  .dropdown::-webkit-scrollbar {
    width: 4px;
  }

  .dropdown::-webkit-scrollbar-thumb {
    background: #44403c;
    border-radius: 2px;
  }

  .dropdown-empty {
    padding: 16px;
    text-align: center;
    color: #57534e;
    font-size: 13px;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 10px 14px;
    background: none;
    border: none;
    color: #e7e5e4;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s;
  }

  .dropdown-item:hover {
    background: #292524;
  }

  .dropdown-item.selected {
    background: #422006;
  }

  .item-name {
    flex: 1;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .contact-badge {
    font-size: 9px;
    color: #22c55e;
    background: rgba(34, 197, 94, 0.15);
    padding: 2px 5px;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 600;
  }

  .dropdown-hint {
    padding: 8px 14px;
    border-top: 1px solid #292524;
    font-size: 11px;
    color: #57534e;
  }
</style>
