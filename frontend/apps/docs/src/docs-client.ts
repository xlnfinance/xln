import {
  docsCatalogUrl,
  parseDocsCatalogManifest,
  type DocsCatalogEntry,
  type DocsCatalogManifest,
} from '../../../packages/client-core/docs-catalog-contract.js';

const sha256 = async (content: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const responseBody = async (response: Response, label: string): Promise<string> => {
  if (!response.ok) throw new Error(`${label}_REQUEST_FAILED:${response.status}`);
  return response.text();
};

export const loadDocsManifest = async (signal: AbortSignal): Promise<DocsCatalogManifest> => {
  const response = await fetch('/docs-catalog/manifest.json', { cache: 'no-store', signal });
  const text = await responseBody(response, 'DOCS_MANIFEST');
  try {
    return parseDocsCatalogManifest(text);
  } catch (error) {
    throw new Error(`DOCS_MANIFEST_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
};

export const loadDocsDocument = async (
  entry: DocsCatalogEntry,
  signal: AbortSignal,
): Promise<string> => {
  const response = await fetch(docsCatalogUrl(entry.path), { cache: 'no-store', signal });
  const markdown = await responseBody(response, 'DOCS_DOCUMENT');
  const actualSha256 = await sha256(markdown);
  if (actualSha256 !== entry.sha256) {
    throw new Error(`DOCS_DOCUMENT_HASH_MISMATCH:${entry.id}:${entry.sha256}:${actualSha256}`);
  }
  return markdown;
};
