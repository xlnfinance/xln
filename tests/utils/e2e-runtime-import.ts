import type { Page } from '@playwright/test';

type RuntimeImportPayload = {
  importUrl?: unknown;
  manifest?: unknown;
  entries?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const manifestFromPayload = (payload: RuntimeImportPayload): unknown => {
  if (isRecord(payload.manifest)) return payload.manifest;
  if (Array.isArray(payload.entries)) return { entries: payload.entries };
  return null;
};

const hasImportEntries = (manifest: unknown): boolean =>
  isRecord(manifest) && Array.isArray(manifest.entries) && manifest.entries.length > 0;

const localOrchestratorApiBase = (appBaseUrl: string): string | null => {
  const url = new URL(appBaseUrl);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null;
  return 'http://127.0.0.1:8082';
};

export const resolveRuntimeImportAppUrl = async (
  page: Page,
  options: {
    appBaseUrl: string;
    apiBaseUrl: string;
    access?: 'read' | 'admin';
  },
): Promise<string> => {
  const access = options.access ?? 'read';
  const bases = [
    options.appBaseUrl,
    options.apiBaseUrl,
    localOrchestratorApiBase(options.appBaseUrl),
  ].filter((base): base is string => Boolean(base));
  const candidates = Array.from(new Set(bases)).map((base) => {
    const url = new URL('/api/runtime-import', base);
    url.searchParams.set('access', access);
    url.searchParams.set('allowPartial', '1');
    return url.toString();
  });

  const errors: string[] = [];
  for (const candidate of candidates) {
    const response = await page.request.get(candidate, {
      headers: { 'Cache-Control': 'no-store' },
      timeout: 10_000,
    }).catch((error: unknown) => {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (!response) continue;
    const payload = await response.json().catch(() => null) as RuntimeImportPayload | null;
    if (!response.ok() || !payload) {
      errors.push(`${candidate}: status=${response.status()}`);
      continue;
    }

    const importUrl = String(payload.importUrl || '');
    if (importUrl.includes('/app#runtime-import-src=') && !importUrl.includes('/radapter/manage')) {
      return importUrl;
    }

    const manifest = manifestFromPayload(payload);
    if (hasImportEntries(manifest)) {
      const url = new URL('/app', options.appBaseUrl);
      url.hash = `runtime-import=${encodeURIComponent(JSON.stringify(manifest))}`;
      return url.toString();
    }
    errors.push(`${candidate}: runtime import payload missing importUrl/manifest`);
  }

  throw new Error(`RUNTIME_IMPORT_APP_URL_UNAVAILABLE:${errors.join(' | ')}`);
};
