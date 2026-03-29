<!--
  EntityInput.svelte - Reusable entity selector with universal ID parsing

  Features:
  - Dropdown with known entities from gossip profiles
  - Universal entity ID parsing (numbered, named, short ID, provider-scoped)
  - Auto profile lookup from gossip cache
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import type { Profile as GossipProfile } from '@xln/runtime/xln-api';
  import { xlnFunctions, xlnEnvironment } from '../../stores/xlnStore';
  import { entityAvatar } from '../../utils/avatar';
  import { getGossipProfile, getGossipProfiles as getProfilesFromSource, scheduleGossipProfileFetch } from '../../utils/entityNaming';

  export let value: string = '';
  export let placeholder: string = 'Select or enter entity...';
  export let entities: string[] = [];
  export let excludeId: string = ''; // Exclude current entity
  export let disabled: boolean = false;
  export let label: string = '';
  export let preferredId: string = '';
  export let testId: string = '';
  export let variant: 'default' | 'move' = 'default';
  export let inputId: string = '';
  export let rawTextOverride: string = '';
  export let alwaysShowInput: boolean = false;
  export let hideDropdownHint: boolean = false;
  export let strictValueInput: boolean = false;

  const dispatch = createEventDispatcher();
  $: activeFunctions = $xlnFunctions;
  $: activeEnv = $xlnEnvironment;

  function normalizeEntityId(id: string | null | undefined): string {
    return String(id || '').trim().toLowerCase();
  }

  function optionTestId(id: string): string | undefined {
    const base = testId.trim();
    const normalized = normalizeEntityId(id);
    if (!base || !normalized) return undefined;
    return `${base}-option-${normalized}`;
  }

  function getGossipProfiles(): GossipProfile[] {
    return getProfilesFromSource(activeEnv);
  }

  function getKnownEntityName(id: string): string {
    const norm = normalizeEntityId(id);
    if (!norm) return '';
    const profile = getGossipProfile(norm, activeEnv);
    if (!profile) {
      scheduleGossipProfileFetch([norm]);
      return '';
    }
    return profile.name.trim();
  }

  function lookupEntityFromGossip(query: string): string | null {
    const profiles = getGossipProfiles();
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
      const name = profile.name?.toLowerCase();
      if (name === queryLower) return profile.entityId;
    }

    return null;
  }

  // Universal entity ID parser (simplified version)
  function parseEntityInput(input: string): { entityId: string; shortId: string; resolved: boolean } {
    const trimmed = input.trim();
    if (!trimmed) return { entityId: '', shortId: '', resolved: false };

    const invoiceMatch = trimmed.match(/^(0x[0-9a-fA-F]{64})\?.+$/);
    if (invoiceMatch?.[1]) {
      const entityId = invoiceMatch[1].toLowerCase();
      scheduleGossipProfileFetch([entityId]);
      return {
        entityId,
        shortId: getShortIdFromHex(entityId),
        resolved: true,
      };
    }

    // Full 32-byte hex
    if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
      scheduleGossipProfileFetch([trimmed.toLowerCase()]);
      return {
        entityId: trimmed.toLowerCase(),
        shortId: getShortIdFromHex(trimmed),
        resolved: true
      };
    }

    if (strictValueInput) {
      return { entityId: trimmed, shortId: '', resolved: false };
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
      return { entityId: '', shortId: name, resolved: false };
    }

    // Partial hex (less than 64 chars)
    if (/^0x[0-9a-fA-F]+$/.test(trimmed) && trimmed.length >= 6) {
      return {
        entityId: trimmed.toLowerCase(),
        shortId: trimmed.slice(2, 6).toUpperCase(),
        resolved: false
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

  function getCompactEntityId(id: string): string {
    const canonical = String(id || '').trim();
    if (!canonical) return '';
    if (/^0x[0-9a-fA-F]{64}$/.test(canonical)) {
      return `${canonical.slice(0, 10)}...${canonical.slice(-6)}`;
    }
    return canonical;
  }

  // Track unresolved input for display
  let unresolvedInput = '';

  // UI state
  let showDropdown = false;
  let inputValue = '';
  let inputRef: HTMLInputElement | null = null;

  // Format entity ID consistently: #XXXX (last 4 hex chars)
  function formatShortId(id: string): string {
    return id || '';
  }

  // Get display name for entity using gossip metadata when available.
  function getDisplayName(id: string): string {
    const canonical = String(id || '').trim();
    if (!canonical) return '';
    const knownName = getKnownEntityName(canonical);
    return knownName || canonical;
  }

  // Filtered options
  $: filteredEntities = entities
    .filter(id => normalizeEntityId(id) !== normalizeEntityId(excludeId))
    .map(id => ({
      id,
      displayName: getKnownEntityName(id) || formatShortId(id),
      avatar: entityAvatar(activeFunctions, id)
    }));

  $: missingEntityProfiles = entities.filter((id) => {
    const norm = normalizeEntityId(id);
    return norm.length > 0 && !getGossipProfiles().some((profile) => normalizeEntityId(profile.entityId) === norm);
  });
  $: if (missingEntityProfiles.length > 0) {
    scheduleGossipProfileFetch(missingEntityProfiles);
  }

  function compareOptionPriority(
    left: { id: string; displayName: string },
    right: { id: string; displayName: string },
  ): number {
    const leftNorm = normalizeEntityId(left.id);
    const rightNorm = normalizeEntityId(right.id);
    const preferredNorm = normalizeEntityId(preferredId);
    if (preferredNorm) {
      if (leftNorm === preferredNorm && rightNorm !== preferredNorm) return -1;
      if (rightNorm === preferredNorm && leftNorm !== preferredNorm) return 1;
    }
    return left.displayName.localeCompare(right.displayName);
  }

  // All options
  $: allOptions = [...filteredEntities].sort(compareOptionPriority);

  // Filter by search
  $: visibleOptions = inputValue
    ? allOptions.filter(opt =>
        opt.displayName.toLowerCase().includes(inputValue.toLowerCase()) ||
        opt.id.toLowerCase().includes(inputValue.toLowerCase())
      )
    : allOptions;

  $: preferredNorm = normalizeEntityId(preferredId);
  $: pinnedOption = preferredNorm
    ? visibleOptions.find((opt) => normalizeEntityId(opt.id) === preferredNorm) ?? null
    : null;
  $: remainingOptions = pinnedOption
    ? visibleOptions.filter((opt) => normalizeEntityId(opt.id) !== preferredNorm)
    : visibleOptions;
  $: selectedOption = allOptions.find((opt) => normalizeEntityId(opt.id) === normalizeEntityId(value)) ?? null;
  $: normalizedRawText = String(rawTextOverride || '').trim();
  $: rawTextLooksComplex = normalizedRawText.includes('?') || normalizedRawText.startsWith('http://') || normalizedRawText.startsWith('https://');
  $: shouldPreferRawText = Boolean(
    normalizedRawText
    && (
      rawTextLooksComplex
      || !selectedOption
      || normalizeEntityId(normalizedRawText) !== normalizeEntityId(value)
    )
  );

  // Handle selection
  function selectEntity(id: string) {
    value = id;
    inputValue = '';
    showDropdown = false;
    dispatch('change', { value: id, resolved: true, selected: true });
  }

  // Handle custom input with universal parsing
  function handleInputChange(e: Event) {
    const target = e.target as HTMLInputElement;
    inputValue = target.value;
    dispatch('textinput', { value: inputValue });

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
    if (!showDropdown) {
      dispatch('open');
    }
    showDropdown = true;
  }

  async function openPicker() {
    if (disabled) return;
    inputValue = '';
    if (!showDropdown) {
      dispatch('open');
    }
    showDropdown = true;
    await tick();
    inputRef?.focus();
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
  $: if (!showDropdown && normalizedRawText !== inputValue && (shouldPreferRawText || !value)) {
    inputValue = normalizedRawText;
  }
  $: closedSelectionVisible = Boolean(value && !showDropdown && selectedOption && !shouldPreferRawText && !alwaysShowInput);
  $: displayValue = shouldPreferRawText
    ? normalizedRawText
    : (value ? (selectedOption?.displayName || getDisplayName(value)) : normalizedRawText);
  $: selectedIsPreferred = selectedOption ? normalizeEntityId(selectedOption.id) === preferredNorm : false;
</script>

<div class="entity-input" class:disabled class:move-variant={variant === 'move'} class:open={showDropdown} data-testid={testId || undefined}>
  {#if label}
    <div class="input-label">{label}</div>
  {/if}

  <div class="input-wrapper">
    {#if closedSelectionVisible && selectedOption}
      <button
        class="closed-trigger"
        type="button"
        on:click={openPicker}
        {disabled}
      >
        {#if selectedOption.avatar}
          <img class="item-avatar" src={selectedOption.avatar} alt="" />
        {:else}
          <span class="item-avatar placeholder">?</span>
        {/if}
        <span class="item-meta">
          <span class="item-name-row">
            <span class="item-name">{selectedOption.displayName}</span>
            {#if selectedIsPreferred}
              <span class="item-badge">Self</span>
            {/if}
          </span>
          <span class="item-id">{getCompactEntityId(selectedOption.id)}</span>
        </span>
        <span class="closed-trigger-arrow" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </span>
      </button>
    {:else}
      <input
        id={inputId || undefined}
        class="entity-input-field"
        bind:this={inputRef}
        type="text"
        value={showDropdown ? inputValue : displayValue}
        {placeholder}
        aria-label={label || placeholder || 'Entity input'}
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
        aria-label={label ? `Open ${label} picker` : 'Open entity picker'}
        on:click={openPicker}
        {disabled}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    {/if}
  </div>

  {#if showDropdown && !disabled}
    <div class="dropdown">
      {#if pinnedOption}
        <div class="dropdown-section-label">Self</div>
        <button
          class="dropdown-item pinned"
          class:selected={pinnedOption.id === value}
          data-testid={optionTestId(pinnedOption.id)}
          on:mousedown|preventDefault={() => selectEntity(pinnedOption.id)}
        >
          {#if pinnedOption.avatar}
            <img class="item-avatar" src={pinnedOption.avatar} alt="" />
          {:else}
            <span class="item-avatar placeholder">?</span>
          {/if}
          <span class="item-meta">
            <span class="item-name-row">
              <span class="item-name">{pinnedOption.displayName}</span>
              <span class="item-badge">Self</span>
            </span>
            <span class="item-id">{getCompactEntityId(pinnedOption.id)}</span>
          </span>
        </button>
        {#if remainingOptions.length > 0}
          <div class="dropdown-divider"></div>
        {/if}
      {/if}

      {#if visibleOptions.length === 0}
        <div class="dropdown-empty">
          {inputValue ? 'No matches' : 'No entities available'}
        </div>
      {:else}
        {#if remainingOptions.length > 0}
          {#if pinnedOption}
            <div class="dropdown-section-label">Network</div>
          {/if}
        {/if}
        {#each remainingOptions as opt}
          <button
            class="dropdown-item"
            class:selected={opt.id === value}
            data-testid={optionTestId(opt.id)}
            on:mousedown|preventDefault={() => selectEntity(opt.id)}
          >
            {#if opt.avatar}
              <img class="item-avatar" src={opt.avatar} alt="" />
            {:else}
              <span class="item-avatar placeholder">?</span>
            {/if}
            <span class="dropdown-item-main">
              <span class="item-name">{opt.displayName}</span>
              <span class="item-id">{getCompactEntityId(opt.id)}</span>
            </span>
          </button>
        {/each}
      {/if}

      {#if !hideDropdownHint}
        <div class="dropdown-hint">
          #5 (numbered) · #ABCD (short) · @name · 0x... (full)
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .entity-input {
    --entity-accent: var(--theme-accent, #fbbf24);
    --entity-border: color-mix(in srgb, var(--theme-input-border, var(--theme-border, #27272a)) 84%, transparent);
    --entity-border-hover: color-mix(in srgb, var(--entity-accent) 42%, var(--entity-border));
    --entity-border-active: color-mix(in srgb, var(--entity-accent) 82%, transparent);
    --entity-surface: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, transparent);
    --entity-input-bg: color-mix(in srgb, var(--theme-input-bg, var(--theme-card-bg, #09090b)) 98%, transparent);
    --entity-elevated: color-mix(in srgb, var(--theme-surface-hover, var(--theme-card-bg, #1c1c20)) 94%, transparent);
    --entity-text: var(--theme-text-primary, #e4e4e7);
    --entity-text-secondary: var(--theme-text-secondary, #a1a1aa);
    --entity-text-muted: var(--theme-text-muted, #71717a);
    --entity-shadow: 0 18px 40px color-mix(in srgb, var(--theme-background, #09090b) 18%, transparent);
    --entity-radius: 12px;
    --entity-control-height: 50px;
    position: relative;
    width: 100%;
    min-width: 0;
    z-index: 0;
  }

  .entity-input.open {
    z-index: 120;
  }

  .entity-input.move-variant {
    --entity-radius: 14px;
    --entity-control-height: 54px;
    --entity-surface: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 96%, transparent);
    --entity-input-bg: color-mix(in srgb, var(--theme-input-bg, var(--theme-card-bg, #09090b)) 92%, transparent);
    --entity-shadow: 0 24px 48px color-mix(in srgb, var(--theme-background, #09090b) 16%, transparent);
  }

  .entity-input.disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .input-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--entity-text-muted) !important;
    margin-bottom: 8px;
    text-transform: none;
    letter-spacing: 0.01em;
  }

  .input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .entity-input-field {
    width: 100%;
    min-width: 0;
    min-height: var(--entity-control-height);
    padding: 13px 54px 13px 15px !important;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--entity-surface) 94%, transparent),
      color-mix(in srgb, var(--entity-input-bg) 100%, transparent)
    ) !important;
    border: 1px solid color-mix(in srgb, var(--entity-border) 92%, transparent) !important;
    border-radius: var(--entity-radius) !important;
    color: var(--entity-text) !important;
    font-size: 14px;
    font-family: inherit;
    line-height: 1.2;
    box-sizing: border-box;
    transition: border-color 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
  }

  .entity-input-field:focus {
    outline: none;
    border-color: var(--entity-border-active) !important;
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--entity-accent) 24%, transparent),
      0 12px 28px color-mix(in srgb, var(--theme-background, #09090b) 12%, transparent);
  }

  .entity-input-field::placeholder {
    color: var(--entity-text-muted) !important;
  }

  .selected-badge {
    position: absolute;
    right: 48px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--entity-accent);
    background: color-mix(in srgb, var(--entity-accent) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--entity-accent) 18%, transparent);
    padding: 3px 7px;
    border-radius: 999px;
  }

  .selected-badge.unresolved {
    color: color-mix(in srgb, var(--theme-debit, #f97316) 78%, white 22%);
    background: color-mix(in srgb, var(--theme-debit, #f97316) 12%, transparent);
    border: 1px dashed color-mix(in srgb, var(--theme-debit, #f97316) 38%, transparent);
  }

  .closed-trigger {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: var(--entity-control-height);
    min-width: 0;
    padding: 9px 14px !important;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--entity-surface) 96%, transparent),
      color-mix(in srgb, var(--entity-input-bg) 100%, transparent)
    ) !important;
    border: 1px solid color-mix(in srgb, var(--entity-border) 92%, transparent) !important;
    border-radius: var(--entity-radius) !important;
    color: var(--entity-text) !important;
    cursor: pointer;
    text-align: left;
    box-sizing: border-box;
    transition: border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
  }

  .closed-trigger:hover {
    border-color: var(--entity-border-hover) !important;
    box-shadow: 0 12px 26px color-mix(in srgb, var(--theme-background, #09090b) 12%, transparent);
    transform: translateY(-1px);
  }

  .closed-trigger:focus-visible {
    outline: none;
    border-color: var(--entity-border-active) !important;
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--entity-accent) 24%, transparent),
      0 12px 28px color-mix(in srgb, var(--theme-background, #09090b) 12%, transparent);
  }

  .closed-trigger-arrow {
    margin-left: auto;
    color: var(--entity-text-muted);
    flex-shrink: 0;
  }

  .dropdown-toggle {
    position: absolute;
    right: 8px;
    width: 34px;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--entity-surface) 72%, transparent) !important;
    border: 1px solid transparent !important;
    color: var(--entity-text-muted) !important;
    cursor: pointer;
    border-radius: 10px !important;
    transition: background 0.16s ease, color 0.16s ease, border-color 0.16s ease;
  }

  .dropdown-toggle:hover {
    background: color-mix(in srgb, var(--entity-elevated) 100%, transparent) !important;
    border-color: color-mix(in srgb, var(--entity-accent) 16%, transparent) !important;
    color: var(--entity-text-secondary) !important;
  }

  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 8px;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--entity-surface) 98%, transparent),
      color-mix(in srgb, var(--entity-input-bg) 100%, transparent)
    );
    border: 1px solid color-mix(in srgb, var(--entity-border) 96%, transparent);
    border-radius: calc(var(--entity-radius) + 2px);
    box-shadow: var(--entity-shadow);
    z-index: 100;
    max-height: 280px;
    overflow-y: auto;
    backdrop-filter: blur(14px);
  }

  .dropdown::-webkit-scrollbar {
    width: 4px;
  }

  .dropdown::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--entity-text-muted) 50%, transparent);
    border-radius: 2px;
  }

  .dropdown-empty {
    padding: 16px;
    text-align: center;
    color: var(--entity-text-muted);
    font-size: 13px;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-width: 0;
    padding: 12px 14px !important;
    background: transparent !important;
    border: none !important;
    border-radius: 0 !important;
    color: var(--entity-text) !important;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }

  .dropdown-item:hover {
    background: color-mix(in srgb, var(--entity-elevated) 90%, transparent) !important;
  }

  .dropdown-item.selected {
    background: color-mix(in srgb, var(--entity-accent) 10%, transparent) !important;
  }

  .dropdown-item.pinned {
    background: color-mix(in srgb, var(--entity-accent) 10%, transparent) !important;
  }

  .item-name {
    color: var(--entity-text);
    font-size: 12px;
    font-weight: 600;
    line-height: 1.2;
  }

  .item-name-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .item-id {
    color: var(--entity-text-muted);
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item-avatar {
    width: 18px;
    height: 18px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--entity-border) 90%, transparent);
    flex-shrink: 0;
  }

  .item-avatar.placeholder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--entity-elevated) 100%, transparent);
    color: var(--entity-text-secondary);
    font-size: 10px;
  }

  .item-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .dropdown-item-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-width: 0;
    width: 100%;
  }

  .item-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--theme-credit, #22c55e) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-credit, #22c55e) 18%, transparent);
    color: color-mix(in srgb, var(--theme-credit, #22c55e) 70%, white 30%);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .dropdown-section-label {
    padding: 8px 14px 6px;
    color: var(--entity-text-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.01em;
    text-transform: none;
  }

  .dropdown-divider {
    height: 1px;
    background: color-mix(in srgb, var(--entity-border) 92%, transparent);
    margin: 4px 0;
  }

  .dropdown-hint {
    padding: 8px 14px;
    border-top: 1px solid color-mix(in srgb, var(--entity-border) 92%, transparent);
    font-size: 11px;
    color: var(--entity-text-muted);
  }
</style>
