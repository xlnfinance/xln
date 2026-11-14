<script lang="ts">
  import { browser } from '$app/env';
  import { page } from '$app/state';
  import View from '#lib/view/View.svelte';
  import { appState } from '#lib/stores/appStateStore.ts';

  let embedMode = $derived(
    browser && (page.url.searchParams.get('embed') === '1' || page.url.searchParams.has('e'))
  );
</script>

<View
  layout="default"
  networkMode="simnet"
  {embedMode}
  userMode={!embedMode && page.url.searchParams.get('observer') !== '1'}
  requestedPanelId={$appState.requestedDockPanel}
/>
