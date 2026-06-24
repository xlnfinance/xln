<script lang="ts">
  import type { ComponentType } from 'svelte';
  import { Check, Copy } from 'lucide-svelte';
  import type { FrontendXlnFunctions } from '$lib/stores/xlnStore';
  import type { Tab } from '$lib/types/ui';
  import ContextSwitcher from './ContextSwitcher.svelte';
  import type { ViewTab } from './entity-panel-routing';

  type JurisdictionBadge = {
    className: string;
    title: string;
    symbol: string;
  };

  type TopTab = {
    id: ViewTab;
    icon: ComponentType;
    label: string;
    showBadge?: boolean;
    badgeType?: 'pending';
  };

  export let tab: Tab;
  export let userModeHeader = false;
  export let avatar = '';
  export let activeXlnFunctions: FrontendXlnFunctions | null = null;
  export let entityJurisdictionBadge: JurisdictionBadge | null = null;
  export let heroDisplayName = '';
  export let allowHeaderAddRuntime = false;
  export let allowHeaderDeleteRuntime = false;
  export let headerRuntimeAddLabel = '+ Add Runtime';
  export let currentEntityValue = '';
  export let copiedMetaField = '';
  export let netWorth = 0;
  export let tabs: TopTab[] = [];
  export let activeTab: ViewTab = 'assets';
  export let pendingBatchCount = 0;
  export let formatUsdExact: (value: number) => string;
  export let copyMetaValue: (value: string, field: 'entity' | 'external') => void | Promise<void>;
  export let selectTopLevelTab: (tab: ViewTab) => void;
  export let handleHeaderAddRuntime: () => void;
  export let handleHeaderDeleteRuntime: (event: CustomEvent<{ runtimeId: string }>) => void;
  export let handleHeaderAddJurisdiction: () => void;
  export let handleHeaderAddEntity: () => void;
  export let handleEntitySelect: (event: CustomEvent) => void;
</script>

<section class="hero">
  <div class="hero-left" class:user-mode={userModeHeader}>
    {#if !userModeHeader}
      <div class="hero-avatar-wrap">
        {#if avatar}
          <img src={avatar} alt="Entity avatar" class="hero-avatar" />
        {:else}
          <div class="hero-avatar placeholder">
            {activeXlnFunctions?.getEntityShortId?.(tab.entityId)?.slice(0, 2) || '??'}
          </div>
        {/if}
        {#if entityJurisdictionBadge}
          <span
            class={`jurisdiction-avatar-badge ${entityJurisdictionBadge.className}`}
            title={entityJurisdictionBadge.title}
            aria-label={entityJurisdictionBadge.title}
          >
            {entityJurisdictionBadge.symbol}
          </span>
        {/if}
      </div>
    {/if}
    <div class="hero-identity" class:user-mode={userModeHeader}>
      {#if userModeHeader}
        <div class="hero-context-switcher">
          <ContextSwitcher
            {tab}
            allowAddRuntime={allowHeaderAddRuntime}
            allowDeleteRuntime={allowHeaderDeleteRuntime}
            allowAddJurisdiction={true}
            allowAddEntity={true}
            addRuntimeLabel={headerRuntimeAddLabel}
            on:addRuntime={handleHeaderAddRuntime}
            on:deleteRuntime={handleHeaderDeleteRuntime}
            on:addJurisdiction={handleHeaderAddJurisdiction}
            on:addEntity={handleHeaderAddEntity}
            on:entitySelect={handleEntitySelect}
          />
        </div>
      {:else}
        <span class="hero-name">{heroDisplayName}</span>
      {/if}
      <div class="wallet-meta-block hero-meta-block">
        <p class="muted wallet-label">Entity</p>
        <button
          class="wallet-meta-copy"
          type="button"
          title="Copy entity id"
          on:click={() => copyMetaValue(currentEntityValue, 'entity')}
        >
          <span class="wallet-meta-value">{currentEntityValue}</span>
          {#if copiedMetaField === 'entity'}
            <Check size={12} />
          {:else}
            <Copy size={12} />
          {/if}
        </button>
      </div>
    </div>
  </div>
  <div class="hero-right">
    <div class="hero-networth">{formatUsdExact(netWorth)}</div>
    <div class="hero-label">Net Worth</div>
  </div>
</section>

<nav class="tabs">
  {#each tabs as item}
    <button
      class="tab"
      class:active={activeTab === item.id}
      data-testid={`tab-${item.id}`}
      on:click={() => selectTopLevelTab(item.id)}
    >
      <svelte:component this={item.icon} size={14} />
      <span>{item.label}</span>
      {#if item.showBadge && item.badgeType === 'pending' && pendingBatchCount > 0}
        <span class="badge pending">{pendingBatchCount}</span>
      {/if}
    </button>
  {/each}
</nav>

<style>
  .hero {
    padding: 16px var(--panel-gutter-x);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--theme-accent, #fbbf24) 5%, transparent), transparent),
      color-mix(in srgb, var(--theme-card-bg, #111113) 98%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 74%, transparent);
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: center;
  }

  .hero-left {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }

  .hero-left.user-mode {
    flex: 1;
  }

  .hero-avatar {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    object-fit: cover;
  }

  .hero-avatar-wrap {
    position: relative;
    width: 48px;
    height: 48px;
    flex: 0 0 auto;
  }

  .hero-avatar.placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    background: #18181b;
    color: #f4f4f5;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .jurisdiction-avatar-badge {
    position: absolute;
    right: -5px;
    bottom: -5px;
    width: 20px;
    height: 20px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 2px solid color-mix(in srgb, var(--theme-card-bg, #111113) 96%, #000 4%);
    font-size: 10px;
    font-weight: 800;
    line-height: 1;
    box-shadow: 0 8px 18px rgba(0, 0, 0, 0.25);
  }

  .jurisdiction-avatar-badge.ethereum,
  .jurisdiction-avatar-badge.sepolia {
    background: #627eea;
  }

  .jurisdiction-avatar-badge.base {
    background: #0052ff;
  }

  .jurisdiction-avatar-badge.tron {
    background: #ff060a;
  }

  .jurisdiction-avatar-badge.local,
  .jurisdiction-avatar-badge.generic {
    background: #71717a;
  }

  .hero-identity {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .hero-identity.user-mode {
    flex: 1;
  }

  .hero-meta-block {
    max-width: min(520px, 100%);
  }

  .hero-context-switcher {
    min-width: 0;
  }

  .hero-name {
    color: var(--theme-text-primary, #f4f4f5);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .hero-right {
    text-align: right;
    flex: 0 0 auto;
  }

  .hero-networth {
    color: var(--theme-text-primary, #f4f4f5);
    font-size: 28px;
    line-height: 1;
    font-weight: 800;
  }

  .hero-label {
    margin-top: 5px;
    color: var(--theme-text-muted, #71717a);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .wallet-meta-block {
    min-width: 0;
  }

  .wallet-label,
  .muted {
    color: #52525b;
    line-height: 1.5;
    margin: 0 0 4px;
    font-size: 11px;
  }

  .wallet-meta-copy {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    color: #e5e7eb;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: pointer;
  }

  .wallet-meta-value {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  .tabs {
    display: flex;
    gap: 6px;
    padding: 6px var(--panel-gutter-x) 0;
    border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 74%, transparent);
    overflow-x: auto;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 38px;
    padding: 8px 12px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 10px 10px 0 0;
    background: transparent;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
  }

  .tab:hover {
    color: var(--theme-text-primary, #e4e4e7);
  }

  .tab.active {
    color: var(--theme-text-primary, #f4f4f5);
    border-color: color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 72%, transparent);
    background: color-mix(in srgb, var(--theme-card-bg, #111113) 100%, transparent);
  }

  .badge {
    padding: 2px 7px;
    border-radius: 999px;
    background: #27272a;
    color: #f4f4f5;
    font-size: 9px;
    line-height: 1.2;
  }

  .badge.pending {
    background: rgba(251, 191, 36, 0.16);
    color: #fde68a;
  }

  @media (max-width: 900px) {
    .hero-right {
      display: none;
    }
  }

  @media (max-width: 760px) {
    .hero {
      padding: 12px var(--panel-gutter-x);
      gap: 10px;
    }

    .hero-left {
      gap: 10px;
      align-items: flex-start;
    }

    .hero-avatar,
    .hero-avatar.placeholder {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      font-size: 12px;
    }

    .hero-identity {
      gap: 5px;
    }

    .hero-context-switcher {
      max-width: 100%;
      width: 100%;
    }

    .hero-name {
      font-size: 14px;
      line-height: 1.15;
      overflow-wrap: anywhere;
    }

    .hero-networth {
      font-size: 24px;
    }

    .hero-label {
      margin-top: 2px;
    }

    .tabs {
      padding: 4px var(--panel-gutter-x) 0;
      gap: 4px;
      flex-wrap: nowrap;
      overflow: visible;
      border-bottom: none;
      box-sizing: border-box;
    }

    .tab {
      flex: 1 1 0;
      justify-content: center;
      min-width: 0;
      min-height: 34px;
      padding: 7px 9px;
      font-size: 9.5px;
      border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 40%, transparent);
      border-radius: 11px;
      background: color-mix(in srgb, var(--theme-surface, var(--theme-card-bg, #18181b)) 66%, transparent);
      box-shadow: none;
    }

    .badge {
      font-size: 8px;
      padding: 2px 5px;
    }
  }

  @media (max-width: 460px) {
    .tab {
      min-height: 32px;
      padding: 6px 8px;
    }

    .hero-networth {
      font-size: 20px;
    }
  }
</style>
