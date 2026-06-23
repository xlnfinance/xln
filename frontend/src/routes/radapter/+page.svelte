<script lang="ts">
  import RuntimeAdapterPanel from '$lib/components/Health/RuntimeAdapterPanel.svelte';
</script>

<svelte:head>
  <title>Runtime Adapter Inspector</title>
</svelte:head>

<RuntimeAdapterPanel fullPage={true} autoConnect={true} />
