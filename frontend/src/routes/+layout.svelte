<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import Topbar from '$lib/components/Topbar.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import '$lib/styles/apple-glass.css';
	let { children } = $props();

	// Check for embed mode from URL
	let isEmbed = $derived(browser && new URLSearchParams(window.location.search).get('embed') === '1');

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
		background: #000;
	}

	main.with-topbar {
		/* No padding - topbar is sticky (stays in flow) */
	}
</style>
