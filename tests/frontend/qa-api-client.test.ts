import { afterEach, describe, expect, test } from 'bun:test';

import { clearQaToken, qaFetch } from '../../frontend/src/lib/qa/apiClient';

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  clearQaToken();
  server?.stop(true);
  server = null;
});

describe('qa api client cache', () => {
  test('revalidates QA JSON with ETag and serves cached body on 304', async () => {
    const seenIfNoneMatch: string[] = [];
    let requestCount = 0;
    server = Bun.serve({
      port: 0,
      fetch(request) {
        requestCount += 1;
        seenIfNoneMatch.push(request.headers.get('if-none-match') || '');
        if (request.headers.get('if-none-match') === '"qa-fixture"') {
          return new Response(null, {
            status: 304,
            headers: { etag: '"qa-fixture"' },
          });
        }
        return Response.json(
          { ok: true, runs: [{ runId: 'fixture-run' }] },
          { headers: { etag: '"qa-fixture"' } },
        );
      },
    });

    const url = `${server.url.origin}/api/qa/runs?limit=1`;
    const first = await qaFetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-xln-qa-cache')).toBe('miss');
    expect(await first.json()).toEqual({ ok: true, runs: [{ runId: 'fixture-run' }] });

    const second = await qaFetch(url);
    expect(second.status).toBe(200);
    expect(second.headers.get('x-xln-qa-cache')).toBe('hit');
    expect(await second.json()).toEqual({ ok: true, runs: [{ runId: 'fixture-run' }] });
    expect(requestCount).toBe(2);
    expect(seenIfNoneMatch).toEqual(['', '"qa-fixture"']);
  });
});
