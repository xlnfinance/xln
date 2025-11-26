<script lang="ts">
	import GlobalLanguageSwitcher from '$lib/components/GlobalLanguageSwitcher.svelte';
	let { children } = $props();
</script>

{@render children?.()}
<GlobalLanguageSwitcher />
