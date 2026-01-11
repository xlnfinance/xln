<script lang="ts">
  import { locale, LOCALES, type Locale } from '$lib/i18n';
  import Dropdown from '$lib/components/UI/Dropdown.svelte';

  let isOpen = false;

  function selectLocale(loc: Locale) {
    locale.set(loc);
    isOpen = false;
  }
</script>
<div class="language-switcher">
  <Dropdown bind:open={isOpen} minWidth={180} maxWidth={240}>
    <span slot="trigger" class="trigger-content">
      <span class="flag">{LOCALES[$locale].flag}</span>
      <span class="code">{$locale.toUpperCase()}</span>
      <span class="chevron" class:open={isOpen}>▼</span>
    </span>
    <div slot="menu" class="menu-content">
      {#each Object.entries(LOCALES) as [code, info]}
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
  </Dropdown>
</div>

<style>
  .language-switcher {
    position: relative;
    z-index: 100;
  }

  .language-switcher :global(.dropdown-wrapper) {
    width: auto;
  }

  .trigger-content {
    display: flex;
    align-items: center;
    gap: 6px;
    color: rgba(255, 255, 255, 0.8);
    font-size: 13px;
  }

  .flag {
    font-size: 16px;
  }

  .code {
    font-weight: 500;
    letter-spacing: 0.5px;
  }

  .chevron {
    font-size: 10px;
    transition: transform 0.2s;
  }

  .chevron.open {
    transform: rotate(180deg);
  }

  .menu-content {
    padding: 4px;
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
    background: var(--dropdown-item-hover, rgba(255, 255, 255, 0.1));
    color: white;
  }

  .option.active {
    background: var(--dropdown-selected, rgba(139, 92, 246, 0.2));
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

</style>
