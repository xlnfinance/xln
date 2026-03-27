<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import Topbar from '$lib/components/Topbar.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import { installRangeSliderProgress } from '$lib/utils/rangeSliderProgress';
	import { installFatalErrorInterceptor } from '$lib/utils/resetEverything';
	import '$lib/styles/apple-glass.css';
	import '$lib/styles/checkbox-controls.css';
	import '$lib/styles/range-sliders.css';
	let { children } = $props();

	onMount(() => {
		if (!browser) return;
		installFatalErrorInterceptor();
		const disposeRangeSliderProgress = installRangeSliderProgress();
		return () => {
			disposeRangeSliderProgress();
		};
	});

	// Check for embed mode from URL
	let isEmbed = $derived(browser && (() => {
		const params = new URLSearchParams(window.location.search);
		return params.get('embed') === '1' || params.has('e');
	})());

	// Landing page gets transparent topbar
	let isLandingPage = $derived($page.url.pathname === '/');

	type ChromeMode = 'site' | 'app' | 'hidden';

	let chromeMode = $derived.by<ChromeMode>(() => {
		const value = (($page.data as Record<string, unknown> | undefined)?.chrome ?? 'site');
		return value === 'app' || value === 'hidden' ? value : 'site';
	});

	let showTopbar = $derived(!isEmbed && chromeMode === 'site');
</script>

{#if showTopbar}
	<Topbar variant={isLandingPage ? 'transparent' : 'default'} />
{/if}

{#if chromeMode === 'site'}
	<main class:with-topbar={showTopbar}>
		{@render children?.()}
	</main>
{:else}
	{@render children?.()}
{/if}

<Toast />

<style>
	:global(html) {
		background: var(--theme-bg-gradient, var(--theme-background, #000));
		color: var(--theme-text-primary, #e4e4e7);
	}

	:global(body) {
		margin: 0;
		padding: 0;
		background: var(--theme-bg-gradient, var(--theme-background, #000));
		color: var(--theme-text-primary, #e4e4e7);
	}

	main {
		min-height: 100dvh;
		overflow: visible;
		background: var(--theme-bg-gradient, var(--theme-background, #000));
		color: inherit;
	}

	main.with-topbar {
		min-height: calc(100dvh - 56px);
	}

	:global(body.xln-user-mode .account-workspace-tab),
	:global(body.xln-user-mode .configure-tab),
	:global(body.xln-user-mode .settings-tab),
	:global(body.xln-user-mode .appearance-pill),
	:global(body.xln-user-mode .scope-btn),
	:global(body.xln-user-mode .side-tab),
	:global(body.xln-user-mode .type-tab-text),
	:global(body.xln-user-mode .compact-btn),
	:global(body.xln-user-mode .expand-btn),
	:global(body.xln-user-mode .refresh-btn),
	:global(body.xln-user-mode .move-max-chip),
	:global(body.xln-user-mode .summary-action),
	:global(body.xln-user-mode .summary-action-inline),
	:global(body.xln-user-mode .hub-primary),
	:global(body.xln-user-mode .move-primary-cta) {
		border-radius: var(--ui-radius-base, 12px) !important;
		font-size: calc(12px * var(--ui-font-scale, 1)) !important;
	}

	:global(body.xln-user-mode .account-workspace-tab),
	:global(body.xln-user-mode .configure-tab),
	:global(body.xln-user-mode .settings-tab),
	:global(body.xln-user-mode .appearance-pill),
	:global(body.xln-user-mode .scope-btn),
	:global(body.xln-user-mode .side-tab),
	:global(body.xln-user-mode .type-tab-text),
	:global(body.xln-user-mode .compact-btn),
	:global(body.xln-user-mode .expand-btn),
	:global(body.xln-user-mode .refresh-btn) {
		min-height: calc(var(--ui-control-height, 44px) - 6px) !important;
	}

	:global(body.xln-user-mode .section-card),
	:global(body.xln-user-mode .account-preview),
	:global(body.xln-user-mode .configure-panel),
	:global(body.xln-user-mode .workspace-inline-selector),
	:global(body.xln-user-mode .accounts-selector-row),
	:global(body.xln-user-mode .account-appearance-panel),
	:global(body.xln-user-mode .move-visual),
	:global(body.xln-user-mode .move-summary),
	:global(body.xln-user-mode .trade-grid > .section),
	:global(body.xln-user-mode .hub-card),
	:global(body.xln-user-mode .dropdown) {
		border-radius: var(--ui-radius-large, 16px) !important;
	}

	:global(body.xln-user-mode .toolbar-select),
	:global(body.xln-user-mode .move-amount-shell),
	:global(body.xln-user-mode .closed-trigger),
	:global(body.xln-user-mode .entity-input-field),
	:global(body.xln-user-mode input:not([type='range']):not([type='checkbox'])),
	:global(body.xln-user-mode select),
	:global(body.xln-user-mode textarea) {
		border-radius: var(--ui-radius-base, 12px) !important;
		font-size: calc(13px * var(--ui-font-scale, 1)) !important;
	}

	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .account-workspace-tabs),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .configure-tabs),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .settings-tabs),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .appearance-pill-group),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .side-toggle-row),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .order-type-toggle),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .account-workspace-tabs),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .configure-tabs),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .settings-tabs),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .appearance-pill-group),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .side-toggle-row),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .order-type-toggle) {
		padding: 0 0 2px !important;
		gap: 14px !important;
		border: none !important;
		border-bottom: 1px solid color-mix(in srgb, var(--theme-border, #27272a) var(--ui-border-mix, 56%), transparent) !important;
		border-radius: 0 !important;
		background: transparent !important;
	}

	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .account-workspace-tab),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .configure-tab),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .settings-tab),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .appearance-pill),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .side-tab),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .type-tab-text),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .account-workspace-tab),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .configure-tab),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .settings-tab),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .appearance-pill),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .side-tab),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .type-tab-text) {
		min-height: calc(var(--ui-control-height, 44px) - 10px) !important;
		padding: 0 2px 10px !important;
		border: none !important;
		border-radius: 0 !important;
		background: transparent !important;
		box-shadow: none !important;
	}

	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .account-workspace-tab.active),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .configure-tab.active),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .settings-tab.active),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .appearance-pill.active),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .side-tab.active),
	:global(html[data-ui-tabs='minimal'] body.xln-user-mode .type-tab-text.active) {
		color: var(--theme-accent, #fbbf24) !important;
		box-shadow: none !important;
	}

	:global(html[data-ui-tabs='underline'] body.xln-user-mode .account-workspace-tab.active),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .configure-tab.active),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .settings-tab.active),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .appearance-pill.active),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .side-tab.active),
	:global(html[data-ui-tabs='underline'] body.xln-user-mode .type-tab-text.active) {
		box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--theme-accent, #fbbf24) 88%, transparent) !important;
	}

	:global(html[data-ui-tabs='rail'] body.xln-user-mode .account-workspace-tabs),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .configure-tabs),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .settings-tabs),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .appearance-pill-group),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .side-toggle-row),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .order-type-toggle) {
		padding: 4px !important;
		gap: 6px !important;
		border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) var(--ui-border-mix, 52%), transparent) !important;
		border-radius: var(--ui-radius-large, 16px) !important;
		background: color-mix(in srgb, var(--theme-surface, #18181b) 68%, transparent) !important;
	}

	:global(html[data-ui-tabs='rail'] body.xln-user-mode .account-workspace-tab),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .configure-tab),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .settings-tab),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .appearance-pill),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .side-tab),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .type-tab-text) {
		border: 1px solid transparent !important;
		border-radius: calc(var(--ui-radius-base, 12px) - 2px) !important;
		background: transparent !important;
		box-shadow: none !important;
	}

	:global(html[data-ui-tabs='rail'] body.xln-user-mode .account-workspace-tab.active),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .configure-tab.active),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .settings-tab.active),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .appearance-pill.active),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .side-tab.active),
	:global(html[data-ui-tabs='rail'] body.xln-user-mode .type-tab-text.active) {
		border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 12%, transparent) !important;
		background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 96%, transparent) !important;
		box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--theme-accent, #fbbf24) 86%, transparent) !important;
	}

	:global(html[data-ui-tabs='pill'] body.xln-user-mode .account-workspace-tabs),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .configure-tabs),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .settings-tabs),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .appearance-pill-group),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .side-toggle-row),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .order-type-toggle) {
		padding: 0 !important;
		gap: 8px !important;
		border: none !important;
		border-radius: 0 !important;
		background: transparent !important;
	}

	:global(html[data-ui-tabs='pill'] body.xln-user-mode .account-workspace-tab),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .configure-tab),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .settings-tab),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .appearance-pill),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .side-tab),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .type-tab-text) {
		border-radius: var(--ui-radius-pill, 999px) !important;
		border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) var(--ui-border-mix, 56%), transparent) !important;
		background: color-mix(in srgb, var(--theme-surface, #18181b) 70%, transparent) !important;
		box-shadow: none !important;
	}

	:global(html[data-ui-tabs='pill'] body.xln-user-mode .account-workspace-tab.active),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .configure-tab.active),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .settings-tab.active),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .appearance-pill.active),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .side-tab.active),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .type-tab-text.active) {
		border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) var(--ui-accent-border-mix, 22%), transparent) !important;
		background: color-mix(in srgb, var(--theme-accent, #fbbf24) var(--ui-accent-soft-mix, 10%), transparent) !important;
	}

	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .account-workspace-tabs),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .configure-tabs),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .settings-tabs),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .appearance-pill-group),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .side-toggle-row),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .order-type-toggle) {
		padding: 4px !important;
		gap: 4px !important;
		border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) var(--ui-border-mix, 56%), transparent) !important;
		border-radius: var(--ui-radius-large, 16px) !important;
		background: color-mix(in srgb, var(--theme-surface, #18181b) 68%, transparent) !important;
	}

	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .account-workspace-tab),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .configure-tab),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .settings-tab),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .appearance-pill),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .side-tab),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .type-tab-text) {
		flex: 1 1 auto;
		border-radius: calc(var(--ui-radius-base, 12px) - 2px) !important;
	}

	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .account-workspace-tab.active),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .configure-tab.active),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .settings-tab.active),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .appearance-pill.active),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .side-tab.active),
	:global(html[data-ui-tabs='segmented'] body.xln-user-mode .type-tab-text.active) {
		background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 96%, transparent) !important;
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--theme-accent, #fbbf24) var(--ui-accent-border-mix, 22%), transparent) !important;
	}

	:global(html[data-ui-tabs='floating'] body.xln-user-mode .account-workspace-tabs),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .configure-tabs),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .settings-tabs),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .appearance-pill-group),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .side-toggle-row),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .order-type-toggle) {
		padding: 0 !important;
		gap: 8px !important;
		border: none !important;
		border-radius: 0 !important;
		background: transparent !important;
	}

	:global(html[data-ui-tabs='floating'] body.xln-user-mode .account-workspace-tab),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .configure-tab),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .settings-tab),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .appearance-pill),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .side-tab),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .type-tab-text) {
		border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) var(--ui-border-mix, 56%), transparent) !important;
		border-radius: var(--ui-radius-base, 12px) !important;
		background: color-mix(in srgb, var(--theme-surface, #18181b) 70%, transparent) !important;
		box-shadow: 0 10px 22px color-mix(in srgb, var(--theme-background, #09090b) 8%, transparent) !important;
	}

	:global(html[data-ui-tabs='floating'] body.xln-user-mode .account-workspace-tab.active),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .configure-tab.active),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .settings-tab.active),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .appearance-pill.active),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .side-tab.active),
	:global(html[data-ui-tabs='floating'] body.xln-user-mode .type-tab-text.active) {
		border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) var(--ui-accent-border-mix, 20%), transparent) !important;
		background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 92%, transparent) !important;
		box-shadow:
			inset 0 -1px 0 color-mix(in srgb, var(--theme-accent, #fbbf24) 82%, transparent),
			0 14px 30px color-mix(in srgb, var(--theme-background, #09090b) 10%, transparent) !important;
	}

	:global(html[data-ui-buttons='minimal'] body.xln-user-mode .compact-btn),
	:global(html[data-ui-buttons='minimal'] body.xln-user-mode .expand-btn),
	:global(html[data-ui-buttons='minimal'] body.xln-user-mode .refresh-btn),
	:global(html[data-ui-buttons='minimal'] body.xln-user-mode .scope-btn),
	:global(html[data-ui-buttons='minimal'] body.xln-user-mode .summary-action),
	:global(html[data-ui-buttons='minimal'] body.xln-user-mode .summary-action-inline) {
		background: transparent !important;
		box-shadow: none !important;
	}

	:global(html[data-ui-buttons='solid'] body.xln-user-mode .move-primary-cta),
	:global(html[data-ui-buttons='solid'] body.xln-user-mode .primary-btn),
	:global(html[data-ui-buttons='solid'] body.xln-user-mode .hub-primary) {
		background: color-mix(in srgb, var(--theme-accent, #fbbf24) 78%, transparent) !important;
		border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 86%, transparent) !important;
		color: color-mix(in srgb, var(--theme-background, #09090b) 18%, white 82%) !important;
	}

	:global(html[data-ui-cards='flat'] body.xln-user-mode .section-card),
	:global(html[data-ui-cards='flat'] body.xln-user-mode .account-preview),
	:global(html[data-ui-cards='flat'] body.xln-user-mode .configure-panel),
	:global(html[data-ui-cards='flat'] body.xln-user-mode .workspace-inline-selector),
	:global(html[data-ui-cards='flat'] body.xln-user-mode .accounts-selector-row),
	:global(html[data-ui-cards='flat'] body.xln-user-mode .account-appearance-panel),
	:global(html[data-ui-cards='flat'] body.xln-user-mode .move-visual),
	:global(html[data-ui-cards='flat'] body.xln-user-mode .move-summary),
	:global(html[data-ui-cards='flat'] body.xln-user-mode .trade-grid > .section),
	:global(html[data-ui-cards='flat'] body.xln-user-mode .hub-card) {
		background: color-mix(in srgb, var(--theme-surface, #18181b) 58%, transparent) !important;
	}

	:global(html[data-ui-cards='striped'] body.xln-user-mode .section-card),
	:global(html[data-ui-cards='striped'] body.xln-user-mode .account-preview),
	:global(html[data-ui-cards='striped'] body.xln-user-mode .configure-panel),
	:global(html[data-ui-cards='striped'] body.xln-user-mode .workspace-inline-selector),
	:global(html[data-ui-cards='striped'] body.xln-user-mode .move-visual),
	:global(html[data-ui-cards='striped'] body.xln-user-mode .move-summary),
	:global(html[data-ui-cards='striped'] body.xln-user-mode .trade-grid > .section),
	:global(html[data-ui-cards='striped'] body.xln-user-mode .hub-card) {
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--theme-accent, #fbbf24) 4%, transparent), transparent 24%),
			color-mix(in srgb, var(--theme-surface, #18181b) var(--ui-card-fill-mix, 94%), transparent) !important;
	}

	:global(html[data-ui-inputs='minimal'] body.xln-user-mode .toolbar-select),
	:global(html[data-ui-inputs='minimal'] body.xln-user-mode .move-amount-shell),
	:global(html[data-ui-inputs='minimal'] body.xln-user-mode .closed-trigger),
	:global(html[data-ui-inputs='minimal'] body.xln-user-mode .entity-input-field),
	:global(html[data-ui-inputs='minimal'] body.xln-user-mode input:not([type='range']):not([type='checkbox'])),
	:global(html[data-ui-inputs='minimal'] body.xln-user-mode select),
	:global(html[data-ui-inputs='minimal'] body.xln-user-mode textarea) {
		background: color-mix(in srgb, var(--theme-input-bg, #09090b) 58%, transparent) !important;
		border-color: color-mix(in srgb, var(--theme-input-border, rgba(255, 255, 255, 0.12)) 40%, transparent) !important;
	}

	:global(html[data-ui-inputs='filled'] body.xln-user-mode .toolbar-select),
	:global(html[data-ui-inputs='filled'] body.xln-user-mode .move-amount-shell),
	:global(html[data-ui-inputs='filled'] body.xln-user-mode .closed-trigger),
	:global(html[data-ui-inputs='filled'] body.xln-user-mode .entity-input-field),
	:global(html[data-ui-inputs='filled'] body.xln-user-mode input:not([type='range']):not([type='checkbox'])),
	:global(html[data-ui-inputs='filled'] body.xln-user-mode select),
	:global(html[data-ui-inputs='filled'] body.xln-user-mode textarea) {
		background: color-mix(in srgb, var(--theme-input-bg, #09090b) 96%, transparent) !important;
	}

	:global(html[data-ui-shadows='flat'] body.xln-user-mode .section-card),
	:global(html[data-ui-shadows='flat'] body.xln-user-mode .account-preview),
	:global(html[data-ui-shadows='flat'] body.xln-user-mode .configure-panel),
	:global(html[data-ui-shadows='flat'] body.xln-user-mode .workspace-inline-selector),
	:global(html[data-ui-shadows='flat'] body.xln-user-mode .accounts-selector-row),
	:global(html[data-ui-shadows='flat'] body.xln-user-mode .account-appearance-panel),
	:global(html[data-ui-shadows='flat'] body.xln-user-mode .move-visual),
	:global(html[data-ui-shadows='flat'] body.xln-user-mode .move-summary),
	:global(html[data-ui-shadows='flat'] body.xln-user-mode .trade-grid > .section),
	:global(html[data-ui-shadows='flat'] body.xln-user-mode .hub-card) {
		box-shadow: none !important;
	}

	:global(html[data-ui-shadows='float'] body.xln-user-mode .section-card),
	:global(html[data-ui-shadows='float'] body.xln-user-mode .account-preview),
	:global(html[data-ui-shadows='float'] body.xln-user-mode .configure-panel),
	:global(html[data-ui-shadows='float'] body.xln-user-mode .workspace-inline-selector),
	:global(html[data-ui-shadows='float'] body.xln-user-mode .accounts-selector-row),
	:global(html[data-ui-shadows='float'] body.xln-user-mode .account-appearance-panel),
	:global(html[data-ui-shadows='float'] body.xln-user-mode .move-visual),
	:global(html[data-ui-shadows='float'] body.xln-user-mode .move-summary),
	:global(html[data-ui-shadows='float'] body.xln-user-mode .trade-grid > .section),
	:global(html[data-ui-shadows='float'] body.xln-user-mode .hub-card) {
		box-shadow: 0 20px 48px color-mix(in srgb, var(--theme-background, #09090b) 12%, transparent) !important;
	}
</style>
