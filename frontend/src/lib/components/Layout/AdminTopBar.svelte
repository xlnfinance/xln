<script lang="ts">
  import { viewMode, viewModeOperations, type ViewMode } from '../../stores/viewModeStore';
  import { translations$ } from '$lib/i18n';
  
  $: t = $translations$;

  // Dynamic tabs with i18n - keys map to nav.* translations
  const viewTabsConfig: Array<{ mode: ViewMode; icon: string; labelKey: string; titleKey: string }> = [
    { mode: 'home', icon: '🏠', labelKey: 'nav.home', titleKey: 'nav.home' },
    { mode: 'settings', icon: '⚙️', labelKey: 'nav.settings', titleKey: 'nav.settings' },
    { mode: 'docs', icon: '📚', labelKey: 'nav.docs', titleKey: 'nav.docs' },
    { mode: 'brainvault', icon: '🧠', labelKey: 'nav.vault', titleKey: 'nav.vault' },
    { mode: 'graph3d', icon: '🗺️', labelKey: 'view.title', titleKey: 'view.title' },
    { mode: 'panels', icon: '📊', labelKey: 'nav.panels', titleKey: 'nav.panels' },
    { mode: 'terminal', icon: '💻', labelKey: 'nav.terminal', titleKey: 'nav.terminal' }
  ];

  $: activeView = $viewMode;

  function handleChangeView(mode: ViewMode) {
    if (activeView !== mode) {
      viewModeOperations.set(mode);
    }
  }
</script>

<div class="admin-topbar">
  <div class="admin-logo">
    <span class="logo-text">xln</span>
    <div class="view-switcher">
      {#each viewTabsConfig as tab}
        <button
          class="view-switch-btn"
          class:active={activeView === tab.mode}
          on:click={() => handleChangeView(tab.mode)}
          title={t(tab.titleKey)}
        >
          <span class="view-icon">{tab.icon}</span>
          <span class="view-label">{t(tab.labelKey)}</span>
        </button>
      {/each}
    </div>
  </div>
  <div class="topbar-actions">
    <!-- LanguageSwitcher moved to bottom corner (GlobalLanguageSwitcher.svelte) -->
  </div>
</div>

<style>
  .admin-topbar {
    background: rgba(20, 20, 20, 0.95);
    backdrop-filter: blur(20px);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .admin-logo {
    display: flex;
    align-items: center;
    gap: 16px;
    flex: 1;
  }

  .logo-text {
    font-family: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
    font-size: 20px;
    font-weight: 400;
    color: #ffffff;
    letter-spacing: 0.5px;
    text-transform: lowercase;
  }

  /* Liquid Glass Morphism View Switcher */
  .view-switcher {
    display: flex;
    gap: 4px;
    margin-left: 16px;
    padding: 4px;
    background: rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow:
      0 4px 24px rgba(0, 0, 0, 0.2),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }

  .view-switch-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    font-size: 13px;
    font-weight: 500;
    position: relative;
    overflow: hidden;
  }

  .view-switch-btn::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(0, 122, 204, 0) 0%, rgba(0, 122, 204, 0.1) 100%);
    opacity: 0;
    transition: opacity 0.3s ease;
  }

  .view-switch-btn:hover::before {
    opacity: 1;
  }

  .view-switch-btn:hover {
    color: rgba(255, 255, 255, 0.8);
  }

  .view-switch-btn.active {
    background: linear-gradient(135deg, rgba(0, 122, 204, 0.2) 0%, rgba(0, 180, 255, 0.15) 100%);
    color: #00ccff;
    box-shadow:
      0 2px 12px rgba(0, 122, 204, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }

  .view-switch-btn.active::before {
    opacity: 0;
  }

  .view-icon {
    font-size: 16px;
    line-height: 1;
  }

  .view-label {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.3px;
  }

  .topbar-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-left: auto;
  }
</style>
