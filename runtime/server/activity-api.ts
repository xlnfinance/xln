import { readPersistedRuntimeActivityPage } from '../runtime';
import { safeStringify } from '../serialization-utils';
import type { Env } from '../types';

const parseCsv = (value: string | null): string[] =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const parseOptionalNumber = (value: string | null): number | undefined => {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const handleRuntimeActivityRequest = async (
  env: Env,
  url: URL,
  headers: HeadersInit,
): Promise<Response> => {
  const entityId = String(url.searchParams.get('entityId') || '').trim().toLowerCase();
  const kind = String(url.searchParams.get('kind') || 'all').trim() as 'all' | 'onchain' | 'offchain';
  if (kind !== 'all' && kind !== 'onchain' && kind !== 'offchain') {
    return new Response(safeStringify({ ok: false, error: 'Invalid kind filter' }), {
      status: 400,
      headers,
    });
  }

  try {
    const page = await readPersistedRuntimeActivityPage(env, {
      ...(entityId ? { entityId } : {}),
      kind,
      types: parseCsv(url.searchParams.get('types')),
      query: String(url.searchParams.get('q') || '').trim(),
      beforeHeight: parseOptionalNumber(url.searchParams.get('beforeHeight')),
      fromTimestamp: parseOptionalNumber(url.searchParams.get('fromTimestamp')),
      toTimestamp: parseOptionalNumber(url.searchParams.get('toTimestamp')),
      limit: parseOptionalNumber(url.searchParams.get('limit')),
      scanLimit: parseOptionalNumber(url.searchParams.get('scanLimit')),
    });
    return new Response(safeStringify(page), { headers });
  } catch (error) {
    return new Response(
      safeStringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers },
    );
  }
};
