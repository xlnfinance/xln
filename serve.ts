// Simple Bun HTTP server for legacy UI and Svelte UI with SPA fallback
// - Serves legacy files from project root (e.g., /index.html, /dist/server.js)
// - Serves Svelte build under /ui/* from ui/dist
// - SPA fallback: any /ui/* 404 falls back to ui/dist/index.html

const textTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const getContentType = (pathname: string): string | undefined => {
  const idx = pathname.lastIndexOf('.');
  if (idx === -1) return undefined;
  const ext = pathname.slice(idx);
  return textTypes[ext];
};

const serveFile = async (filePath: string): Promise<Response | null> => {
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) return null;
    const ct = getContentType(filePath);
    return new Response(file, ct ? { headers: { 'content-type': ct } } : undefined);
  } catch {
    return null;
  }
};

const uiDistRoot = 'ui/dist';

const handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;

  // Log minimal request info
  console.log(`➡️  ${request.method} ${path}`);

  // Health
  if (path === '/healthz') return new Response('ok');

  // Serve Svelte UI under /ui/* with SPA fallback
  if (path === '/ui' || path.startsWith('/ui/')) {
    const subPath = path === '/ui' ? '/index.html' : path.slice('/ui'.length);
    const candidate = `${uiDistRoot}${subPath}`;

    // Try exact asset first
    const exact = await serveFile(candidate);
    if (exact) return exact;

    // Fallback to index.html for SPA routes
    const fallback = await serveFile(`${uiDistRoot}/index.html`);
    if (fallback) return fallback;

    return new Response('ui not built', { status: 404 });
  }

  // Explicit mapping for runtime bundle
  if (path === '/dist/server.js' || path.startsWith('/dist/')) {
    const file = await serveFile(`.${path}`);
    if (file) return file;
    return new Response('not found', { status: 404 });
  }

  // Legacy index
  if (path === '/' || path === '/index.html') {
    const file = await serveFile('./index.html');
    if (file) return file;
    return new Response('missing index.html', { status: 404 });
  }

  // Try static from project root for any other asset
  const staticFile = await serveFile(`.${path}`);
  if (staticFile) return staticFile;

  return new Response('not found', { status: 404 });
};

const port = Number(process.env.PORT || 8080);
Bun.serve({ port, fetch: handler });
console.log(`🌐 HTTP server listening on http://localhost:${port}`);


