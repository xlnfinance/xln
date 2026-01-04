<script>
  /**
   * /view - Redirect to /app
   * Kept for backward compatibility (tests, docs, internal links)
   */
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';

  onMount(() => {
    // Preserve query params when redirecting
    const params = new URLSearchParams(window.location.search);
    const target = `/app${params.toString() ? '?' + params.toString() : ''}`;
    goto(target, { replaceState: true });
  });
</script>

<div style="padding: 20px; text-align: center;">
  Redirecting to /app...
</div>
