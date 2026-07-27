<script lang="ts">
  export let panelId: string;
</script>

<div class="entity-panel" data-panel-id={panelId}>
  <slot />
</div>

<style>
  .entity-panel {
    --space-1: 8px;
    --space-2: 12px;
    --space-3: 16px;
    --space-4: 20px;
    --panel-gutter-x: 16px;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 1220px;
    min-height: 0;
    height: auto;
    margin: 0 auto;
    padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
    background: transparent;
    color: var(--theme-text-primary, #e4e4e7);
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: 13px;
    box-sizing: border-box;
  }

  .entity-panel :global(.main-scroll) {
    display: contents;
  }

  .entity-panel :global(.content) {
    padding: var(--space-3) var(--panel-gutter-x);
    min-width: 0;
  }

  .entity-panel :global(.content input:not([type="range"]):not([type="checkbox"]):not(.entity-input-field):not(.move-amount-input):not(.move-external-input):not(.v2-amount):not(.v2-rate-input)),
  .entity-panel :global(.content select:not(.move-token-select):not(.v2-native)) {
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 88%, transparent) !important;
    border: 1px solid color-mix(in srgb, var(--theme-input-border, #27272a) 82%, transparent) !important;
    border-radius: 6px !important;
    color: var(--theme-text-primary, #e4e4e7) !important;
    padding: 10px 12px !important;
    font-size: 13px !important;
  }

  .entity-panel :global(.content input:not([type="range"]):not([type="checkbox"]):not(.v2-amount):not(.v2-rate-input):focus),
  .entity-panel :global(.content select:not(.v2-native):focus) {
    outline: none !important;
    border-color: var(--theme-input-focus, #fbbf24) !important;
  }

  .entity-panel :global(.content input::placeholder) {
    color: var(--theme-text-muted, #71717a) !important;
  }

  .entity-panel :global(.content button:not(.tab):not(.toggle):not(.back-btn):not(.btn-add):not(.btn-live):not(.c-delete):not(.account-workspace-tab):not(.configure-tab):not(.btn-add-token):not(.scope-btn):not(.primary-btn):not(.cancel-btn):not(.summary-action):not(.summary-action-inline):not(.delta-capacity-bar):not(.delta-faucet):not(.delta-expand):not(.step-btn):not(.step-auto-btn):not(.move-node):not(.move-primary-cta):not(.refresh-btn):not(.hub-primary):not(.btn-connect):not(.expand-toggle):not(.closed-trigger):not(.dropdown-toggle):not(.dropdown-item):not(.settings-tab):not(.compact-btn):not(.pill):not(.theme-swatch):not(.icon-btn):not(.danger-icon):not(.close-btn):not(.file-btn):not(.danger-btn):not(.btn-table-action):not(.wallet-meta-copy)) {
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent) !important;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent) !important;
    border-radius: 6px !important;
    color: var(--theme-text-secondary, #a1a1aa) !important;
    padding: 10px 14px !important;
    font-size: 12px !important;
    cursor: pointer !important;
  }

  .entity-panel :global(.content h3),
  .entity-panel :global(.content h4),
  .entity-panel :global(.content label) {
    color: var(--theme-text-secondary, #a1a1aa) !important;
  }

  @media (max-width: 900px) {
    .entity-panel {
      --panel-gutter-x: 10px;
      --space-2: 10px;
      --space-3: 12px;
    }

    .entity-panel :global(.content) {
      padding: 12px var(--panel-gutter-x);
      width: 100%;
      max-width: 100%;
      min-width: 0;
      overflow-x: clip;
      box-sizing: border-box;
    }
  }
</style>
