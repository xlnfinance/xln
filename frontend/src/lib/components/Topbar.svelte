<script lang="ts">
  import { page } from '$app/stores';
  import { locale, LOCALES, type Locale } from '$lib/i18n';
  import DeltaVisualizer from './Tools/DeltaVisualizer.svelte';

  interface Props {
    variant?: 'default' | 'transparent';
  }

  let { variant = 'default' }: Props = $props();

  // Highlight current page
  let currentPath = $derived($page.url.pathname);

  // Dropdown states
  let aiDropdownOpen = $state(false);
  let toolsDropdownOpen = $state(false);
  let showDeltaVisualizer = $state(false);

  function selectLocale(loc: Locale) {
    locale.set(loc);
    aiDropdownOpen = false;
  }

  function openTool(tool: string) {
    toolsDropdownOpen = false;
    if (tool === 'delta') {
      showDeltaVisualizer = true;
    }
  }

  function handleClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.lang-dropdown')) {
      aiDropdownOpen = false;
    }
    if (!target.closest('.tools-dropdown')) {
      toolsDropdownOpen = false;
    }
  }
</script>

<svelte:window onclick={handleClickOutside} />

<nav class="topbar" class:transparent={variant === 'transparent'}>
  <div class="topbar-left">
    <a href="/" class="topbar-logo">
      <img src="/img/l.png" alt="xln" />
    </a>
    <span class="stage-badge">simnet</span>
  </div>

  <div class="topbar-links">
    <a href="/view" class="topbar-link" class:active={currentPath === '/view'}>View</a>
    <a href="/vault" class="topbar-link" class:active={currentPath === '/vault'}>Vault</a>
    <a href="/scenarios" class="topbar-link" class:active={currentPath === '/scenarios'}>Scenarios</a>
    <a href="/docs" class="topbar-link">Docs</a>
    <a href="https://github.com/xlnfinance/xln" target="_blank" rel="noopener noreferrer" class="topbar-link">GitHub</a>
    <a href="https://x.com/xlnfinance" target="_blank" rel="noopener noreferrer" class="topbar-link">X</a>
    <a href="https://t.me/xlnomist" target="_blank" rel="noopener noreferrer" class="topbar-link">Telegram</a>
    <a href="mailto:h@xln.finance" class="topbar-link">Contact</a>
    <a href="/llms.txt" target="_blank" class="topbar-link llms-link">llms.txt</a>
    <div class="tools-dropdown" class:open={toolsDropdownOpen}>
      <button
        class="tools-trigger"
        onclick={(e) => { e.stopPropagation(); toolsDropdownOpen = !toolsDropdownOpen; }}
      >
        <span>Tools</span>
        <span class="tools-chevron">▼</span>
      </button>
      {#if toolsDropdownOpen}
        <div class="tools-menu">
          <button class="tools-menu-item" onclick={() => openTool('delta')}>
            <span class="tool-icon">⚖️</span>
            <span class="tool-label">deriveDelta</span>
          </button>
        </div>
      {/if}
    </div>
    <div class="lang-dropdown" class:open={aiDropdownOpen}>
      <button
        class="lang-trigger"
        onclick={(e) => { e.stopPropagation(); aiDropdownOpen = !aiDropdownOpen; }}
      >
        <span class="lang-flag">{LOCALES[$locale].flag}</span>
        <span class="lang-chevron">▼</span>
      </button>
      {#if aiDropdownOpen}
        <div class="lang-menu">
          {#each Object.entries(LOCALES) as [code, info]}
            <button
              class="lang-menu-item"
              class:active={code === $locale}
              onclick={() => selectLocale(code as Locale)}
            >
              <span class="menu-flag">{info.flag}</span>
              <span class="menu-label">{info.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</nav>

{#if showDeltaVisualizer}
  <DeltaVisualizer onClose={() => showDeltaVisualizer = false} />
{/if}

<style>
  .topbar {
    height: 34px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 16px;
    background: #000;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .topbar.transparent {
    background: rgba(0, 0, 0, 0.8);
    backdrop-filter: blur(10px);
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
    height: 20px;
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

  /* Language Dropdown */
  .lang-dropdown {
    position: relative;
  }

  .lang-trigger {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3rem 0.5rem;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    color: white;
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .lang-trigger:hover {
    border-color: rgba(255, 255, 255, 0.3);
    background: rgba(255, 255, 255, 0.05);
  }

  .lang-dropdown.open .lang-trigger {
    border-color: rgba(79, 209, 139, 0.5);
  }

  .lang-flag {
    font-size: 1.1rem;
  }

  .lang-chevron {
    font-size: 0.5rem;
    opacity: 0.5;
    transition: transform 0.2s;
  }

  .lang-dropdown.open .lang-chevron {
    transform: rotate(180deg);
  }

  .lang-menu {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    min-width: 150px;
    background: rgba(10, 10, 15, 0.98);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    padding: 4px;
    z-index: 200;
    backdrop-filter: blur(20px);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  .lang-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.8);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
  }

  .lang-menu-item:hover {
    background: rgba(255, 255, 255, 0.06);
    color: white;
  }

  .lang-menu-item.active {
    background: rgba(79, 209, 139, 0.15);
    color: #4fd18b;
  }

  .menu-flag {
    font-size: 1rem;
  }

  .menu-label {
    flex: 1;
  }

  /* Tools Dropdown */
  .tools-dropdown {
    position: relative;
  }

  .tools-trigger {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3rem 0.6rem;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.8);
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .tools-trigger:hover {
    border-color: rgba(255, 255, 255, 0.3);
    background: rgba(255, 255, 255, 0.05);
  }

  .tools-dropdown.open .tools-trigger {
    border-color: rgba(79, 209, 139, 0.5);
    color: #4fd18b;
  }

  .tools-chevron {
    font-size: 0.5rem;
    opacity: 0.5;
    transition: transform 0.2s;
  }

  .tools-dropdown.open .tools-chevron {
    transform: rotate(180deg);
  }

  .tools-menu {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    min-width: 160px;
    background: rgba(10, 10, 15, 0.98);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    padding: 4px;
    z-index: 200;
    backdrop-filter: blur(20px);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  .tools-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.8);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
  }

  .tools-menu-item:hover {
    background: rgba(255, 255, 255, 0.06);
    color: white;
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

    .ai-trigger {
      padding: 0.3rem 0.6rem;
      font-size: 0.75rem;
    }
  }
</style>
