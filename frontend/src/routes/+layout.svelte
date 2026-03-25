<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import Topbar from '$lib/components/Topbar.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import { installRangeSliderProgress } from '$lib/utils/rangeSliderProgress';
	import { installFatalErrorInterceptor } from '$lib/utils/resetEverything';
	import '$lib/styles/apple-glass.css';
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
	:global(body) {
		margin: 0;
		padding: 0;
		background: var(--theme-background, #000);
		color: var(--theme-text-primary, #e4e4e7);
	}

	main.with-topbar {
		/* No padding - topbar is sticky (stays in flow) */
	}
</style>
