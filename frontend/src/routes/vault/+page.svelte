<script lang="ts">
  // Redirect to /app - vault functionality is integrated there
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { appStateOperations } from '$lib/stores/appStateStore';

  onMount(() => {
    // Ensure user mode (shows wallet UI)
    appStateOperations.setMode('user');
    goto('/app');
  });
</script>

<div class="redirect">Redirecting to app...</div>

<style>
  .redirect {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    color: #666;
    font-family: system-ui;
  }
</style>
