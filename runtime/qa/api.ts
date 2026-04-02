import { safeStringify } from '../serialization-utils';
import { enrichQaRunUrls, listQaRuns, qaArtifactContentType, readQaRun, resolveQaArtifactPath, summarizeQaRun } from './report';

type JsonHeaders = Record<string, string>;

export async function maybeHandleQaRequest(request: Request, pathname: string, headers: JsonHeaders): Promise<Response | null> {
  if (pathname === '/api/qa/runs' && request.method === 'GET') {
    try {
      const url = new URL(request.url);
      const limitRaw = Number(url.searchParams.get('limit') || '20');
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 20;
      const runs = await listQaRuns(limit);
      return new Response(
        safeStringify({
          ok: true,
          runs: runs.map((run) => summarizeQaRun(run)),
        }),
        {
          headers: {
            ...headers,
            'Cache-Control': 'no-store',
          },
        },
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 500, headers });
    }
  }

  if (pathname === '/api/qa/run' && request.method === 'GET') {
    const url = new URL(request.url);
    const runId = String(url.searchParams.get('runId') || '').trim();
    if (!runId) {
      return new Response(safeStringify({ ok: false, error: 'runId is required' }), { status: 400, headers });
    }
    try {
      const run = await readQaRun(runId);
      return new Response(
        safeStringify({
          ok: true,
          run: enrichQaRunUrls(run),
        }),
        {
          headers: {
            ...headers,
            'Cache-Control': 'no-store',
          },
        },
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 404, headers });
    }
  }

  if (pathname === '/api/qa/artifact' && request.method === 'GET') {
    const url = new URL(request.url);
    const runId = String(url.searchParams.get('runId') || '').trim();
    const relativePath = String(url.searchParams.get('path') || '').trim();
    if (!runId || !relativePath) {
      return new Response(safeStringify({ ok: false, error: 'runId and path are required' }), { status: 400, headers });
    }
    try {
      const absolutePath = await resolveQaArtifactPath(runId, relativePath);
      return new Response(Bun.file(absolutePath), {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
          'Content-Type': qaArtifactContentType(absolutePath),
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ ok: false, error: message }), { status: 404, headers });
    }
  }

  return null;
}
