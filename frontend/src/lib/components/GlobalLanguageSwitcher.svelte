<script lang="ts">
  import { locale, LOCALES, type Locale } from '$lib/i18n';

  let isOpen = false;

  function selectLocale(loc: Locale) {
    locale.set(loc);
    isOpen = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') isOpen = false;
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- Fixed bottom-left corner -->
<div class="global-lang-switcher">
  <button class="current" on:click={() => isOpen = !isOpen}>
    <span class="flag">{LOCALES[$locale].flag}</span>
    <span class="code">{$locale.toUpperCase()}</span>
    <svg class="chevron" class:open={isOpen} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
    </svg>
  </button>

  {#if isOpen}
    <div class="dropdown">
      {#each Object.entries(LOCALES).filter(([code]) => ['en', 'ru'].includes(code)) as [code, info]}
        <button
          class="option"
          class:active={code === $locale}
          on:click={() => selectLocale(code as Locale)}
        >
          <span class="flag">{info.flag}</span>
          <span class="name">{info.name}</span>
          <span class="code-small">{code.toUpperCase()}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<!-- Click outside to close -->
{#if isOpen}
  <div class="backdrop" on:click={() => isOpen = false} on:keydown={() => {}} role="presentation"></div>
{/if}

<style>
  .global-lang-switcher {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 9999;
  }

  .current {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    background: rgba(20, 20, 30, 0.95);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
  }

  .current:hover {
    background: rgba(30, 30, 45, 0.98);
    border-color: rgba(255, 255, 255, 0.25);
    transform: translateY(-1px);
  }

  .flag {
    font-size: 18px;
  }

  .code {
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  .chevron {
    width: 14px;
    height: 14px;
    transition: transform 0.2s;
    opacity: 0.6;
  }

  .chevron.open {
    transform: rotate(180deg);
  }

  .dropdown {
    position: absolute;
    bottom: calc(100% + 8px);
    right: 0;
    min-width: 180px;
    background: rgba(20, 20, 30, 0.98);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    padding: 6px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
  }

  .option {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 12px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.7);
    font-size: 14px;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
  }

  .option:hover {
    background: rgba(255, 255, 255, 0.1);
    color: white;
  }

  .option.active {
    background: rgba(139, 92, 246, 0.25);
    color: white;
  }

  .option .flag {
    font-size: 18px;
  }

  .option .name {
    flex: 1;
    font-weight: 400;
  }

  .code-small {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    font-weight: 500;
  }

  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 9998;
  }
</style>
