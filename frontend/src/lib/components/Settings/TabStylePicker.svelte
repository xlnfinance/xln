<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { UITabStyle } from '$lib/types/ui';
  import type { UITabStyleOption } from '$lib/utils/ui-style-options';

  export let value: UITabStyle;
  export let options: UITabStyleOption[] = [];

  const dispatch = createEventDispatcher<{ change: UITabStyle }>();

  function select(next: UITabStyle): void {
    dispatch('change', next);
  }
</script>

<div class="tab-style-grid" role="list" aria-label="Tab group styles">
  {#each options as option}
    <button
      type="button"
      class="tab-style-card"
      class:active={value === option.value}
      data-style={option.value}
      aria-pressed={value === option.value}
      on:click={() => select(option.value)}
    >
      <div class="tab-style-preview" aria-hidden="true">
        <div class="preview-rail">
          <span class="preview-tab active">Assets</span>
          <span class="preview-tab">Accounts</span>
          <span class="preview-tab">Settings</span>
        </div>
      </div>
      <div class="tab-style-copy">
        <span class="tab-style-label">{option.label}</span>
        <span class="tab-style-description">{option.description}</span>
      </div>
    </button>
  {/each}
</div>

<style>
  .tab-style-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 12px;
  }

  .tab-style-card {
    display: grid;
    gap: 12px;
    width: 100%;
    padding: 14px;
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.12)) var(--ui-border-mix, 56%), transparent);
    border-radius: var(--ui-radius-large, 16px);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 38%, transparent), transparent 52%),
      color-mix(in srgb, var(--theme-surface, #18181b) var(--ui-card-fill-mix, 88%), transparent);
    color: var(--theme-text-primary, #e4e4e7);
    text-align: left;
    cursor: pointer;
    box-sizing: border-box;
    transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
  }

  .tab-style-card:hover {
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 18%, transparent);
  }

  .tab-style-card.active {
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) var(--ui-accent-border-mix, 22%), transparent);
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--theme-accent, #fbbf24) 16%, transparent),
      0 14px 28px color-mix(in srgb, var(--theme-background, #09090b) 10%, transparent);
  }

  .tab-style-preview {
    min-height: 72px;
    padding: 12px;
    border-radius: calc(var(--ui-radius-base, 12px) + 2px);
    background: color-mix(in srgb, var(--theme-background, #09090b) 64%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.08)) 42%, transparent);
    box-sizing: border-box;
  }

  .preview-rail {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    height: 100%;
  }

  .preview-tab {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    min-height: 30px;
    padding: 0 10px;
    border-radius: 10px;
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.62));
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.03em;
    white-space: nowrap;
    box-sizing: border-box;
  }

  .preview-tab.active {
    color: var(--theme-text-primary, #e4e4e7);
  }

  .tab-style-copy {
    display: grid;
    gap: 4px;
  }

  .tab-style-label {
    font-size: calc(13px * var(--ui-font-scale, 1));
    font-weight: 700;
  }

  .tab-style-description {
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.68));
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1.4;
  }

  .tab-style-card[data-style='minimal'] .preview-rail {
    gap: 14px;
    align-items: flex-start;
    border-bottom: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.1)) 56%, transparent);
  }

  .tab-style-card[data-style='minimal'] .preview-tab {
    padding: 0 0 8px;
    min-height: 24px;
    border-radius: 0;
  }

  .tab-style-card[data-style='minimal'] .preview-tab.active::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 1px;
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 88%, transparent);
  }

  .tab-style-card[data-style='underline'] .preview-rail {
    gap: 14px;
    align-items: flex-start;
    border-bottom: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.1)) 64%, transparent);
  }

  .tab-style-card[data-style='underline'] .preview-tab {
    padding: 0 2px 10px;
    min-height: 24px;
    border-radius: 0;
  }

  .tab-style-card[data-style='underline'] .preview-tab.active::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 90%, transparent);
  }

  .tab-style-card[data-style='rail'] .preview-rail {
    gap: 6px;
    padding: 4px;
    border-radius: 14px;
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.08)) 54%, transparent);
    background: color-mix(in srgb, var(--theme-surface, #18181b) 72%, transparent);
  }

  .tab-style-card[data-style='rail'] .preview-tab.active {
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 94%, transparent);
    box-shadow:
      inset 0 -1px 0 color-mix(in srgb, var(--theme-accent, #fbbf24) 86%, transparent),
      0 1px 0 color-mix(in srgb, white 4%, transparent);
  }

  .tab-style-card[data-style='pill'] .preview-tab {
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.08)) 58%, transparent);
    background: color-mix(in srgb, var(--theme-surface, #18181b) 74%, transparent);
  }

  .tab-style-card[data-style='pill'] .preview-tab.active {
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 24%, transparent);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 12%, transparent);
  }

  .tab-style-card[data-style='segmented'] .preview-rail {
    gap: 4px;
    padding: 4px;
    border-radius: 14px;
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.08)) 56%, transparent);
    background: color-mix(in srgb, var(--theme-surface, #18181b) 76%, transparent);
  }

  .tab-style-card[data-style='segmented'] .preview-tab {
    flex: 1 1 0;
  }

  .tab-style-card[data-style='segmented'] .preview-tab.active {
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 96%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--theme-accent, #fbbf24) 22%, transparent);
  }

  .tab-style-card[data-style='floating'] .preview-rail {
    gap: 8px;
  }

  .tab-style-card[data-style='floating'] .preview-tab {
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.08)) 58%, transparent);
    background: color-mix(in srgb, var(--theme-surface, #18181b) 70%, transparent);
    box-shadow: 0 8px 18px color-mix(in srgb, var(--theme-background, #09090b) 8%, transparent);
  }

  .tab-style-card[data-style='floating'] .preview-tab.active {
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 20%, transparent);
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 92%, transparent);
  }

  @media (max-width: 640px) {
    .tab-style-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
