<script lang="ts">
  import { page } from '$app/stores';
  import { locale, LOCALES, type Locale } from '$lib/i18n';
  import DeltaVisualizer from './Tools/DeltaVisualizer.svelte';
  import Dropdown from '$lib/components/UI/Dropdown.svelte';

  interface Props {
    variant?: 'default' | 'transparent';
  }

  let { variant = 'default' }: Props = $props();

  // Highlight current page
  let currentPath = $derived($page.url.pathname);

  // Dropdown states
  let langDropdownOpen = $state(false);
  let toolsDropdownOpen = $state(false);
  let showDeltaVisualizer = $state(false);

  function selectLocale(loc: Locale) {
    locale.set(loc);
    langDropdownOpen = false;
  }

  function openTool(tool: string) {
    toolsDropdownOpen = false;
    if (tool === 'delta') {
      showDeltaVisualizer = true;
    }
  }
</script>

<nav class="topbar" class:transparent={variant === 'transparent'}>
  <div class="topbar-left">
    <a href="/" class="topbar-logo">
      <img src="/img/l.png" alt="xln" />
    </a>
    <span class="stage-badge">simnet</span>
  </div>

  <div class="topbar-links">
    <a href="/app" class="topbar-link" class:active={currentPath === '/app'}>App</a>
    <a href="/llms.txt" target="_blank" class="topbar-link llms-link">llms.txt</a>
    <div class="topbar-dropdown">
      <Dropdown bind:open={toolsDropdownOpen} minWidth={160} maxWidth={220}>
        <span slot="trigger" class="topbar-trigger">
          <span>Tools</span>
          <span class="topbar-chevron" class:open={toolsDropdownOpen}>▼</span>
        </span>
        <div slot="menu" class="topbar-menu">
          <button class="topbar-menu-item" onclick={() => openTool('delta')}>
            <span class="tool-icon">⚖️</span>
            <span class="tool-label">deriveDelta</span>
          </button>
        </div>
      </Dropdown>
    </div>
    <div class="topbar-dropdown">
      <Dropdown bind:open={langDropdownOpen} minWidth={160} maxWidth={220}>
        <span slot="trigger" class="topbar-trigger">
          <span class="lang-flag">{LOCALES[$locale].flag}</span>
          <span class="topbar-chevron" class:open={langDropdownOpen}>▼</span>
        </span>
        <div slot="menu" class="topbar-menu">
          {#each Object.entries(LOCALES) as [code, info]}
            <button
              class="topbar-menu-item"
              class:active={code === $locale}
              onclick={() => selectLocale(code as Locale)}
            >
              <span class="menu-flag">{info.flag}</span>
              <span class="menu-label">{info.name}</span>
            </button>
          {/each}
        </div>
      </Dropdown>
    </div>
  </div>
</nav>

{#if showDeltaVisualizer}
  <DeltaVisualizer onClose={() => showDeltaVisualizer = false} />
{/if}

<style>
  .topbar {
    height: 56px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 var(--space-3);
    background: var(--glass-bg);
    backdrop-filter: blur(var(--blur-md));
    -webkit-backdrop-filter: blur(var(--blur-md));
    border-bottom: 1px solid var(--glass-border);
    box-shadow: 0 1px 16px rgba(0, 0, 0, 0.2);
    position: sticky;
    top: 0;
    z-index: 1000;
  }

  .topbar.transparent {
    background: rgba(17, 25, 40, 0.65);
    backdrop-filter: blur(var(--blur-lg));
    -webkit-backdrop-filter: blur(var(--blur-lg));
  }

  .topbar-left {
    display: flex;
    align-items: center;
  }

  .topbar-logo {
    display: flex;
    align-items: center;
  }

  .topbar-logo img {
    height: 32px;
    width: auto;
  }

  .stage-badge {
    margin-left: 12px;
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 0.2rem 0.5rem;
    background: rgba(79, 209, 139, 0.15);
    border: 1px solid rgba(79, 209, 139, 0.3);
    border-radius: 4px;
    color: #4fd18b;
  }

  .topbar-links {
    display: flex;
    gap: 1.5rem;
    align-items: center;
  }

  .topbar-link {
    color: rgba(255, 255, 255, 0.8);
    text-decoration: none;
    font-size: 0.9rem;
    font-weight: 500;
    transition: color 0.2s ease;
  }

  .topbar-link:hover {
    color: #4fd18b;
  }

  .topbar-link.active {
    color: #4fd18b;
  }

  /* llms.txt link */
  .topbar-link.llms-link {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .topbar-dropdown {
    display: flex;
    align-items: center;
  }

  .topbar-dropdown :global(.dropdown-wrapper) {
    width: auto;
  }

  .topbar-dropdown :global(.dropdown-trigger) {
    padding: 6px 10px;
    border-radius: 8px;
  }

  .topbar-trigger {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.85);
  }

  .lang-flag {
    font-size: 1.05rem;
  }

  .topbar-chevron {
    font-size: 0.55rem;
    opacity: 0.6;
    transition: transform 0.2s;
  }

  .topbar-chevron.open {
    transform: rotate(180deg);
  }

  .topbar-menu {
    padding: 4px;
  }

  .topbar-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.85);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
  }

  .topbar-menu-item:hover {
    background: var(--dropdown-item-hover, rgba(255, 255, 255, 0.06));
    color: white;
  }

  .topbar-menu-item.active {
    background: var(--dropdown-selected, rgba(79, 209, 139, 0.15));
    color: #4fd18b;
  }

  .menu-flag {
    font-size: 1rem;
  }

  .menu-label {
    flex: 1;
  }

  .tool-icon {
    font-size: 1rem;
  }

  .tool-label {
    flex: 1;
    font-family: 'SF Mono', monospace;
  }

  @media (max-width: 768px) {
    .topbar {
      padding: 0.5rem 1rem;
    }

    .topbar-logo img {
      height: 28px;
    }

    .topbar-links {
      gap: 0.75rem;
    }

    .topbar-link {
      font-size: 0.75rem;
    }

    .stage-badge {
      display: none;
    }

    .topbar-dropdown :global(.dropdown-trigger) {
      padding: 5px 8px;
    }
  }
</style>
