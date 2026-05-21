import { readdir, readFile, writeFile } from 'fs/promises';
import { deserializeTaggedJson, safeStringify } from '../serialization-utils';
import { pushDebugEvent, type RelayStore } from '../relay-store';
import {
  DEBUG_DUMPS_DIR,
  buildDebugDumpFileName,
  ensureDebugDumpDir,
} from '../server-utils';

const readDumpPayload = async (req: Request): Promise<Record<string, unknown>> => {
  const rawBody = await req.text().catch(() => '');
  const parsed = rawBody
    ? deserializeTaggedJson<Record<string, unknown>>(rawBody)
    : null;
  return parsed && typeof parsed === 'object' ? parsed : { rawBody };
};

const readDumpPreview = async (filePath: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
};

export const maybeHandleDebugDumpsRequest = async (input: {
  req: Request;
  pathname: string;
  relayStore: RelayStore;
  headers: HeadersInit;
}): Promise<Response | null> => {
  if (input.pathname !== '/api/debug/dumps') return null;

  if (input.req.method === 'GET') {
    await ensureDebugDumpDir();
    const limit = Math.max(1, Math.min(200, Number(new URL(input.req.url).searchParams.get('last') || '50')));
    const files = (await readdir(DEBUG_DUMPS_DIR).catch(() => []))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .slice(-limit)
      .reverse();
    return new Response(
      safeStringify({
        ok: true,
        dir: DEBUG_DUMPS_DIR,
        files,
      }),
      { headers: input.headers },
    );
  }

  if (input.req.method !== 'POST') return null;

  await ensureDebugDumpDir();
  const payload = await readDumpPayload(input.req);
  const trigger = payload?.['trigger'] && typeof payload['trigger'] === 'object'
    ? payload['trigger'] as Record<string, unknown>
    : undefined;
  const reason = typeof trigger?.['message'] === 'string'
    ? trigger['message']
    : typeof payload?.['reason'] === 'string'
      ? payload['reason']
      : 'debug-dump';
  const runtimeId = typeof payload?.['runtimeState'] === 'object' && payload['runtimeState']
    && typeof (payload['runtimeState'] as Record<string, unknown>)['runtimeId'] === 'string'
    ? String((payload['runtimeState'] as Record<string, unknown>)['runtimeId'])
    : undefined;
  const fileName = buildDebugDumpFileName(reason, runtimeId);
  const filePath = `${DEBUG_DUMPS_DIR}/${fileName}`;
  await writeFile(filePath, safeStringify(payload, 2), 'utf8');

  const preview = await readDumpPreview(filePath);
  pushDebugEvent(input.relayStore, {
    event: 'consensus_dump',
    status: 'stored',
    runtimeId,
    reason: String(reason).slice(0, 240),
    details: {
      file: fileName,
      trigger: trigger ?? null,
      height: typeof payload?.['runtimeState'] === 'object' && payload['runtimeState']
        ? (payload['runtimeState'] as Record<string, unknown>)['height']
        : null,
      persistedLatestHeight: typeof payload?.['persistedWal'] === 'object' && payload['persistedWal']
        ? (payload['persistedWal'] as Record<string, unknown>)['latestHeight']
        : null,
      preview: preview && typeof preview === 'object'
        ? {
            timestamp: (preview as Record<string, unknown>)['timestamp'] ?? null,
            url: (preview as Record<string, unknown>)['url'] ?? null,
          }
        : null,
    },
  });

  return new Response(
    safeStringify({
      ok: true,
      file: fileName,
      path: filePath,
    }),
    { headers: input.headers },
  );
};
