<script lang="ts">
  import { fetchQaBlobUrl } from '$lib/qa/apiClient';

  type Props = {
    url?: string;
    alt?: string;
    loading?: 'eager' | 'lazy';
    class?: string;
  };

  let { url = '', alt = '', loading = 'lazy', class: className = '' }: Props = $props();
  let blobUrl = $state('');
  let error = $state('');

  $effect(() => {
    const sourceUrl = String(url || '').trim();
    let objectUrl = '';
    let cancelled = false;
    blobUrl = '';
    error = '';
    if (!sourceUrl) return;
    void fetchQaBlobUrl(sourceUrl)
      .then((nextUrl) => {
        objectUrl = nextUrl;
        if (cancelled) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        blobUrl = nextUrl;
      })
      .catch((err) => {
        if (!cancelled) error = err instanceof Error ? err.message : String(err);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });
</script>

{#if blobUrl}
  <img class={className} src={blobUrl} alt={alt} loading={loading} />
{:else if error}
  <span class="qa-image-error">{error}</span>
{/if}

<style>
  .qa-image-error {
    display: grid;
    place-items: center;
    min-height: 48px;
    color: #ffb2a7;
    font-size: 0.76rem;
    word-break: break-word;
  }
</style>
