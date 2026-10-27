import { fetchQaBlobUrl } from '#lib/qa/apiClient.ts';

export function loadProtectedMedia(url: string, publish: (blobUrl: string, error: string) => void): () => void {
  let objectUrl = '';
  let cancelled = false;
  publish('', '');
  if (url.trim())
    void fetchQaBlobUrl(url.trim())
      .then(next => {
        if (cancelled) {
          URL.revokeObjectURL(next);
          return;
        }
        objectUrl = next;
        publish(next, '');
      })
      .catch(error => {
        if (!cancelled) publish('', error instanceof Error ? error.message : String(error));
      });
  return () => {
    cancelled = true;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}
