<script lang="ts">
	import GlobalLanguageSwitcher from '$lib/components/GlobalLanguageSwitcher.svelte';
	import { showingLandingPage } from '$lib/stores/uiStore';
	let { children } = $props();
</script>

{@render children?.()}
{#if !$showingLandingPage}
	<GlobalLanguageSwitcher />
{/if}
