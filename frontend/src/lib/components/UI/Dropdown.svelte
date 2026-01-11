<script lang="ts" context="module">
  import { writable } from 'svelte/store';

  // Global: only one dropdown open at a time
  export const activeDropdownId = writable<string | null>(null);

  let idCounter = 0;
  export function generateDropdownId(): string {
    return `dropdown-${++idCounter}`;
  }
</script>

<script lang="ts">
  import { tick, createEventDispatcher, onDestroy } from 'svelte';

  // Props
  export let open = false;
  export let id = generateDropdownId();
  export let minWidth = 200;
  export let maxWidth = 420;
  export let disabled = false;

  const dispatch = createEventDispatcher();

  let triggerEl: HTMLButtonElement;
  let menuEl: HTMLDivElement;

  // Position state
  let top = 0;
  let left = 0;
  let width = minWidth;

  // Subscribe to global active dropdown - close if another opens
  $: if ($activeDropdownId && $activeDropdownId !== id && open) {
    open = false;
  }

  // Clear active id when closed via bind:open or external updates
  $: if (!open && $activeDropdownId === id) {
    activeDropdownId.set(null);
  }

  // When opening, set as active and position
  $: if (open) {
    activeDropdownId.set(id);
    tick().then(updatePosition);
  }

  function updatePosition() {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    top = rect.bottom + 4;
    left = rect.left;
    const cap = maxWidth > 0 ? Math.max(minWidth, maxWidth) : minWidth;
    width = Math.min(Math.max(rect.width, minWidth), cap);

    // Clamp to viewport after menu renders
    tick().then(() => {
      if (!menuEl) return;
      const menuRect = menuEl.getBoundingClientRect();
      let nextLeft = left;
      let nextTop = top;

      if (nextLeft + menuRect.width > window.innerWidth - 8) {
        nextLeft = window.innerWidth - menuRect.width - 8;
      }
      if (nextTop + menuRect.height > window.innerHeight - 8) {
        nextTop = rect.top - menuRect.height - 4;
      }

      left = Math.max(8, nextLeft);
      top = Math.max(8, nextTop);
    });
  }

  export function toggle() {
    open = !open;
    dispatch('toggle', { open });
  }

  export function close() {
    open = false;
    activeDropdownId.set(null);
    dispatch('close');
  }

  function handleTriggerClick(e: MouseEvent) {
    e.stopPropagation();
    if (disabled) return;
    toggle();
  }

  function handleClickOutside(e: MouseEvent) {
    if (!open) return;
    const target = e.target as HTMLElement;
    if (triggerEl?.contains(target)) return;
    if (menuEl?.contains(target)) return;
    close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      close();
      triggerEl?.focus();
    }
  }

  onDestroy(() => {
    if ($activeDropdownId === id) {
      activeDropdownId.set(null);
    }
  });
</script>

<svelte:window on:click={handleClickOutside} on:keydown={handleKeydown} />

<div class="dropdown-wrapper">
  <!-- Trigger button -->
  <button
    bind:this={triggerEl}
    class="dropdown-trigger"
    on:click={handleTriggerClick}
    aria-expanded={open}
    aria-haspopup="true"
    disabled={disabled}
    aria-disabled={disabled}
  >
    <slot name="trigger" />
  </button>

  <!-- Menu (fixed position) -->
  {#if open}
    <div
      bind:this={menuEl}
      class="dropdown-menu"
      style="
        top: {top}px;
        left: {left}px;
        min-width: {width}px;
        max-width: {maxWidth}px;
      "
      role="menu"
    >
      <slot name="menu" />
    </div>
  {/if}
</div>

<style>
  .dropdown-wrapper {
    display: inline-block;
    width: 100%;
    position: relative;
  }

  .dropdown-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: var(--dropdown-bg, var(--glass-bg, rgba(17, 25, 40, 0.75)));
    border: 1px solid var(--dropdown-border, var(--glass-border, rgba(255, 255, 255, 0.125)));
    border-radius: var(--dropdown-radius, 8px);
    color: var(--dropdown-text, var(--text-primary, rgba(255, 255, 255, 0.95)));
    font-size: 14px;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
    backdrop-filter: blur(var(--blur-sm, 16px));
  }

  .dropdown-trigger:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .dropdown-trigger:hover {
    background: var(--dropdown-bg-hover, var(--glass-bg-hover, rgba(17, 25, 40, 0.85)));
    border-color: var(--dropdown-border-hover, rgba(255, 255, 255, 0.2));
  }

  .dropdown-menu {
    position: fixed;
    z-index: 9999;
    background: var(--dropdown-menu-bg, rgba(12, 18, 28, 0.95));
    border: 1px solid var(--dropdown-border, var(--glass-border, rgba(255, 255, 255, 0.125)));
    border-radius: var(--dropdown-radius, 8px);
    box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.4));
    max-height: 60vh;
    overflow-y: auto;
    animation: dropdown-fade 0.05s ease-out;
    backdrop-filter: blur(var(--blur-sm, 16px));
  }

  @keyframes dropdown-fade {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Scrollbar */
  .dropdown-menu::-webkit-scrollbar {
    width: 6px;
  }
  .dropdown-menu::-webkit-scrollbar-track {
    background: transparent;
  }
  .dropdown-menu::-webkit-scrollbar-thumb {
    background: #444;
    border-radius: 3px;
  }
  .dropdown-menu::-webkit-scrollbar-thumb:hover {
    background: #555;
  }
</style>
