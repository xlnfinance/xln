<script lang="ts">
  import { fetchQaBlobUrl } from '$lib/qa/apiClient';

  type Props = {
    url?: string;
    poster?: string;
    class?: string;
    testId?: string;
  };

  let { url = '', poster = '', class: className = '', testId = 'qa-protected-video' }: Props = $props();
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
  <video
    class={className}
    src={blobUrl}
    poster={poster || undefined}
    preload="metadata"
    controls
    muted
    playsinline
    data-testid={testId}
  ></video>
{:else if error}
  <span class="qa-video-error">{error}</span>
{:else}
  <span class="qa-video-loading">loading video</span>
{/if}

<style>
  .qa-video-error,
  .qa-video-loading {
    display: grid;
    place-items: center;
    min-height: 120px;
    color: #b7b2a4;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    word-break: break-word;
  }

  .qa-video-error {
    color: #ffb2a7;
  }
</style>
