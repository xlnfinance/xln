<script lang="ts">
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';

  export let title: string;
  export let collapsed: boolean = true;

  function toggle() {
    collapsed = !collapsed;
  }
</script>

<div class="collapsible">
  <button class="collapsible-header" on:click={toggle}>
    <h2>{title}</h2>
    <span class="toggle-icon" class:collapsed>
      {collapsed ? '▼' : '▲'}
    </span>
  </button>

  {#if !collapsed}
    <div class="collapsible-content" transition:slide={{ duration: 400, easing: quintOut }}>
      <slot />
    </div>
  {/if}
</div>

<style>
  .collapsible {
    width: 100%;
    margin: 2rem 0;
  }

  .collapsible-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.5rem 2rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
    color: inherit;
    font-family: inherit;
  }

  .collapsible-header:hover {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .collapsible-header h2 {
    margin: 0;
    font-size: 1.3rem;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
  }

  .toggle-icon {
    font-size: 1rem;
    color: rgba(255, 255, 255, 0.5);
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .toggle-icon.collapsed {
    transform: rotate(0deg);
  }

  .collapsible-content {
    margin-top: 1rem;
    overflow: hidden;
  }

  /* Light mode overrides */
  :global(.light-mode) .collapsible-header {
    background: rgba(0, 0, 0, 0.03);
    border-color: rgba(0, 0, 0, 0.1);
  }

  :global(.light-mode) .collapsible-header:hover {
    background: rgba(0, 0, 0, 0.05);
    border-color: rgba(0, 0, 0, 0.2);
  }

  :global(.light-mode) .collapsible-header h2 {
    color: rgba(0, 0, 0, 0.9);
  }

  :global(.light-mode) .toggle-icon {
    color: rgba(0, 0, 0, 0.5);
  }
</style>
