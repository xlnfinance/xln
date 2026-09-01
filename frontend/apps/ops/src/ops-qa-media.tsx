import { useEffect, useState, type ImgHTMLAttributes, type VideoHTMLAttributes } from 'react';

import { fetchQaBlobUrl } from '../../../packages/browser/src/qa-api-client';

export const useQaBlobUrl = (sourceUrl: string): Readonly<{ blobUrl: string; error: string }> => {
  const [state, setState] = useState<Readonly<{ blobUrl: string; error: string }>>({ blobUrl: '', error: '' });
  useEffect(() => {
    const source = sourceUrl.trim();
    let active = true;
    let objectUrl = '';
    setState({ blobUrl: '', error: '' });
    if (!source) return () => undefined;
    void fetchQaBlobUrl(source).then(url => {
      objectUrl = url;
      if (active) setState({ blobUrl: url, error: '' });
      else URL.revokeObjectURL(url);
    }).catch((error: unknown) => {
      if (active) setState({ blobUrl: '', error: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sourceUrl]);
  return state;
};

export function OpsQaProtectedImage({ sourceUrl, alt, ...props }: Readonly<{
  sourceUrl: string;
  alt: string;
}> & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const media = useQaBlobUrl(sourceUrl);
  if (media.error) return <span className="ops-qa-media-error">Image unavailable</span>;
  if (!media.blobUrl) return <span className="ops-qa-media-empty">Loading evidence…</span>;
  return <img {...props} alt={alt} src={media.blobUrl} />;
}

export function OpsQaProtectedVideo({ sourceUrl, ...props }: Readonly<{
  sourceUrl: string;
}> & Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'>) {
  const media = useQaBlobUrl(sourceUrl);
  if (media.error) return <span className="ops-qa-media-error">Video unavailable</span>;
  if (!media.blobUrl) return <span className="ops-qa-media-empty">Loading recording…</span>;
  return <video {...props} src={media.blobUrl} />;
}
