#!/usr/bin/env bun
// Serves the film page on loopback: only the film directory and the repository's own font files.
//
//   bun design/film/tools/serve.mjs            -> http://127.0.0.1:4780  (space plays, arrows scrub)
//
// The page loads ES modules and JSON, so it cannot be opened from file://.

import { existsSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';

export const FILM = resolve(import.meta.dirname, '..');
export const REPO = resolve(FILM, '../..');

const SERVED = ['/design/film/', '/docs/ru/xln-core-manual/fonts/'];
const PAGE = '/design/film/film.html?lang=en';
const PREVIEW_PORT = 4780;

/** @param port 0 picks a free port, for tools that open their own page. */
export const serve = (port = 0) =>
  Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: request => {
      const path = normalize(decodeURIComponent(new URL(request.url).pathname));
      if (path === '/') return Response.redirect(PAGE, 302);
      const file = join(REPO, path);
      if (!SERVED.some(prefix => path.startsWith(prefix)) || !existsSync(file)) return new Response('not found', { status: 404 });
      return new Response(Bun.file(file), { headers: { 'cache-control': 'no-store' } });
    },
  });

if (import.meta.main) {
  const server = serve(PREVIEW_PORT);
  console.log(`film preview: http://127.0.0.1:${server.port}${PAGE}`);
}
