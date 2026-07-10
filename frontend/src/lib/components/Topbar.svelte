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
  let currentPath = $derived(String($page.url.pathname));

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
    <a href="/docs" class="topbar-link" class:active={currentPath === '/docs'}>Docs</a>
    <a href="/releases" class="topbar-link" class:active={currentPath === '/releases'}>Releases</a>
    <a href="/rcpan" class="topbar-link" class:active={currentPath === '/rcpan'}>RCPAN</a>
    <div class="topbar-dropdown tools-dropdown">
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
    --topbar-accent: var(--theme-collateral, #4fd18b);
    --dropdown-bg: var(--theme-glass-bg, var(--glass-bg, rgba(17, 25, 40, 0.75)));
    --dropdown-bg-hover: var(--theme-surface-hover, var(--glass-bg-hover, rgba(17, 25, 40, 0.85)));
    --dropdown-menu-bg: color-mix(
      in srgb,
      var(--theme-card-bg, rgba(12, 18, 28, 0.95)) 96%,
      transparent
    );
    --dropdown-border: var(--theme-glass-border, var(--glass-border, rgba(255, 255, 255, 0.125)));
    --dropdown-border-hover: color-mix(in srgb, var(--theme-text-primary, white) 20%, transparent);
    --dropdown-text: var(--theme-text-primary, rgba(255, 255, 255, 0.95));
    --dropdown-item-hover: var(--theme-surface-hover, rgba(255, 255, 255, 0.06));
    --dropdown-selected: color-mix(in srgb, var(--topbar-accent) 15%, transparent);
    height: 56px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 var(--space-3);
    background: var(--theme-glass-bg, var(--glass-bg, rgba(17, 25, 40, 0.75)));
    backdrop-filter: blur(var(--blur-md));
    -webkit-backdrop-filter: blur(var(--blur-md));
    border-bottom: 1px solid var(--theme-glass-border, var(--glass-border, rgba(255, 255, 255, 0.125)));
    box-shadow: 0 1px 16px color-mix(in srgb, var(--theme-background, #000) 20%, transparent);
    position: sticky;
    top: 0;
    z-index: 1000;
  }

  .topbar.transparent {
    background: color-mix(
      in srgb,
      var(--theme-glass-bg, rgba(17, 25, 40, 0.75)) 86%,
      transparent
    );
    backdrop-filter: blur(var(--blur-lg));
    -webkit-backdrop-filter: blur(var(--blur-lg));
  }

  .topbar-left {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    min-width: 0;
  }

  .topbar-logo {
    display: flex;
    align-items: center;
  }

  .topbar-logo img {
    height: 32px;
    width: auto;
  }

  :global(html[data-theme='light']) .topbar-logo img,
  :global(html[data-theme='merchant']) .topbar-logo img {
    filter: invert(1);
  }

  .stage-badge {
    margin-left: 12px;
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 0.2rem 0.5rem;
    background: color-mix(in srgb, var(--topbar-accent) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--topbar-accent) 30%, transparent);
    border-radius: 4px;
    color: var(--topbar-accent);
  }

  .topbar-links {
    display: flex;
    gap: 1.5rem;
    align-items: center;
    min-width: 0;
    white-space: nowrap;
  }

  .topbar-link {
    color: color-mix(in srgb, var(--theme-text-primary, white) 80%, transparent);
    text-decoration: none;
    font-size: 0.9rem;
    font-weight: 500;
    transition: color 0.2s ease;
  }

  .topbar-link:hover {
    color: var(--topbar-accent);
  }

  .topbar-link.active {
    color: var(--topbar-accent);
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
    color: color-mix(in srgb, var(--theme-text-primary, white) 85%, transparent);
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
    color: color-mix(in srgb, var(--theme-text-primary, white) 85%, transparent);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
  }

  .topbar-menu-item:hover {
    background: var(--dropdown-item-hover, rgba(255, 255, 255, 0.06));
    color: var(--theme-text-primary, white);
  }

  .topbar-menu-item.active {
    background: var(--dropdown-selected, rgba(79, 209, 139, 0.15));
    color: var(--topbar-accent);
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
      padding: 0 1rem;
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

  @media (max-width: 520px) {
    .tools-dropdown {
      display: none;
    }

    .topbar-links {
      gap: 0.625rem;
    }
  }

  @media (max-width: 360px) {
    .topbar {
      padding-inline: 0.625rem;
    }

    .topbar-logo img {
      height: 26px;
    }

    .topbar-links {
      gap: 0.45rem;
    }

    .topbar-dropdown :global(.dropdown-trigger) {
      padding-inline: 5px;
    }
  }
</style>
