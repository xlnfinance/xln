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

	const isAppRoute = $derived($page.url.pathname.startsWith('/app'));

	// Show topbar on ALL pages except embed mode and app workspace
	let showTopbar = $derived(!isEmbed && !isAppRoute);
</script>

{#if showTopbar}
	<Topbar variant={isLandingPage ? 'transparent' : 'default'} />
{/if}

<main class:with-topbar={showTopbar}>
	{@render children?.()}
</main>

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

	:global(html[data-ui-tabs='pill'] body.xln-user-mode .account-workspace-tabs),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .configure-tabs),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .settings-tabs) {
		padding: 4px !important;
		border-bottom: none !important;
		border-radius: var(--ui-radius-large, 16px) !important;
		background: color-mix(in srgb, var(--theme-surface, #18181b) 68%, transparent) !important;
	}

	:global(html[data-ui-tabs='pill'] body.xln-user-mode .account-workspace-tab),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .configure-tab),
	:global(html[data-ui-tabs='pill'] body.xln-user-mode .settings-tab) {
		border-radius: var(--ui-radius-pill, 999px) !important;
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
