<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import Topbar from '$lib/components/Topbar.svelte';
	import '$lib/styles/apple-glass.css';
	let { children } = $props();

	// Check for embed mode from URL
	let isEmbed = $derived(browser && new URLSearchParams(window.location.search).get('embed') === '1');

	// Landing page gets transparent topbar
	let isLandingPage = $derived($page.url.pathname === '/');

	// Show topbar on ALL pages except embed mode
	let showTopbar = $derived(!isEmbed);
</script>

{#if showTopbar}
	<Topbar variant={isLandingPage ? 'transparent' : 'default'} />
{/if}

<main class:with-topbar={showTopbar}>
	{@render children?.()}
</main>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		background: #000;
	}

	main.with-topbar {
		padding-top: 56px; /* Height of topbar */
	}
</style>
