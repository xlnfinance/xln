<script lang="ts">
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import View from '$lib/view/View.svelte';
  import { appState } from '$lib/stores/appStateStore';

  let embedMode = $derived(
    browser && ($page.url.searchParams.get('embed') === '1' || $page.url.searchParams.has('e'))
  );
</script>

<View
  layout="default"
  networkMode="simnet"
  {embedMode}
  userMode={$appState.mode === 'user'}
/>
