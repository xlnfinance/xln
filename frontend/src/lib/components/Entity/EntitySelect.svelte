<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';

  export let value: string = '';
  export let options: string[] = [];
  export let placeholder: string = 'Select entity';

  const dispatch = createEventDispatcher();
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  const contextEnv = entityEnv?.env;
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
  $: activeEnv = contextEnv ? $contextEnv : $xlnEnvironment;

  let open = false;
  let copied = '';

  function normalizeEntityId(id: string | null | undefined): string {
    return String(id || '').trim().toLowerCase();
  }

  function getOptionName(id: string): string {
    const norm = normalizeEntityId(id);
    if (!norm) return id;
    const profiles = activeEnv?.gossip?.getProfiles?.() || [];
    const profile = profiles.find((p: any) => normalizeEntityId(p?.entityId) === norm);
    const profileName = String(profile?.metadata?.name || '').trim();
    return profileName || id;
  }

  $: optionViews = options.map((id) => ({
    id,
    name: getOptionName(id),
    avatarUrl: activeXlnFunctions?.generateEntityAvatar?.(id) || '',
  }));
  $: selectedOption = optionViews.find((opt) => opt.id === value) || null;

  function select(id: string) {
    value = id;
    open = false;
    dispatch('change', id);
  }

  function copy(e: MouseEvent, id: string) {
    e.stopPropagation();
    navigator.clipboard.writeText(id);
    copied = id;
    setTimeout(() => { if (copied === id) copied = ''; }, 1500);
  }

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.entity-select')) open = false;
  }
</script>

<svelte:window on:click={handleClickOutside} />

<div class="entity-select">
  <button class="es-trigger" class:open on:click|stopPropagation={() => open = !open}>
    {#if selectedOption}
      <span class="es-value-main">{selectedOption.name}</span>
      <span class="es-value-id">{selectedOption.id}</span>
    {:else}
      <span class="es-placeholder">{placeholder}</span>
    {/if}
    <span class="es-arrow" class:open>▼</span>
  </button>

  {#if open}
    <div class="es-panel" on:click|stopPropagation>
      {#each optionViews as option (option.id)}
        <div class="es-option" class:selected={option.id === value} on:click={() => select(option.id)} on:keydown={() => {}} role="option" aria-selected={option.id === value} tabindex="0">
          {#if option.avatarUrl}
            <img class="es-avatar" src={option.avatarUrl} alt="" />
          {:else}
            <span class="es-avatar placeholder">?</span>
          {/if}
          <span class="es-meta">
            <span class="es-name">{option.name}</span>
            <span class="es-id-full" title={option.id}>{option.id}</span>
          </span>
          <button class="es-copy" on:click={(e) => copy(e, option.id)} title="Copy full ID">
            {#if copied === option.id}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
            {:else}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            {/if}
          </button>
        </div>
      {/each}
      {#if optionViews.length === 0}
        <div class="es-empty">No accounts</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .entity-select {
    position: relative;
    min-width: 130px;
  }

  .es-trigger {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    row-gap: 2px;
    column-gap: 8px;
    width: 100%;
    padding: 9px 10px;
    background: #09090b;
    border: 1px solid #27272a;
    border-radius: 8px;
    color: #e4e4e7;
    font-size: 0.88em;
    font-family: 'JetBrains Mono', 'SF Mono', monospace;
    cursor: pointer;
    transition: border-color 0.15s;
  }

  .es-trigger:hover {
    border-color: #3f3f46;
  }

  .es-trigger.open {
    border-color: #fbbf24;
    box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.1);
  }

  .es-value-main {
    text-align: left;
    color: #e4e4e7;
    font-size: 12px;
    font-weight: 500;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .es-value-id {
    grid-column: 1;
    text-align: left;
    color: #71717a;
    font-size: 10px;
    font-family: 'JetBrains Mono', 'SF Mono', monospace;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .es-placeholder {
    grid-column: 1;
    text-align: left;
    color: #52525b;
  }

  .es-arrow {
    grid-column: 2;
    grid-row: 1 / span 2;
    font-size: 9px;
    color: #52525b;
    transition: transform 0.15s;
  }

  .es-arrow.open {
    transform: rotate(180deg);
  }

  .es-panel {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    min-width: 280px;
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 10px;
    padding: 4px;
    z-index: 50;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    max-height: 240px;
    overflow-y: auto;
  }

  .es-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: #e4e4e7;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.1s;
    text-align: left;
  }

  .es-option:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .es-option.selected {
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.2);
  }

  .es-avatar {
    width: 18px;
    height: 18px;
    border-radius: 4px;
    border: 1px solid #3f3f46;
    flex-shrink: 0;
  }

  .es-avatar.placeholder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: #a1a1aa;
    background: #27272a;
  }

  .es-meta {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .es-name {
    color: #e4e4e7;
    font-size: 12px;
    line-height: 1.2;
  }

  .es-id-full {
    font-family: 'JetBrains Mono', 'SF Mono', monospace;
    font-size: 10px;
    color: #52525b;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .es-copy {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: #52525b;
    cursor: pointer;
    flex-shrink: 0;
    transition: all 0.15s;
  }

  .es-copy:hover {
    color: #fbbf24;
    border-color: #3f3f46;
    background: rgba(251, 191, 36, 0.05);
  }

  .es-empty {
    padding: 12px;
    text-align: center;
    color: #52525b;
    font-size: 12px;
  }
</style>
